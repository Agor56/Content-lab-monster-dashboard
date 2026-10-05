# Setup: rebuilding the Carousel Engine from scratch

The repo holds all the code. The pieces below live in other services; this is how to connect them again, in order. Today everything runs on Supabase project `kbudvqcnmejuoxyncvtq`; on a new project, swap that id in the three places listed in step 3.

## 1. Zernio (posting, Instagram automations, comment events)

1. Create a Zernio account and a profile.
2. Connect the social accounts inside Zernio:
   - **Instagram** (Business or Creator). Connect through Facebook Login if you want comment likes.
   - **TikTok** through TikTok's Business app (the developer-app connection doesn't expose comments).
   - **YouTube** channel.
3. Create a Zernio API key (Zernio dashboard → API keys). It goes into Supabase in step 3.

Instagram comment → DM automations are stored and run by Zernio. They are created from the dashboard, and they are not in this repo, so a new Zernio account starts with none.

## 2. Claude connectors

In claude.ai → Settings → Connectors, add both. The dashboard calls them **by these exact names**, so keep them:

| Connector name | URL / source | Used for |
|---|---|---|
| `Zernio MCP` | custom connector, `https://mcp.zernio.com/mcp` | posting, uploads, accounts, Instagram automations, video lists |
| `Supabase` | Supabase's official connector, signed in to the account that owns the project | TikTok and YouTube rules, reply logs, Instagram second messages |

If a name changes, update `ZS` and `SB` near the top of the Zernio and TikTok sections in `app/carousel-engine.html`.

## 3. Supabase (auto-replies and the Instagram second message)

1. **Project id.** If this isn't `kbudvqcnmejuoxyncvtq`, replace it in:
   - `app/carousel-engine.html` (`SB_PROJECT`)
   - `supabase/sql/schema.sql` (cron job URL)
   - `supabase/sql/ig_followup_schema.sql` (cron job URL)
2. **Database.** Run `supabase/sql/schema.sql`, then `supabase/sql/ig_followup_schema.sql`, in the SQL editor. Both are re-runnable. They create the tables, lock them down (no anon or authenticated access), generate the webhook and sweep secrets inside the database, and schedule the two every-minute cron jobs. They need the `pgcrypto`, `pg_net` and `pg_cron` extensions, which the scripts enable.
3. **Edge Functions.** Deploy both with **JWT verification off**: they check Zernio's HMAC signature or the in-database sweep key instead.
   - `supabase/functions/tiktok-autoreply` (TikTok and YouTube replies)
   - `supabase/functions/ig-followup` (Instagram second message)
4. **Secret.** Add the Edge Function secret `ZERNIO_API_KEY` with the key from step 1. Both functions use it.
5. **Webhooks.** Nothing to do by hand. Within a minute the cron sweep calls each function, and each registers its own Zernio webhook with the secret from the database:
   - `tiktok-autoreply` → `comment.received`
   - `ig-followup` → `message.received`

   Check: `select id, outcome from tiktok_webhook_events where event = 'setup';` (and the same on `ig_followup_events`).

## 4. The dashboard page

`app/carousel-engine.html` is published as a claude.ai artifact (the platform adds the doctype and head). On a fresh publish, declare these capabilities, or the page can't save, upload or talk to Zernio and Supabase:

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

The first time you open it, Claude asks you to allow Zernio and Supabase for the page.

## 5. Your content (not in git)

Saved in the artifact's own storage on claude.ai, tied to the current artifact. A new artifact starts empty.

| Where | What |
|---|---|
| db collection `sets` | image sets (styles) |
| db collection `media` + asset store | Media Bank images (metadata in `media`, files in the asset store) |
| db collection `carousels` | saved carousels |
| db collection `posts` | calendar entries |
| db docs `settings/main`, `settings/autoreplies`, `settings/ttreplies`, `settings/ytreplies` | handle and default replies (Instagram, TikTok, YouTube) |
| db doc `settings/ttcache` | last loaded TikTok/YouTube rule list, for instant display |

The TikTok and YouTube rules themselves are in Supabase (`tiktok_automations`), so they survive a new artifact.
