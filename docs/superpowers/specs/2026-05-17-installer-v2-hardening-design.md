# Installer v2 hardening — design

**Date:** 2026-05-17
**Status:** Approved (brainstorming) — pending written-spec review
**Builds on:** PR #23 (`claude/automated-installer-setup-aAe09`) — the interactive `setup.py` wizard

## Motivation

An end-to-end acceptance test of the v1 installer (run on a throwaway GitHub
account + throwaway cron-job.org account + a fresh test fork) surfaced five
distinct defects, every one of which blocks the goal of *a non-author forker
(Tim's friends) being able to stand this up themselves*:

1. **Upstash free path is dead via the Vercel Marketplace.** The DB Tim
   created on 2026-05-02 is on a `Free` plan that is grandfathered; the
   current Marketplace new-database flow offers only Pay-As-You-Go / Fixed
   tiers. `instructions.md` documents a "connect (free)" Marketplace click
   that no new user can actually follow.
2. **PAT permission list is incomplete.** The installer rewrites and pushes
   nine `.github/workflows/*.yml` files; a fine-grained PAT cannot push
   workflow changes without **Workflows: Read and write**, which the docs
   omit. GitHub rejects the push with a cryptic message.
3. **Auto-push runs bare `git push`.** It never authenticates with the
   `GITHUB_ACCESS_TOKEN` the installer already holds, so the push fails (or
   silently uses an unrelated cached GitHub identity).
4. **cron-job.org 429s on a fresh account.** Bulk-creating ~13 jobs hits
   rate limits after ~4; only two short retries; the installer reports a hard
   `✗` and leaves the schedule silently incomplete.
5. **Re-run footgun.** The web form forgets all prior input, hard-gates on
   Alpaca, and its Generate buttons mint fresh secrets — silently
   invalidating a working dashboard and locking the user out on any
   legitimate re-run.

This spec covers all five as one "installer v2 hardening" change so the
whole installer is re-validated once rather than per-fix.

## Decisions (locked during brainstorming)

- **Replace the Marketplace path entirely** with Upstash Management-API
  automation. No two-pass re-run, no Marketplace billing click. Dashboard
  works on the first Apply.
- **One spec** covering Upstash automation + the four hardening fixes.
- **Free-tier failure mode = warn + proceed.** Request `plan: "free"`; if
  rejected, fall back to `payg` with a loud cost warning in the log
  (~$0–$1/mo as measured). Never silently select a Fixed paid tier.

## Section 1 — Upstash automation

### New module: `tools/installer/upstash_api.py`

Mirrors `github_api.py` / `discord_api.py` conventions (lazy deps if any,
`dry_run` support, actionable typed errors).

`UpstashProvisioner(email, api_key, *, dry_run=False)`:

- `find_or_create(name, region) -> dict`
  - `GET https://api.upstash.com/v2/redis/databases` (Basic auth:
    `email:api_key`). Reuse the DB whose `database_name == name` →
    **idempotent re-runs** (no duplicate DBs).
  - Else `POST https://api.upstash.com/v2/redis/database` with
    `{database_name, region, plan: "free", tls: true}`.
  - If `plan: "free"` is rejected with a billing/plan 4xx, retry once with
    `plan: "payg"` and emit a `warn`-level log line stating the cost
    (~$0–$1/mo) and that free was unavailable. Never escalate to a Fixed
    tier.
- `kv_env(db) -> dict[str,str]` — maps the create/get response to:
  - `KV_REST_API_URL = https://{endpoint}`
  - `KV_REST_API_TOKEN = {rest_token}`
  - `KV_REST_API_READ_ONLY_TOKEN = {read_only_rest_token}`
  - `KV_URL` / `REDIS_URL = rediss://default:{password}@{endpoint}:{port}`
  - The dashboard's `Redis.fromEnv()` (`dashboard/api/_lib/kv.ts`) needs
    only the first two; the rest are written for parity with the env shape
    Marketplace used to set and are harmless if unused.
- `UpstashError` with actionable text (bad creds → point at Upstash console
  → Account → Management API).

Auth: HTTP Basic, username = Upstash account email, password = Management
API key. Verified against live Upstash docs 2026-05-17; `plan` enum
explicitly includes `free`.

**Defaults (idempotency depends on a stable name):**

- DB name: a deterministic constant derived from the Vercel project, e.g.
  `tradingbot-dashboard-kv`. `find_or_create` matches on this exact
  `database_name`, so re-runs reuse the same DB instead of creating
  duplicates. Not user-configurable in v2 (keeps the form minimal).
- Region: default `us-east-1` (low-traffic single-user dashboard; Redis
  region is not latency-critical here). Not prompted in v2; a constant in
  the module, easy to change later if needed.

### spec.py changes

- Add two `"ask"` entries to `GLOBAL_SECRETS`: `UPSTASH_EMAIL`,
  `UPSTASH_API_KEY` (description points to the Upstash console path).
- The five `KV_*` / `REDIS_URL` keys are **fetched** creds (like Discord
  webhooks) — never asked, never generated.

### Apply flow

Inside `_deploy_dashboard`, **before** the existing `set_env` loop:
provision via `UpstashProvisioner.find_or_create` → merge the five KV keys
into `dash_env` → existing loop pushes them to Vercel → existing deploy.
The Upstash-then-rerun two-pass logic is **deleted**.

One irreducible manual step remains (consistent with installer philosophy:
it cannot create third-party accounts): the user creates an Upstash account
and a Management API key, then pastes email + key into the form — identical
effort to the cron-job.org key already required.

## Section 2 — Auto-push authentication (finding 3)

In `_git_push_fork`, when `GITHUB_ACCESS_TOKEN` is present, authenticate the
push **without persisting the token to `.git/config`**:

- Push via a one-shot `git -c http.<url>.extraheader="AUTHORIZATION: Basic
  <base64(x-access-token:TOKEN)>"` (or an ephemeral
  `https://x-access-token:<token>@github.com/owner/repo` passed as a
  single-use argument, never `remote set-url`).
- Token never lands in `.git/config` (closes the screenshot/credential-leak
  trap hit during the test).
- Degrades exactly as today (prints manual commands) if the token is absent
  or the push still fails.
- The explicit allowlist (`setup_cronjobs.py` + workflows + state files,
  never `.env`) is unchanged — only the auth mechanism changes.

## Section 3 — Re-run footgun (finding 5)

Wire the already-exposed `existing_env_keys` (`webapp.py:98`, currently
unused by the UI) into the form:

- Already-set fields render **"✓ already set — leave blank to keep"**, input
  empty, Generate replaced by an explicit "Regenerate (replaces existing)"
  link. Only the *fact* a key exists is sent to the browser — never values.
- The Alpaca hard-gate lifts when key+secret already exist in `.env`;
  re-entry becomes optional (blank = keep; `write_merged` already preserves
  unspecified keys).
- The Review screen labels each key `unchanged (kept)` vs `will write`.
- True first run is unchanged (nothing set → everything renders normally).
- Pairs with Section 1 idempotency: a re-run reuses the DB and keeps
  secrets — re-running becomes safe and boring.

## Section 4 — PAT Workflows permission (finding 2)

1. **Docs:** `instructions.md` PAT section adds **Workflows: Read and
   write** with a one-line "why" (installer modifies workflow files).
2. **Pre-flight check:** before the push leg, probe whether the token can
   write workflow files (API contents probe + token metadata). If it can't
   be confirmed, emit a `warn` with the exact remedy ("edit fine-grained PAT
   → Repository permissions → Workflows: Read and write → Update token, then
   re-run") instead of letting the user hit the cryptic mid-push rejection.
   Warn, not hard-abort.

## Section 5 — cron-job.org 429 resilience (finding 4)

In/around `setup_cronjobs.py`:

1. **Backoff:** raise retry count; exponential backoff with jitter
   (~2→4→8→16→32s, capped); honor `Retry-After` on 429.
2. **Idempotent resume:** partial runs are safe and cheap to resume (it
   already PATCHes by title); a re-run only creates the still-missing jobs;
   the existing post-deploy re-sync completes the set.
3. **Honest status:** a partial-but-recoverable result is a `warn`
   ("created N of M — rate-limited; re-run Apply to finish"), not `✗`.
   Reserve `✗` for genuine failures (bad key, network down).

## Section 6 — instructions.md rewrite

Remove the Marketplace/two-pass narrative everywhere (≈ lines 40, 55,
147–149, 196–198, 730, 834–845):

- Prereqs: add "Upstash account + Management API key" with the console path;
  drop "Upstash Redis (via Vercel Marketplace): free tier is enough."
- PAT section: add **Workflows: Read and write** (Section 4).
- Flow: delete the two-pass paragraphs; dashboard works on the first Apply.
- One honest cost sentence: installer requests `free`; if Upstash requires a
  card it falls back to PAYG (~$0–$1/mo) with a log warning.
- §9f becomes "the installer does this automatically — no action needed."

## Section 7 — Testing

Existing pattern (`tests/test_installer_*.py`, all network mocked):

- `test_installer_upstash.py` — reuse-vs-create, `free` happy path,
  free-rejected→payg fallback emits cost warning, `kv_env` mapping,
  auth-error text, dry-run makes no calls. `requests` mocked.
- `test_installer_spec.py` / `test_installer_secrets.py` — two new
  `UPSTASH_*` globals; the five KV keys are fetched (not asked/generated).
- `test_installer_fork.py` — token-authenticated push path; assert token
  never written to `.git/config`.
- `test_installer_webapp.py` — `existing_env_keys` drives "already
  set/leave blank"; Alpaca gate lifts when creds pre-exist; review shows
  kept-vs-write.
- cron backoff — retry/backoff math + partial→`warn` classification
  (mocked clock).

## Out of scope / risks

- **Upstash account creation stays manual** — can't automate third-party
  signup; consistent with the installer's stated philosophy.
- `read_only_rest_token` / `REDIS_URL` are written for env-shape parity but
  unused by the dashboard today.
- **Risk:** Upstash could change the `plan` enum or auth scheme. Mitigated
  by the actionable-error convention + PAYG fallback; behavior is pinned to
  fields verified against live docs on 2026-05-17.
- Re-validation: a fresh end-to-end acceptance test (new throwaway accounts)
  is required after implementation; that test execution is out of scope for
  this spec (it's the follow-on validation, not a code change).
