-- Instagram "second message": Supabase schema (project kbudvqcnmejuoxyncvtq).
-- Applied as migration "ig_followup". Re-runnable.
-- People who DM an automation's keyword get the automation's first DM from Zernio as usual;
-- the ig-followup Edge Function then sends one optional second message after a delay.

create extension if not exists pgcrypto;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;


-- One row per Zernio comment automation that has a second message.
create table if not exists public.ig_followups (
  automation_id text primary key,                -- Zernio comment automation id
  message       text not null,
  link          text,
  delay_minutes integer not null default 10,
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),
  constraint ig_followups_message_nonempty check (length(btrim(message)) > 0),
  constraint ig_followups_delay_range check (delay_minutes between 1 and 1380)
);

-- Scheduled and sent second messages. One per person per automation, ever.
create table if not exists public.ig_followup_sends (
  id              uuid primary key default gen_random_uuid(),
  automation_id   text not null,
  conversation_id text not null,                 -- Zernio inbox conversation id
  account_id      text not null,                 -- Zernio Instagram account id
  sender_name     text,
  trigger_at      timestamptz not null,          -- when they DMed the keyword
  send_after      timestamptz not null,
  status          text not null default 'scheduled' check (status in ('scheduled','pending','sent','skipped','failed')),
  error           text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint ig_followup_sends_once unique (automation_id, conversation_id)
);
create index if not exists ig_followup_sends_due on public.ig_followup_sends (status, send_after);

create table if not exists public.ig_followup_events (
  id text primary key, event text, payload jsonb, outcome text,
  received_at timestamptz not null default now()
);

-- webhook_secret and sweep_key are generated in the database; ZERNIO_API_KEY is an Edge Function secret.
create table if not exists public.ig_followup_config (key text primary key, value text not null);
insert into public.ig_followup_config (key, value) values
  ('webhook_secret', encode(gen_random_bytes(32), 'hex')),
  ('sweep_key',      encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

create or replace function public.ig_followups_touch()
returns trigger language plpgsql set search_path to 'public' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists ig_followups_touch on public.ig_followups;
create trigger ig_followups_touch before update on public.ig_followups
  for each row execute function public.ig_followups_touch();

-- Lock down: RLS on, no policies. Only the Edge Function (service role) and the owner's SQL access.
alter table public.ig_followups       enable row level security;
alter table public.ig_followup_sends  enable row level security;
alter table public.ig_followup_events enable row level security;
alter table public.ig_followup_config enable row level security;
revoke all on public.ig_followups, public.ig_followup_sends, public.ig_followup_events, public.ig_followup_config from anon, authenticated;

-- Every-minute sweep: sends due second messages and registers the Zernio webhook once.
select cron.unschedule('ig-followup-sweep') where exists (select 1 from cron.job where jobname = 'ig-followup-sweep');
select cron.schedule('ig-followup-sweep', '* * * * *', $cron$
  select net.http_post(
    url := 'https://kbudvqcnmejuoxyncvtq.supabase.co/functions/v1/ig-followup',
    headers := jsonb_build_object('Content-Type','application/json','X-Sweep-Key',
      (select value from public.ig_followup_config where key='sweep_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$cron$);

-- Also needed (outside SQL):
--   Deploy supabase/functions/ig-followup with JWT verification OFF.
--   It reuses the ZERNIO_API_KEY Edge Function secret already set for tiktok-autoreply.
