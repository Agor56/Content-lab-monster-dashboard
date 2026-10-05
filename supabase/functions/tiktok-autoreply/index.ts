// TikTok comment auto-reply (Supabase Edge Function).
//
// Two entry points on one function:
//   1. Zernio webhook  (header X-Zernio-Signature)  -> reply to one new comment
//   2. Scheduled sweep (header X-Sweep-Key)         -> process backfill requests
//
// Rules live in public.tiktok_automations, every attempt is logged in
// public.tiktok_replies (comment_id is unique, so a comment is never answered twice).
// JWT verification is off on purpose: callers authenticate with the HMAC signature or the sweep key.

import { createClient } from "npm:@supabase/supabase-js@2";

const ZERNIO = "https://zernio.com/api/v1";
const FN_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tiktok-autoreply`;
// Service role: bypasses RLS on the tiktok_* tables, which nobody else can read.
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Settings live in public.tiktok_config (webhook_secret, sweep_key, optional zernio_api_key).
// ZERNIO_API_KEY can also be set as an Edge Function secret, which wins.
let CFG: Record<string, string> | null = null;
async function cfg() {
  if (CFG) return CFG;
  const { data, error } = await db.from("tiktok_config").select("key, value");
  if (error) throw new Error("config: " + error.message);
  CFG = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
  return CFG;
}
async function env(k: string) {
  if (k === "ZERNIO_API_KEY" && Deno.env.get("ZERNIO_API_KEY")) return Deno.env.get("ZERNIO_API_KEY")!;
  const c = await cfg();
  return ({ ZERNIO_API_KEY: c.zernio_api_key, ZERNIO_WEBHOOK_SECRET: c.webhook_secret, SWEEP_KEY: c.sweep_key } as Record<string, string | undefined>)[k] ?? "";
}

type Automation = {
  id: string; account_id: string; video_id: string | null;
  keywords: string[]; replies: string[]; active: boolean;
};
type Candidate = {
  accountId: string; videoId: string; commentId: string; text: string;
  authorId: string | null; authorName: string | null;
  isOwner: boolean; isReply: boolean; alreadyAnswered?: boolean;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------- helpers ----------

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Lowercase, fold width/diacritics variants, drop Hebrew niqqud and invisible marks.
function norm(s: string) {
  return (s || "").normalize("NFKC").toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\u05F4\u201D\u201C"\u05F3'\u2019`]/g, "")
    .replace(/\s+/g, " ").trim();
}
function matchKeyword(text: string, keywords: string[]) {
  const t = norm(text);
  for (const k of keywords) { const nk = norm(k); if (nk && t.includes(nk)) return k; }
  return null;
}
// A rule with no keywords answers any comment. The database only allows that on one specific video.
function matchRule(text: string, a: Automation) {
  if (!a.keywords.length) return a.video_id ? "(any comment)" : null;
  return matchKeyword(text, a.keywords);
}
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function zernio(path: string, init: RequestInit = {}) {
  const res = await fetch(ZERNIO + path, {
    ...init,
    headers: { Authorization: `Bearer ${await env("ZERNIO_API_KEY")}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: any = null; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`Zernio ${res.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function loadAutomations(accountId: string, videoId: string | null): Promise<Automation[]> {
  const { data, error } = await db.from("tiktok_automations").select("*")
    .eq("account_id", accountId).eq("active", true);
  if (error) throw new Error("load automations: " + JSON.stringify(error));
  const rows = (data || []) as Automation[];
  // Video-specific rules win over "any video" rules; on a video, keyword rules win over "any comment".
  const rank = (a: Automation) => (a.video_id ? 0 : 2) + (a.keywords.length ? 0 : 1);
  return rows.filter((a) => a.video_id === null || a.video_id === videoId)
    .sort((a, b) => rank(a) - rank(b));
}

// ---------- core: decide + reply for one comment ----------

async function handleComment(c: Candidate, source: "webhook" | "backfill", rules?: Automation[]) {
  if (c.isReply) return "skip:reply-in-thread";
  if (c.isOwner) return "skip:own-comment";
  if (c.alreadyAnswered) return "skip:already-answered-on-tiktok";

  const automations = rules ?? await loadAutomations(c.accountId, c.videoId);
  let hit: Automation | null = null, kw: string | null = null;
  for (const a of automations) { kw = matchRule(c.text, a); if (kw) { hit = a; break; } }
  if (!hit) return "skip:no-keyword";

  // Same person already got a reply on this video -> log as skipped, don't spam.
  if (c.authorId) {
    const { data: prev } = await db.from("tiktok_replies").select("id")
      .eq("video_id", c.videoId).eq("commenter_id", c.authorId).eq("status", "sent").limit(1);
    if (prev && prev.length) {
      await db.from("tiktok_replies").insert([{
        automation_id: hit.id, account_id: c.accountId, video_id: c.videoId, comment_id: c.commentId,
        commenter_id: c.authorId, commenter_name: c.authorName, comment_text: c.text,
        matched_keyword: kw, status: "skipped", error: "already replied to this person on this video", source,
      }]);
      return "skip:same-person";
    }
  }

  const replyText = pick(hit.replies);
  // Claim the comment first. The unique comment_id makes concurrent deliveries safe.
  const { error: claimErr } = await db.from("tiktok_replies").insert([{
    automation_id: hit.id, account_id: c.accountId, video_id: c.videoId, comment_id: c.commentId,
    commenter_id: c.authorId, commenter_name: c.authorName, comment_text: c.text,
    matched_keyword: kw, reply_text: replyText, status: "pending", source,
  }]);
  if (claimErr) return "skip:already-claimed";

  try {
    const res = await zernio(`/inbox/comments/${encodeURIComponent(c.videoId)}`, {
      method: "POST",
      headers: { "Idempotency-Key": `tt-reply-${c.commentId}` },
      body: JSON.stringify({ accountId: c.accountId, commentId: c.commentId, message: replyText }),
    });
    const replyId = res?.commentId || res?.id || res?.data?.id || res?.comment?.id || null;
    await db.from("tiktok_replies").update({ status: "sent", reply_comment_id: replyId })
      .eq("comment_id", c.commentId);
    return "sent";
  } catch (e) {
    await db.from("tiktok_replies").update({ status: "failed", error: String(e).slice(0, 500) })
      .eq("comment_id", c.commentId);
    return "failed";
  }
}

// ---------- webhook ----------

function candidateFromWebhook(p: any): Candidate | null {
  const cm = p?.comment; if (!cm) return null;
  const author = cm.author || cm.from || {};
  const acc = p.account || {};
  const accountId = acc.id || acc.accountId || cm.accountId || p.accountId;
  const accUser = norm(acc.username || "");
  const authorUser = norm(author.username || author.name || "");
  return {
    accountId,
    videoId: String(cm.platformPostId || cm.postId || ""),
    commentId: String(cm.id),
    text: cm.text ?? cm.message ?? cm.content ?? "",
    authorId: author.id ?? null,
    authorName: author.username || author.name || null,
    isOwner: !!(author.isOwner || cm.isOwner || (accUser && authorUser === accUser)),
    isReply: !!(cm.parentId || cm.parentCommentId || cm.parent?.id || cm.replyTo || cm.isReply),
  };
}

async function onWebhook(raw: string, eventIdHeader: string | null) {
  const p = JSON.parse(raw);
  const eventId = String(p.id || eventIdHeader || crypto.randomUUID());
  const { error: dupErr } = await db.from("tiktok_webhook_events").insert([{ id: eventId, event: p.event, payload: p }]);
  if (dupErr) return json({ ok: true, duplicate: true });

  let outcome = "ignored";
  const platform = p?.comment?.platform || p?.account?.platform;
  if (p.event === "comment.received" && platform === "tiktok") {
    const c = candidateFromWebhook(p);
    try {
      outcome = c && c.accountId && c.videoId ? await handleComment(c, "webhook") : "skip:bad-payload";
    } catch (e) {
      // Release the event so Zernio's retry gets processed instead of deduped.
      await db.from("tiktok_webhook_events").delete().eq("id", eventId);
      throw e;
    }
  }
  await db.from("tiktok_webhook_events").update({ outcome }).eq("id", eventId);
  return json({ ok: true, outcome });
}

// ---------- sweep: backfill requested automations ----------

async function listVideoComments(accountId: string, videoId: string) {
  const out: any[] = []; let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ accountId, limit: "100" }); if (cursor) q.set("cursor", cursor);
    const r = await zernio(`/inbox/comments/${encodeURIComponent(videoId)}?${q}`);
    out.push(...(r?.comments || r?.data || []));
    cursor = r?.pagination?.cursor || r?.pagination?.nextCursor || null;
    if (!r?.pagination?.hasMore || !cursor) break;
  }
  return out;
}
async function listRecentVideos(accountId: string) {
  const q = new URLSearchParams({ accountId, platform: "tiktok", limit: "20" });
  const r = await zernio(`/inbox/comments?${q}`);
  return (r?.data || []).map((v: any) => String(v.id));
}

// Registers this function as a Zernio comment.received webhook once, using the
// secret stored in tiktok_config (nobody has to copy the signing secret by hand).
async function ensureWebhook() {
  const flag = "setup:zernio-webhook";
  const { data: done } = await db.from("tiktok_webhook_events").select("id").eq("id", flag).limit(1);
  if (done && done.length) return "already-registered";
  if (!(await env("ZERNIO_API_KEY"))) return "waiting-for-ZERNIO_API_KEY";
  const url = FN_URL;
  const list = await zernio("/webhooks/settings");
  const existing = (list?.webhooks || []).find((w: any) => w.url === url);
  if (!existing) {
    await zernio("/webhooks/settings", {
      method: "POST",
      body: JSON.stringify({
        name: "tiktok-autoreply", url, events: ["comment.received"],
        secret: await env("ZERNIO_WEBHOOK_SECRET"), isActive: true,
      }),
    });
  }
  await db.from("tiktok_webhook_events").insert([{ id: flag, event: "setup", outcome: existing ? "found" : "created" }]);
  return existing ? "found-existing" : "created";
}

async function onSweep() {
  let webhook: string;
  try { webhook = await ensureWebhook(); } catch (e) { webhook = "error: " + String(e).slice(0, 300); }
  const { data } = await db.from("tiktok_automations").select("*")
    .eq("active", true).not("backfill_requested_at", "is", null);
  const report: Record<string, unknown> = {};
  for (const a of (data || []) as (Automation & { backfill_requested_at: string })[]) {
    const tally: Record<string, number> = {};
    try {
      const videos = a.video_id ? [a.video_id] : await listRecentVideos(a.account_id);
      for (const v of videos) {
        const rules = await loadAutomations(a.account_id, v);
        for (const cm of await listVideoComments(a.account_id, v)) {
          const from = cm.from || cm.author || {};
          const answered = (cm.replies || []).some((r: any) => r?.from?.isOwner);
          const res = await handleComment({
            accountId: a.account_id, videoId: v, commentId: String(cm.id),
            text: cm.message ?? cm.text ?? "", authorId: from.id ?? null,
            authorName: from.username || from.name || null, isOwner: !!from.isOwner,
            isReply: !!cm.parentId, alreadyAnswered: answered,
          }, "backfill", rules);
          tally[res] = (tally[res] || 0) + 1;
          if (res === "sent") await sleep(2500 + Math.random() * 2500); // don't burst
        }
      }
      const summary = Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(", ") || "no comments";
      await db.from("tiktok_automations")
        .update({ backfill_requested_at: null, backfill_done_at: new Date().toISOString(), backfill_result: summary })
        .eq("id", a.id);
      report[a.id] = tally;
    } catch (e) {
      await db.from("tiktok_automations")
        .update({ backfill_requested_at: null, backfill_done_at: new Date().toISOString(), backfill_result: "error: " + String(e).slice(0, 300) })
        .eq("id", a.id);
      report[a.id] = { error: String(e) };
    }
  }
  return json({ ok: true, webhook, report });
}

// ---------- entry ----------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "GET") return json({ ok: true, service: "tiktok-autoreply" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const raw = await req.text();

  const sweepKey = req.headers.get("x-sweep-key");
  if (sweepKey) {
    const sk = await env("SWEEP_KEY");
    if (!sk || !safeEqual(sweepKey, sk)) return json({ error: "unauthorized" }, 401);
    return onSweep();
  }

  const sig = req.headers.get("x-zernio-signature") || req.headers.get("x-late-signature");
  const ws = await env("ZERNIO_WEBHOOK_SECRET");
  if (!sig || !ws) return json({ error: "no signature" }, 401);
  const expected = await hmacHex(ws, raw);
  if (!safeEqual(sig.toLowerCase(), expected)) return json({ error: "bad signature" }, 400);

  try {
    return await onWebhook(raw, req.headers.get("x-zernio-event-id"));
  } catch (e) {
    console.error("webhook failed", e);
    return json({ error: String(e) }, 500); // non-2xx -> Zernio retries
  }
});
