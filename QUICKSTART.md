# Quickstart

The fastest path from nothing to a running bot **+ dashboard** on one paper
account. ~50 min, mostly one-time account signups. For the full reference
(every account, every option, troubleshooting) see
**[instructions.md](instructions.md)**.

The installer (`python setup.py --web`) does all the wiring — `.env` files,
every GitHub Actions secret, all cron jobs, the dashboard deploy, the
fork-URL fixes, state reset, enabling Actions, and committing + pushing its
own rewrites back to your fork. What's left for you is only the things a
script *can't* do: create accounts, paste keys, and make the one
billing-consent click for the dashboard's database.

---

## 1. Install three tools

| Tool | Get it | Verify |
|---|---|---|
| Git | google "git download" | `git --version` |
| Python 3.12 | google "python 3.12 download" — **Windows: tick "Add python.exe to PATH"** | `python --version` |
| Node.js 20 LTS | https://nodejs.org | `node --version` |

## 2. Create the accounts (copy each key into a scratch text file)

1. **GitHub** → sign up, then open the project repo and click **Fork**.
2. **Alpaca** → alpaca.markets → switch to **Paper Trading** → API keys panel
   → **Generate**. Copy the **Key ID** and **Secret** (secret shows once).
3. **Discord** → create a server. For each of `#tsla-trades`,
   `#daily-summary`, `#errors`, `#all-actions`: channel → Edit → Integrations
   → **Webhooks → New → Copy URL**.
4. **cron-job.org** → console.cron-job.org → Settings → API → create a key.
5. **GitHub PAT** → GitHub → Settings → Developer settings →
   **Fine-grained tokens** → scope to **your fork only**, permissions
   **Contents + Actions + Secrets + Administration + Workflows = Read and write**.
   (Administration lets the installer flip on Actions for you; Workflows lets
   it rewrite `.github/workflows/*.yml` and push them back to your fork.)
6. **Upstash** → console.upstash.com → sign up (free) → Account → Management
   API → **Create API Key**. Copy the key. You'll also need the email address
   on the account. The installer uses these to provision the dashboard's Redis
   database automatically.
7. **Vercel** → vercel.com → sign up **with your GitHub account** (Hobby/free).
8. *(Optional, the one paid piece — only enables AI trade grading)*
   **Anthropic** → console.anthropic.com → API keys → create one → add ~$5
   credit. Skip it and the dashboard still works, just without AI grades.

## 3. Get the code

```bash
git clone https://github.com/YOUR_USERNAME/TradingBotTest-Claude.git
cd TradingBotTest-Claude
pip install -r requirements.txt -r tools/installer/requirements.txt
npx vercel login        # one-time, opens browser — log in with GitHub
```

## 4. Run the installer

```bash
python setup.py --web
```

A browser window opens (localhost only, token-gated). Step through the form:

- **Fork** — auto-detected, confirm.
- **Accounts** — tick **Conservative paper** only; leave *Set up the
  dashboard*, *Reset bot memory*, and *Auto-push to fork* checked.
- **Alpaca** — paste Key/Secret, click **Test** (green = good).
- **Discord** — paste the 4 webhook URLs.
- **Tokens** — paste the cron-job.org key, GitHub PAT, Upstash account email,
  and Upstash Management API key; **Generate** the rest.
- **Dashboard secrets** — choose a `DASHBOARD_PASSWORD`; click **Generate**
  for `SESSION_SECRET`, **TOTP** (keep the `otpauth://` link visible), and
  **Backup codes** (shown **once** — write them down); paste the Anthropic
  key if you made one.
- **Review** → **Apply**.

The progress log then does everything automatically and ends with your live
dashboard URL.

## 5. Dashboard Redis (dashboard only)

The dashboard's Redis is provisioned automatically by the installer via the
Upstash API — it works on the first Apply, no second pass and no Vercel
Marketplace step.

*(No-dashboard path: skip step 5 entirely.)*

## 6. Phone authenticator

Install Google Authenticator / Authy, add an entry, and scan or type the
`TOTP_SECRET` / `otpauth://` from step 4. This is your dashboard 2FA.

## Verify it's working

- **Bot:** during market hours (weekday, 9:30 AM–4 PM ET) a run appears
  within ~10 min under your fork's **Actions** tab, plus a heartbeat in
  Discord `#all-actions`. `#errors` staying empty = healthy.
- **Dashboard:** open the URL the installer printed → log in with
  `DASHBOARD_PASSWORD` + the 6-digit code from your authenticator.

---

### Doing more later

Re-run `python setup.py --web` anytime — it **merges**, never clobbers:

- **More accounts** (aggressive / manual / live-real-money /
  sm500-1000-2000): create the extra Alpaca accounts + Discord channels,
  tick them in the form.
- **Skip the dashboard:** untick it in step 4 — then Node, Vercel,
  Anthropic, and steps 5–6 are all unnecessary.

Anything the installer can't reach (a failed git push because git auth isn't
configured, a PAT missing the Administration scope) is never fatal — the
progress log prints the exact one-line command to finish that piece by hand.
