-- TikTok + YouTube comment auto-reply: Supabase schema (project kbudvqcnmejuoxyncvtq).
-- Applied as migrations "tiktok_autoreply" and "move_pg_net_to_extensions".
-- Complete and re-runnable: run it in the Supabase SQL editor to rebuild the backend from scratch.
-- No secrets in this file: the keys below are generated inside the database.

create extension if not exists pgcrypto;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;


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
  -- No keywords = answer any comment, which is only allowed on one specific video.
  constraint tiktok_automations_keywords_nonempty check (cardinality(keywords) > 0 or video_id is not null),
  constraint tiktok_automations_replies_nonempty  check (cardinality(replies) > 0)
);
-- Tables created before "any comment" existed still carry the old keywords rule.
alter table public.tiktok_automations drop constraint if exists tiktok_automations_keywords_nonempty;
alter table public.tiktok_automations add constraint tiktok_automations_keywords_nonempty
  check (cardinality(keywords) > 0 or video_id is not null);

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

-- The same tables serve YouTube too: a rule belongs to one Zernio account, and the
-- platform column tells the app which tab it goes in. Existing rows are TikTok.
alter table public.tiktok_automations add column if not exists platform text not null default 'tiktok';
alter table public.tiktok_replies     add column if not exists platform text not null default 'tiktok';
alter table public.tiktok_automations drop constraint if exists tiktok_automations_platform_check;
alter table public.tiktok_automations add constraint tiktok_automations_platform_check check (platform in ('tiktok','youtube'));
alter table public.tiktok_replies drop constraint if exists tiktok_replies_platform_check;
alter table public.tiktok_replies add constraint tiktok_replies_platform_check check (platform in ('tiktok','youtube'));

create table if not exists public.tiktok_webhook_events (
  id text primary key, event text, payload jsonb, outcome text,
  received_at timestamptz not null default now()
);

-- webhook_secret and sweep_key are generated in the database; ZERNIO_API_KEY is an Edge Function secret.
create table if not exists public.tiktok_config (key text primary key, value text not null);

-- Random secrets, generated in the database (never stored in git).
insert into public.tiktok_config (key, value) values
  ('webhook_secret', encode(gen_random_bytes(32), 'hex')),
  ('sweep_key',      encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- Indexes
create index if not exists tiktok_automations_lookup   on public.tiktok_automations (account_id, active, video_id);
create index if not exists tiktok_replies_by_automation on public.tiktok_replies (automation_id, created_at desc);
create index if not exists tiktok_replies_by_commenter  on public.tiktok_replies (video_id, commenter_id);

-- Keep updated_at current
create or replace function public.tiktok_touch_updated_at()
returns trigger language plpgsql set search_path to 'public' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists tiktok_automations_touch on public.tiktok_automations;
create trigger tiktok_automations_touch before update on public.tiktok_automations
  for each row execute function public.tiktok_touch_updated_at();

-- Keep matched_count / replied_count / last_reply_at current
create or replace function public.tiktok_replies_count()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' and new.automation_id is not null then
    update public.tiktok_automations set matched_count = matched_count + 1 where id = new.automation_id;
  end if;
  if new.automation_id is not null and new.status = 'sent'
     and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    update public.tiktok_automations set replied_count = replied_count + 1, last_reply_at = now() where id = new.automation_id;
  end if;
  return new;
end $$;
drop trigger if exists tiktok_replies_count on public.tiktok_replies;
create trigger tiktok_replies_count after insert or update of status on public.tiktok_replies
  for each row execute function public.tiktok_replies_count();
revoke all on function public.tiktok_replies_count() from public, anon, authenticated;

-- Lock down: RLS on, no policies, no anon/authenticated access. Only the service role
-- (the Edge Function) and the owner's SQL access can read or write these tables.
alter table public.tiktok_automations    enable row level security;
alter table public.tiktok_replies        enable row level security;
alter table public.tiktok_webhook_events enable row level security;
alter table public.tiktok_config         enable row level security;
revoke all on public.tiktok_automations, public.tiktok_replies, public.tiktok_webhook_events, public.tiktok_config from anon, authenticated;

-- Every-minute sweep (backfill + one-time webhook registration), authenticated with the sweep key.
select cron.unschedule('tiktok-autoreply-sweep') where exists (select 1 from cron.job where jobname = 'tiktok-autoreply-sweep');
select cron.schedule('tiktok-autoreply-sweep', '* * * * *', $cron$
  select net.http_post(
    url := 'https://kbudvqcnmejuoxyncvtq.supabase.co/functions/v1/tiktok-autoreply',
    headers := jsonb_build_object('Content-Type','application/json','X-Sweep-Key',
      (select value from public.tiktok_config where key='sweep_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$cron$);

-- Also needed (outside SQL):
--   1. Deploy supabase/functions/tiktok-autoreply with JWT verification OFF.
--   2. Add Edge Function secret ZERNIO_API_KEY in the Supabase dashboard.
--   The function registers its Zernio webhook itself on the first sweep.
