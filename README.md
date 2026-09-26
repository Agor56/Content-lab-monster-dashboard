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
