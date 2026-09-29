// Instagram second message (Supabase Edge Function).
//
// Zernio's comment automations send the first DM on their own. For automations with
// "also answer people who DM the keyword" on and a second message saved in
// public.ig_followups, this function sends one extra DM after a delay:
//   1. Zernio webhook  (header X-Zernio-Signature) -> an incoming Instagram DM matches a
//      keyword -> schedule one row in public.ig_followup_sends. Nothing is sent yet.
//   2. Scheduled sweep (header X-Sweep-Key)        -> send due rows, but only after checking
//      the conversation shows our first DM went out after their keyword message.
// Unique (automation_id, conversation_id) means one second message per person per automation.

import { createClient } from "npm:@supabase/supabase-js@2";

const ZERNIO = "https://zernio.com/api/v1";
const FN_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ig-followup`;
const WINDOW_MS = 23 * 3600_000;       // stay inside Instagram's 24h messaging window
const FIRST_DM_GRACE_MS = 30 * 60_000; // how long to keep waiting for Zernio's first DM
const SKEW_MS = 5_000;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

let CFG: Record<string, string> | null = null;
async function cfg() {
  if (CFG) return CFG;
  const { data, error } = await db.from("ig_followup_config").select("key, value");
  if (error) throw new Error("config: " + error.message);
  CFG = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
  return CFG;
}
async function env(k: "ZERNIO_API_KEY" | "WEBHOOK_SECRET" | "SWEEP_KEY") {
  if (k === "ZERNIO_API_KEY") return Deno.env.get("ZERNIO_API_KEY") || "";
  const c = await cfg();
  return (k === "WEBHOOK_SECRET" ? c.webhook_secret : c.sweep_key) || "";
}

type Followup = { automation_id: string; message: string; link: string | null; delay_minutes: number; active: boolean };
type Automation = {
  id: string; platform: string; trigger: string; accountId: string; keywords: string[];
  matchMode?: string; typoTolerance?: boolean; excludeKeywords?: string[];
  alsoMatchInDms?: boolean; isActive?: boolean; dmDelaySeconds?: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    .replace(/[֑-ׇ]/g, "")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[״”“"׳'’`]/g, "")
    .replace(/\s+/g, " ").trim();
}
const words = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Mirrors Zernio's matchMode rules. Being slightly more lenient is safe: the sweep only sends
// after confirming Zernio's own first DM actually went out.
function kwHit(text: string, k: string, mode: string, typo: boolean) {
  const nk = norm(k); if (!nk) return false;
  if (mode === "exact") return words(text).join(" ") === words(k).join(" ");
  if (mode === "word") {
    const t = words(text), kw = words(k);
    if (!kw.length) return false;
    if (kw.length === 1) {
      const w = kw[0], tol = !typo || w.length < 4 ? 0 : w.length <= 7 ? 1 : 2;
      return t.some((x) => x === w || (tol > 0 && editDistance(x, w, tol) <= tol));
    }
    for (let i = 0; i + kw.length <= t.length; i++) if (kw.every((w, j) => t[i + j] === w)) return true;
    return false;
  }
  return norm(text).includes(nk); // "contains" (Zernio's default)
}
function automationMatches(a: Automation, text: string) {
  const mode = a.matchMode || "contains", typo = !!a.typoTolerance;
  if ((a.excludeKeywords || []).some((k) => kwHit(text, k, mode, typo))) return false;
  return (a.keywords || []).some((k) => kwHit(text, k, mode, typo));
}
const withLink = (msg: string, link: string | null) => {
  const t = (msg || "").trim(), u = (link || "").trim();
  return !u || t.includes(u) ? t : `${t}\n${u}`;
};

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

async function activeFollowups(): Promise<Followup[]> {
  const { data, error } = await db.from("ig_followups").select("*").eq("active", true);
  if (error) throw new Error("load followups: " + error.message);
  return (data || []) as Followup[];
}
async function automationsById(): Promise<Map<string, Automation>> {
  const r = await zernio("/comment-automations");
  const list: any[] = r?.automations || r?.data || [];
  return new Map(list.map((a) => [String(a.id || a._id), { ...a, id: String(a.id || a._id) } as Automation]));
}
const eligible = (a: Automation | undefined, accountId?: string) =>
  !!a && a.platform === "instagram" && a.trigger !== "story_reply" && a.isActive !== false && !!a.alsoMatchInDms &&
  (!accountId || a.accountId === accountId);

// ---------- webhook: schedule ----------

async function onWebhook(raw: string, eventIdHeader: string | null) {
  const p = JSON.parse(raw);
  const eventId = String(p.id || eventIdHeader || crypto.randomUUID());
  const m = p.message || {};
  const conversationId = String(m.conversationId || p.conversation?.id || "");
  const accountId = String(p.account?.accountId || p.account?.id || m.accountId || "");
  const { error: dupErr } = await db.from("ig_followup_events").insert([{ id: eventId, event: p.event, payload: { conversationId, accountId } }]);
  if (dupErr) return json({ ok: true, duplicate: true });

  let outcome = "ignored";
  try {
    if (p.event !== "message.received" || m.platform !== "instagram" || m.direction !== "incoming") outcome = "skip:not-instagram-incoming";
    else if (!conversationId || !accountId) outcome = "skip:bad-payload";
    else {
      const fus = await activeFollowups();
      if (!fus.length) outcome = "skip:no-followups";
      else {
        const autos = await automationsById();
        const text = String(m.text ?? "");
        const triggerAt = new Date(m.createdAt || m.timestamp || p.createdAt || Date.now());
        const hits: string[] = [];
        for (const fu of fus) {
          const a = autos.get(fu.automation_id);
          if (!eligible(a, accountId) || !automationMatches(a!, text)) continue;
          const wait = fu.delay_minutes * 60_000 + Math.max(0, a!.dmDelaySeconds || 0) * 1000;
          const { error } = await db.from("ig_followup_sends").upsert([{
            automation_id: fu.automation_id, conversation_id: conversationId, account_id: accountId,
            sender_name: m.sender?.username || m.sender?.name || null,
            trigger_at: triggerAt.toISOString(), send_after: new Date(triggerAt.getTime() + wait).toISOString(),
          }], { onConflict: "automation_id,conversation_id", ignoreDuplicates: true });
          if (error) throw new Error("schedule: " + error.message);
          hits.push(fu.automation_id);
        }
        outcome = hits.length ? "scheduled:" + hits.join(",") : "skip:no-keyword";
      }
    }
  } catch (e) {
    // Release the event so Zernio's retry gets processed instead of deduped.
    await db.from("ig_followup_events").delete().eq("id", eventId);
    throw e;
  }
  await db.from("ig_followup_events").update({ outcome }).eq("id", eventId);
  return json({ ok: true, outcome });
}

// ---------- sweep: send ----------

async function ensureWebhook() {
  const flag = "setup:zernio-webhook";
  const { data: done } = await db.from("ig_followup_events").select("id").eq("id", flag).limit(1);
  if (done && done.length) return "already-registered";
  if (!(await env("ZERNIO_API_KEY"))) return "waiting-for-ZERNIO_API_KEY";
  const list = await zernio("/webhooks/settings");
  const existing = (list?.webhooks || []).find((w: any) => w.url === FN_URL);
  if (!existing) {
    await zernio("/webhooks/settings", {
      method: "POST",
      body: JSON.stringify({ name: "ig-followup", url: FN_URL, events: ["message.received"], secret: await env("WEBHOOK_SECRET"), isActive: true }),
    });
  }
  await db.from("ig_followup_events").insert([{ id: flag, event: "setup", outcome: existing ? "found" : "created" }]);
  return existing ? "found-existing" : "created";
}

async function firstDmWentOut(accountId: string, conversationId: string, since: number) {
  const q = new URLSearchParams({ accountId, sortOrder: "desc", limit: "20" });
  const r = await zernio(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${q}`);
  return (r?.messages || []).some((x: any) => x.direction === "outgoing" && new Date(x.createdAt).getTime() >= since - SKEW_MS);
}

async function finish(id: string, status: string, error: string | null = null) {
  await db.from("ig_followup_sends").update({ status, error, ...(status === "sent" ? { sent_at: new Date().toISOString() } : {}) }).eq("id", id);
  return status;
}

async function sendOne(row: any, fus: Map<string, Followup>, autos: Map<string, Automation> | null) {
  const trig = new Date(row.trigger_at).getTime();
  if (Date.now() - trig > WINDOW_MS) return finish(row.id, "skipped", "outside Instagram's 24h window");
  const fu = fus.get(row.automation_id);
  if (!fu) return finish(row.id, "skipped", "second message turned off");
  if (autos && !eligible(autos.get(row.automation_id), row.account_id)) return finish(row.id, "skipped", "automation paused, deleted or no longer answers DMs");
  if (!(await firstDmWentOut(row.account_id, row.conversation_id, trig))) {
    if (Date.now() - trig < FIRST_DM_GRACE_MS) {
      await db.from("ig_followup_sends").update({ status: "scheduled", send_after: new Date(Date.now() + 60_000).toISOString() }).eq("id", row.id);
      return "waiting-for-first-dm";
    }
    return finish(row.id, "skipped", "first DM never went out");
  }
  try {
    await zernio(`/inbox/conversations/${encodeURIComponent(row.conversation_id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ accountId: row.account_id, message: withLink(fu.message, fu.link) }),
    });
    return finish(row.id, "sent");
  } catch (e) {
    return finish(row.id, "failed", String(e).slice(0, 500));
  }
}

async function onSweep() {
  let webhook: string;
  try { webhook = await ensureWebhook(); } catch (e) { webhook = "error: " + String(e).slice(0, 300); }
  const { data: due, error } = await db.from("ig_followup_sends").select("id")
    .eq("status", "scheduled").lte("send_after", new Date().toISOString()).order("send_after").limit(25);
  if (error) return json({ ok: false, webhook, error: error.message }, 500);
  if (!due || !due.length) return json({ ok: true, webhook, sent: 0 });

  const fus = new Map((await activeFollowups()).map((f) => [f.automation_id, f]));
  let autos: Map<string, Automation> | null = null;
  try { autos = await automationsById(); } catch { autos = null; } // if Zernio's list is down, still send; the first-DM check still guards
  const tally: Record<string, number> = {};
  for (const d of due) {
    // Claim the row, so an overlapping sweep can't send it twice.
    const { data: claimed } = await db.from("ig_followup_sends").update({ status: "pending" })
      .eq("id", d.id).eq("status", "scheduled").select("*");
    if (!claimed || !claimed.length) continue;
    let res: string;
    try { res = await sendOne(claimed[0], fus, autos); }
    catch (e) { res = await finish(d.id, "failed", String(e).slice(0, 500)); }
    tally[res] = (tally[res] || 0) + 1;
    await sleep(400);
  }
  return json({ ok: true, webhook, tally });
}

// ---------- entry ----------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "GET") return json({ ok: true, service: "ig-followup" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const raw = await req.text();

  const sweepKey = req.headers.get("x-sweep-key");
  if (sweepKey) {
    const sk = await env("SWEEP_KEY");
    if (!sk || !safeEqual(sweepKey, sk)) return json({ error: "unauthorized" }, 401);
    return onSweep();
  }

  const sig = req.headers.get("x-zernio-signature") || req.headers.get("x-late-signature");
  const ws = await env("WEBHOOK_SECRET");
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
