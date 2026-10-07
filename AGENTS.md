# Carousel Engine: notes for coding agents

Anton's content dashboard. One HTML app (published as a claude.ai artifact) plus two Supabase Edge Functions, all talking to social accounts through Zernio. `README.md` has the overview; `SETUP.md` is the start-to-finish rebuild.

## Pick the task first

- **Changing something on the live system** (most common): edit the repo, then follow "Deploying a change" below. Don't rerun the whole setup.
- **Rebuilding from zero** (new Zernio, Supabase project or artifact): follow `SETUP.md` top to bottom, in order, and run each step's check before the next.

## Map

| Path | What | Runs where |
|---|---|---|
| `app/carousel-engine.html` | the whole dashboard: carousel studio, Media Bank, video composer, calendar, analytics, comment automations | claude.ai artifact `https://claude.ai/artifact/LNtLJQX7FFe4PWaANW3iZS` |
| `supabase/functions/tiktok-autoreply/index.ts` | public replies to TikTok and YouTube comments | Supabase Edge Function, project `kbudvqcnmejuoxyncvtq` |
| `supabase/functions/ig-followup/index.ts` | optional second Instagram DM | Supabase Edge Function, same project |
| `supabase/sql/schema.sql` | tables, lock-down, secrets, cron for `tiktok-autoreply` | same project |
| `supabase/sql/ig_followup_schema.sql` | same for `ig-followup` | same project |
| `scripts/set-project-ref.sh` | repoints the repo at another Supabase project | local |

Instagram comment → DM automations are not here: Zernio stores and runs them; the app manages them through the Zernio connector.

## Tools you need

- **Supabase:** the Supabase MCP connector (`execute_sql`, `apply_migration`, `deploy_edge_function`, `get_edge_function`, logs), or the Supabase CLI plus `psql`. Setting the `ZERNIO_API_KEY` secret needs the CLI or the owner in the dashboard.
- **Zernio:** the Zernio MCP connector, to check accounts, comments and webhooks.
- **Publishing the app:** Claude's Artifact tool (claude.ai or Claude Code). Without it you can edit the file but must hand publishing to the owner.

## Deploying a change

1. **Database change:** append it to the right file in `supabase/sql/` and keep the file re-runnable (`if not exists`, drop-then-add constraints). Apply only the new statements as a migration. **Apply it before deploying any function that depends on it.** A function writing a column that doesn't exist yet fails every reply, and the failure shows up only as `skip:already-claimed`.
2. **Edge Function:** fetch the deployed source first (`get_edge_function`) and compare with the repo, since someone may have deployed from elsewhere. Then deploy with `verify_jwt: false` (CLI: `--no-verify-jwt`). Check: a GET on the function URL returns `{"ok":true,...}`, and the next cron call in `net._http_response` is 200.
3. **App:** read the live artifact first and merge, then publish to the same URL without passing capabilities (they carry over). Before publishing, syntax-check the inline script: extract the last `<script>` block and run `node --check`.
4. Commit and push to `main`.

## Traps

- **Names are wired together.** Function names appear in the cron job URLs and the Zernio webhook URLs; the connector names `Zernio MCP` and `Supabase` are hard-coded in the app (`ZS`, `SB`). Rename one and something silently stops.
- **`tiktok_*` tables hold YouTube too.** The `platform` column (`tiktok` or `youtube`) on `tiktok_automations` and `tiktok_replies` says which. Rows without it are TikTok. Don't rename the tables; the live app and function both use these names.
- **Own-comment detection on YouTube** goes by handle, because YouTube events carry no owner flag: the comment author `@handle` versus the account `handle`, ignoring the leading `@`. Without it, the function replies to the owner's own comments.
- **YouTube comments arrive late.** Zernio picks them up minutes after they're posted, and on connecting a channel it may deliver older comments. Replies are not instant, unlike TikTok.
- **Secrets stay out of git.** `ZERNIO_API_KEY` is an Edge Function secret. Webhook secrets and sweep keys are generated in the database (`tiktok_config`, `ig_followup_config`), and the functions register their own webhooks. Never print or commit any of them.
- **The app file has no doctype.** The artifact platform wraps it; it starts at `<title>`.
- **Zernio tool calls** from the app go through `call_tool` with Zernio API tool names (for example `posts_create_post`, `comment_automations_create_comment_automation`), and answers come back as Python-style dict strings (`pyParse` in the app).
- **YouTube posting** sends `title`, `visibility`, `categoryId`, `madeForKids`, `containsSyntheticMedia` and `firstComment` in `platformSpecificData`. YouTube rejects `<` and `>` in titles and descriptions. Vertical videos up to 3 minutes become Shorts automatically. YouTube can't take image carousels.
- **Analytics needs Zernio's Analytics add-on.** The Analytics view reads `analytics_get_analytics_dashboard` (period totals, previous period, followers, per-day series) and `analytics_get_analytics` (posts published in the period, up to 3 pages of 100). It computes its own engagement per view (likes + comments + shares + saves ÷ views): Zernio's `engagementRate` divides by views on some platforms and by reach on others. Daily values use received attribution, so days when Zernio synced show bursts.
- **The Supabase project holds unrelated tables** (VoxOps leads, clients, agents…). Touch only the `tiktok_*` and `ig_followup*` objects.

## Useful checks

```sql
-- what the reply function did lately
select received_at, payload->'comment'->>'platform' as platform, outcome
from public.tiktok_webhook_events order by received_at desc limit 20;
-- replies sent
select platform, status, comment_text, reply_text, error from public.tiktok_replies order by created_at desc limit 20;
-- cron calls into the functions
select created, status_code, left(content, 120) from net._http_response order by created desc limit 6;
```
