-- TikTok comment auto-reply: Supabase schema (project kbudvqcnmejuoxyncvtq).
-- Applied as migrations "tiktok_autoreply" and "move_pg_net_to_extensions".

create table if not exists public.tiktok_automations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null default 'Untitled automation',
  account_id    text not null,                 -- Zernio TikTok account id
  video_id      text,                          -- TikTok video id; null = any video
  video_caption text,
  video_cover   text,
  keywords      text[] not null default '{}',
  replies       text[] not null default '{}',  -- one picked at random per reply
  active        boolean not null default true,
  matched_count integer not null default 0,
  replied_count integer not null default 0,
  last_reply_at timestamptz,
  backfill_requested_at timestamptz,           -- set by the app; the sweep replies to past comments
  backfill_done_at      timestamptz,
  backfill_result       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tiktok_automations_keywords_nonempty check (cardinality(keywords) > 0),
  constraint tiktok_automations_replies_nonempty  check (cardinality(replies) > 0)
);

create table if not exists public.tiktok_replies (
  id               uuid primary key default gen_random_uuid(),
  automation_id    uuid references public.tiktok_automations(id) on delete set null,
  account_id       text not null,
  video_id         text not null,
  comment_id       text not null unique,       -- one reply per comment, ever
  commenter_id     text,
  commenter_name   text,
  comment_text     text,
  matched_keyword  text,
  reply_text       text,
  reply_comment_id text,
  status           text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  error            text,
  source           text not null default 'webhook' check (source in ('webhook','backfill')),
  created_at       timestamptz not null default now()
);

create table if not exists public.tiktok_webhook_events (
  id text primary key, event text, payload jsonb, outcome text,
  received_at timestamptz not null default now()
);

-- webhook_secret and sweep_key are generated in the database; ZERNIO_API_KEY is an Edge Function secret.
create table if not exists public.tiktok_config (key text primary key, value text not null);

-- Triggers keep matched_count / replied_count / last_reply_at current. RLS is on with no
-- policies and anon/authenticated are revoked, so only the service role (the function) and
-- the owner's SQL access can read these tables.

-- Every-minute sweep (pg_cron + pg_net), authenticated with the sweep key from tiktok_config:
-- select cron.schedule('tiktok-autoreply-sweep', '* * * * *', $$select net.http_post(
--   url := 'https://kbudvqcnmejuoxyncvtq.supabase.co/functions/v1/tiktok-autoreply',
--   headers := jsonb_build_object('Content-Type','application/json','X-Sweep-Key',
--     (select value from public.tiktok_config where key='sweep_key')),
--   body := '{}'::jsonb, timeout_milliseconds := 55000);$$);
