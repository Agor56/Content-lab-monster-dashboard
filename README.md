# TikTok comment auto-reply

Someone comments a keyword on a TikTok video, they get a public reply within seconds. Runs 24/7, costs no Claude usage.

## How it works

TikTok comment → Zernio `comment.received` webhook → Supabase Edge Function `tiktok-autoreply` → reply posted through Zernio → logged in `tiktok_replies`.

- **Rules** are managed in the Carousel Engine: Comment automations → TikTok. The app reads and writes them through the Supabase connector.
- **Backfill:** "reply to past comments" sets `backfill_requested_at`; a pg_cron job calls the function every minute and replies to matching existing comments.
- **Safety:** one reply per comment (unique `comment_id`), one per person per video, never your own comments or thread replies, 2.5–5 s between backfill replies.

## Where things live

- Supabase project `kbudvqcnmejuoxyncvtq`: tables `tiktok_automations`, `tiktok_replies`, `tiktok_webhook_events`, `tiktok_config`; Edge Function `tiktok-autoreply` (JWT verification off, HMAC-signed webhook instead); Edge Function secret `ZERNIO_API_KEY`; cron job `tiktok-autoreply-sweep`.
- Zernio webhook `tiktok-autoreply` → `https://kbudvqcnmejuoxyncvtq.supabase.co/functions/v1/tiktok-autoreply`.

## Files

- `supabase/functions/tiktok-autoreply/index.ts`: the Edge Function source.
- `supabase/sql/schema.sql`: the full backend setup (tables, indexes, triggers, lock-down, secrets generated in-DB, cron job). Re-runnable.
- `app/carousel-engine.html`: the app page as published (the platform adds the doctype/head wrapper).

## Limits

TikTok doesn't allow automated DMs from non-business accounts. On a Business account only replies to user-started DMs are possible.

# Instagram second message

An Instagram automation can send one extra DM a few minutes after the first one, to people who **DM the keyword**. Zernio still sends the first DM exactly as before; this is a separate side path, so if it fails the first DM and public replies are unaffected.

## How it works

Instagram DM → Zernio `message.received` webhook → Edge Function `ig-followup` → if the text matches an automation that has "Also answer people who DM the keyword" on and a second message saved, one row is scheduled in `ig_followup_sends` → the `ig-followup-sweep` pg_cron job (every minute) sends due rows through Zernio.

- **Settings** are managed in the Carousel Engine: Comment automations → Instagram → Edit → "Send a second message". Saved in `ig_followups`, keyed by the Zernio automation id.
- **Safety:** one second message per person per automation (unique `automation_id, conversation_id`). Before sending, the sweep checks the conversation shows an outgoing message after their keyword DM (Zernio's first DM went out); it waits up to 30 minutes for it, then skips. Nothing is sent more than 23 hours after their DM (Instagram's 24-hour window). Paused, deleted or story-reply automations are skipped.
- **Commenters** don't get the second message: Instagram allows only one private message per comment until the person writes back.

## Where things live

- Supabase project `kbudvqcnmejuoxyncvtq`: tables `ig_followups`, `ig_followup_sends`, `ig_followup_events`, `ig_followup_config`; Edge Function `ig-followup` (JWT verification off, HMAC-signed webhook instead); reuses the `ZERNIO_API_KEY` secret; cron job `ig-followup-sweep`.
- Zernio webhook `ig-followup` (`message.received`) → `https://kbudvqcnmejuoxyncvtq.supabase.co/functions/v1/ig-followup`. The function registers it itself on its first sweep.

## Files

- `supabase/functions/ig-followup/index.ts`: the Edge Function source.
- `supabase/sql/ig_followup_schema.sql`: tables, lock-down, secrets generated in-DB, cron job. Re-runnable.
