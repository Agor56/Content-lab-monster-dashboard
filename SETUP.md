# Setup: rebuilding the Carousel Engine from scratch

The repo holds all the code. Everything else lives in Zernio, Supabase and claude.ai, and this file is how to connect it again, start to finish, in order. Each step ends with a check; don't move on until it passes.

**What you need from the owner:** a Zernio account, a Supabase project (ref and database password, or the Supabase connector signed in), and a claude.ai account with connectors. Secrets (the Zernio API key, the database password) are never committed; ask for them and put them only where each step says.

The live system today: Supabase project `kbudvqcnmejuoxyncvtq`, dashboard at `https://claude.ai/artifact/LNtLJQX7FFe4PWaANW3iZS`. To change code on the live system rather than rebuild it, see "Deploying a change" in `AGENTS.md`.

## 1. Zernio (posting, Instagram automations, comment events)

1. Create a Zernio account and a profile at zernio.com.
2. Connect the social accounts inside Zernio:
   - **Instagram** (Business or Creator). Connect through Facebook Login if you want comment likes.
   - **TikTok** through TikTok's Business app. Developer-app TikTok connections don't expose comments, so auto-replies would see nothing.
   - **YouTube** channel.
3. Create a Zernio API key in the Zernio dashboard. It goes into Supabase in step 3.

**Check:** the Zernio connector's `accounts_list` (step 2) shows one `instagram`, one `tiktok` and one `youtube` account.

Instagram comment → DM automations are stored and run by Zernio. They are created from the dashboard and are not in this repo, so a new Zernio account starts with none.

## 2. Claude connectors

In claude.ai → Settings → Connectors, add both. The dashboard calls them **by these exact names**:

| Connector name | Source | Used for |
|---|---|---|
| `Zernio MCP` | custom connector, URL `https://mcp.zernio.com/mcp`, sign in with the Zernio account | posting, uploads, accounts, Instagram automations, video lists |
| `Supabase` | Supabase's official connector, signed in to the account that owns the project | TikTok and YouTube rules, reply logs, Instagram second messages |

If a name has to change, update `ZS` (Zernio section) and `SB` (TikTok + YouTube section) in `app/carousel-engine.html`.

**Check:** in a Claude session, both connectors list their tools.

## 3. Supabase (auto-replies and the Instagram second message)

### 3a. Point the repo at the project

Skip this if the project is `kbudvqcnmejuoxyncvtq`. Otherwise run:

```bash
./scripts/set-project-ref.sh <new-project-ref>
```

It rewrites the three hard-coded places: `SB_PROJECT` in the app and the cron job URL in each SQL file. Commit the result.

### 3b. Database

Run `supabase/sql/schema.sql` first, then `supabase/sql/ig_followup_schema.sql`. Both are re-runnable. They enable `pgcrypto`, `pg_net` and `pg_cron`, create and lock down the tables (no anon or authenticated access), generate the webhook and sweep secrets inside the database, and schedule the two every-minute cron jobs.

- **With the Supabase connector (MCP):** `apply_migration` with each file's full contents, names `autoreply_schema` and `ig_followup_schema`.
- **With the command line:** get the connection string from Supabase → Project Settings → Database, then
  ```bash
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/sql/schema.sql
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/sql/ig_followup_schema.sql
  ```

**Check:**
```sql
select jobname from cron.job where jobname in ('tiktok-autoreply-sweep', 'ig-followup-sweep');  -- 2 rows
select key from public.tiktok_config;       -- webhook_secret, sweep_key
select key from public.ig_followup_config;  -- webhook_secret, sweep_key
```

### 3c. Edge Functions

Deploy both, with **JWT verification off**. They authenticate callers themselves: Zernio's HMAC signature for webhooks, the in-database sweep key for the cron job. Keep the names; the cron jobs and webhooks call these exact URLs.

- **MCP:** `deploy_edge_function` with `name` `tiktok-autoreply` (file `supabase/functions/tiktok-autoreply/index.ts` as `index.ts`), `verify_jwt: false`; same for `ig-followup`.
- **Command line** (Supabase CLI; run `supabase init` once if it asks for a config, and don't commit what it generates unless needed):
  ```bash
  supabase login
  supabase functions deploy tiktok-autoreply --no-verify-jwt --project-ref <ref>
  supabase functions deploy ig-followup --no-verify-jwt --project-ref <ref>
  ```

**Check:** `curl https://<ref>.supabase.co/functions/v1/tiktok-autoreply` returns `{"ok":true,"service":"tiktok-autoreply"}`, and the same for `ig-followup`.

### 3d. Secret

Set the Edge Function secret `ZERNIO_API_KEY` to the key from step 1. Both functions read it.

- **Dashboard:** Supabase → Edge Functions → Secrets. The MCP connector can't set secrets, so ask the owner to do this one by hand.
- **Command line:** `supabase secrets set ZERNIO_API_KEY=<key> --project-ref <ref>`

### 3e. Webhooks (automatic)

Nothing to do by hand. Within a minute the cron sweep calls each function, and each registers its own Zernio webhook, signed with the secret from its config table:

- `tiktok-autoreply` → event `comment.received` (TikTok and YouTube comments)
- `ig-followup` → event `message.received` (Instagram DMs)

**Check:**
```sql
select id, outcome from public.tiktok_webhook_events where event = 'setup';  -- created or found
select id, outcome from public.ig_followup_events where event = 'setup';
select status_code, left(content, 120) from net._http_response order by created desc limit 4;  -- 200s
```
If a setup row says `waiting-for-ZERNIO_API_KEY`, the secret from 3d is missing. To force a re-registration (for example after rotating the key), delete the `setup:zernio-webhook` row from that function's events table.

## 4. The dashboard page

`app/carousel-engine.html` is published as a claude.ai artifact; the platform adds the doctype and head, so the file starts at `<title>`. Publishing needs Claude (claude.ai or Claude Code with the Artifact tool); other IDEs can edit the file but not publish it.

- **Updating the live dashboard:** publish to the existing URL (`https://claude.ai/artifact/LNtLJQX7FFe4PWaANW3iZS`). Read the live version first and merge, since it may have newer edits than the repo. Leave capabilities as they are.
- **New dashboard:** publish as a new artifact with these capabilities, or it can't save, upload, or reach Zernio and Supabase:

```json
{
  "db": {},
  "assets": {},
  "downloads": {},
  "sample": {},
  "mcp": {
    "servers": [
      { "server": "Zernio MCP", "tools": ["accounts_list", "media_generate_upload_link", "media_check_upload_status", "call_tool"] },
      { "server": "Supabase", "tools": ["execute_sql"] }
    ]
  }
}
```

The first time it opens, Claude asks to allow Zernio and Supabase for the page.

**Check:** Accounts (sidebar, bottom) shows Instagram, TikTok and YouTube as connected; Comment automations → TikTok and → YouTube load without errors.

## 5. End-to-end test

1. In the dashboard, Comment automations → YouTube → New automation: any video, a test keyword, one reply. Repeat on TikTok.
2. From a different account, comment the keyword on one of your videos.
3. Within seconds (TikTok) or a few minutes (YouTube), the reply appears. "Who got a reply" on the rule shows it, as does:
   ```sql
   select platform, status, comment_text, reply_text, error from public.tiktok_replies order by created_at desc limit 5;
   ```
4. Delete or pause the test rules.

## 6. Your content (not in git)

Saved in the artifact's own storage on claude.ai, tied to that artifact. A new artifact starts empty, and git doesn't back any of this up.

| Where | What |
|---|---|
| db collection `sets` | image sets (styles) |
| db collection `media` + asset store | Media Bank images (metadata in `media`, files in the asset store) |
| db collection `carousels` | saved carousels |
| db collection `posts` | calendar entries |
| db docs `settings/main`, `settings/autoreplies`, `settings/ttreplies`, `settings/ytreplies` | handle and default replies (Instagram, TikTok, YouTube) |
| db doc `settings/ttcache` | last loaded TikTok/YouTube rule list, for instant display |
| db doc `settings/ancache` | last loaded Analytics numbers (30 days, all platforms), for instant display |

The TikTok and YouTube rules themselves are in Supabase (`tiktok_automations`), so they survive a new artifact. The Instagram automations are in Zernio.
