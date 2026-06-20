# Setting Up This Trading Bot For Your Own Accounts

This is a complete, from-scratch guide for running this bot system on **your own**
Alpaca, Discord, GitHub, cron-job.org, and Vercel accounts. Nothing here depends on
the original author's accounts — every credential, URL, and ID below is one you
create yourself.

The bot runs an automated options "wheel" strategy plus a trailing-stop/ladder
stock strategy and (optionally) a congressional-trade copier, all on a schedule,
with notifications to Discord and an optional web dashboard.

---

## ⚠️ Read this before anything else

- **This is not financial advice and is not a turnkey money machine.** It is a
  personal experiment. You are responsible for every trade it places.
- **Start on paper. Stay on paper for a long time.** Alpaca paper accounts use
  fake money. The setup below puts you on paper by default. Do **not** wire up the
  real-money "live" account until you have watched the paper accounts run for
  weeks and you fully understand every strategy in
  [`CLAUDE.md`](CLAUDE.md).
- **The live account trades real money with no human in the loop.** There is a
  dedicated, heavily-flagged section for it near the end. Treat it like a loaded
  tool.
- Options can lose money quickly. Cash-secured puts can tie up large amounts of
  buying power. Read the "Strategies in detail" section of
  [`CLAUDE.md`](CLAUDE.md) so you know exactly what each script does.

---

## What you'll end up with

| Piece | What it does | Required? |
|---|---|---|
| Forked GitHub repo | Hosts the code + runs the bots on GitHub Actions | Required |
| 1 Alpaca **paper** account | The bot trades fake money here | Required |
| Discord server + webhooks | Trade/error/summary notifications | Required |
| cron-job.org account | Triggers the GitHub Actions on schedule | Required |
| Vercel + Upstash + Anthropic | The monitoring dashboard | Optional (this guide covers it) |
| More Alpaca paper accounts | Aggressive / manual / small-account variants | Optional, add later |
| Alpaca **live** account | Real money. Last. Carefully. | Strongly optional |

**Recommended path:** get **one conservative paper account** working end-to-end
first (Steps 1–7). Only then add more accounts (Step 8), the dashboard (Step 9),
and — much later, if ever — the live account (Step 10).

---

## Cost summary

- GitHub, Alpaca paper, Discord: **free**
- cron-job.org: **free** tier is enough
- Vercel: **free** Hobby plan (the dashboard is built to stay under the 12-function limit)
- Upstash Redis: provisioned automatically by the installer (free plan requested; if your Upstash account requires a card it falls back to pay-as-you-go, ~$0–$1/mo for this dashboard)
- Anthropic API (dashboard AI grading only): **paid**, usage-based — this is the
  AI that grades your closed trades and surfaces tendencies. The cost driver is
  *trade volume*, not time: the grader only calls the model when a trade closes,
  plus one small weekly "tendencies" pass, and it uses prompt caching to keep
  each call cheap. For typical personal volume (a few trades closing per week)
  expect **well under $1/month**; even heavy active trading rarely exceeds
  **~$3–5/month**. Skip this entirely if you don't deploy the dashboard.

---

## Prerequisites on your computer

You need four free things installed: a **terminal**, **Git**, **Python 3.12**,
and (only for the dashboard) **Node.js**. If you've never used a terminal, that's
fine — follow this section literally, top to bottom. After each install, **close
and reopen your terminal** so it picks up the new program, then run the "verify"
command. If the verify command prints a version number, that tool is ready.

### 0. Open a terminal

- **Windows:** press the Start button, type `PowerShell`, click **Windows
  PowerShell**. (A blue window with a `PS C:\>` prompt.)
- **macOS:** press `Cmd+Space`, type `Terminal`, press Enter.
- **Linux:** `Ctrl+Alt+T`, or search "Terminal" in your apps.

You'll type commands here. "Run X" below means: type it, press Enter.

### 1. Git (downloads the code, required)

- **Windows:** download the installer from https://git-scm.com/download/win and
  run it. Click **Next** through every screen — the defaults are fine.
- **macOS:** download from https://git-scm.com/download/mac and run the
  installer, **or** run `xcode-select --install` and click "Install".
- **Linux (Debian/Ubuntu):** run `sudo apt update && sudo apt install -y git`.

  Verify (reopen terminal first): `git --version` → should print e.g.
  `git version 2.45.0`.

### 2. Python 3.12 (runs the bots, required)

- **Windows:** go to https://www.python.org/downloads/ , download **Python
  3.12.x**, run the installer, and **on the first screen check the box that says
  "Add python.exe to PATH"** before clicking Install. (Skipping that box is the
  #1 setup mistake.)
- **macOS:** download the 3.12 installer from https://www.python.org/downloads/
  and run it.
- **Linux (Debian/Ubuntu):** run
  `sudo apt update && sudo apt install -y python3.12 python3-pip`.

  Verify (reopen terminal first): `python --version` → should print
  `Python 3.12.x`. If Windows says "Python was not found", you missed the PATH
  checkbox — re-run the installer and tick it. (On macOS/Linux you may need to
  type `python3` instead of `python`.)

### 3. Node.js 20+ and npm (dashboard only — skip if you're not deploying it)

`npm` is bundled with Node, so installing Node gives you both.

- **Windows / macOS:** download the **LTS** installer from https://nodejs.org ,
  run it, click through the defaults.
- **Linux (Debian/Ubuntu):**
  `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`.

  Verify (reopen terminal first): `node --version` (e.g. `v20.x.x`) and
  `npm --version` (e.g. `10.x.x`).

### 4. A GitHub account

Sign up at https://github.com if you don't have one. (Free.)

---

# The fast path: `python setup.py`

Most of the steps below are "make an account, copy a value, paste it
somewhere." An **interactive wizard** does the paste-and-wire parts for you.
It **cannot** create the third-party accounts — signups have CAPTCHAs, email
verification, and (for the live brokerage) legal agreements — so you still do
those by hand. But once you have your keys, the wizard does the rest.

**What you still do by hand (the irreducible part):**

1. Fork + clone the repo (Step 1 below). *(State-file reset is now done for
   you by the installer — no manual `echo "{}"` step.)*
2. Create the accounts you want and copy their keys into a scratch text file:
   Alpaca paper account(s) (Step 2), a Discord server (Step 3), a GitHub
   fine-grained PAT with **Contents + Actions + Secrets + Administration +
   Workflows = Read and write** (Step 6a — Administration lets the installer
   flip on Actions for you; Workflows is required because the installer
   rewrites and pushes `.github/workflows/*.yml`; without Administration that
   stays a one-click manual step), a cron-job.org API key (Step 6b), and —
   only if you want the dashboard — Vercel + an Anthropic API key (Step 9a) +
   an **Upstash account with a Management API key** (console.upstash.com →
   Account → Management API; the installer uses this to create/reuse a free
   Redis DB automatically — no Vercel Marketplace click required).
3. Run `python setup.py --web` (or `python setup.py`) and Apply. The
   dashboard's Redis is provisioned automatically by the installer via the
   Upstash API — it works on the first Apply, no second pass.

That's the entire manual surface. The installer now also **commits & pushes
its own rewrites to your fork** (an explicit allowlist — `setup_cronjobs.py`,
the workflow YAMLs, the reset state files; never `.env` or anything that
could leak a secret) and **enables Actions on the fork**. If git auth/identity
isn't set up it doesn't fail — it prints the two exact commands to finish by
hand.

**What the wizard then does for you:**

```bash
pip install -r requirements.txt
pip install -r tools/installer/requirements.txt   # pynacl, for the secrets push
python setup.py --web      # guided installer in your browser (recommended)
# or:  python setup.py     # the same flow as a terminal wizard
```

`--web` opens a local, single-page installer in your browser (localhost only,
token-gated, nothing is served outside this machine) — step-by-step fields,
a "Test" button per Alpaca account, one-click secret generation, a masked
review, and a live progress log. `python setup.py` (no flag) runs the
identical flow in the terminal instead. Both share the same engine:

it detects your fork from `git remote`, asks which of the seven accounts to
configure, collects each account's keys (and offers to test them live),
**auto-creates the Discord channels + webhooks** (if you give it a Discord bot
token) or takes pasted webhook URLs, **generates** every secret it safely can
(session/cron/push tokens, the TOTP secret, backup codes), writes both `.env`
files (merging — it never clobbers existing values), **resets inherited bot
memory** (blanks `strategy_state*/wheel_state*.json` so your fork starts
clean), **fixes both fork gotchas** automatically, **bulk-pushes all GitHub
Actions secrets**, **enables Actions on the fork** (if the PAT has
Administration scope; otherwise it logs the one-click fallback), runs
`tools/setup_cronjobs.py`, optionally **deploys the Vercel dashboard** and sets
its env vars, **commits & pushes its rewrites back to your fork** (safe
explicit allowlist — never `.env`), and finishes with a health check.

```bash
python setup.py --dry-run    # walk it without changing anything external
python setup.py --check      # just health-check an existing .env
python setup.py --fix-urls   # re-point workflows at your Vercel URL after deploy
```

> The dashboard's URL only exists *after* its first deploy. The **`--web`**
> installer handles this for you — it re-points the workflows and re-syncs the
> cron jobs to the new URL automatically in the same run (no `--fix-urls`
> needed). The dashboard's Redis is provisioned automatically by the installer
> via the Upstash API — it works on the first Apply, no second pass.
> (The terminal `python setup.py` flow still uses `python setup.py --fix-urls`
> for the URL re-point.)

> The live real-money account is deliberately gated: the wizard warns hard and
> defaults to **off**. Read Step 10 before ever enabling it.

The numbered steps below remain the **authoritative reference** — they explain
what each piece is and are the fallback if you'd rather wire something by hand
or the wizard can't reach a service. You can also run the wizard first and use
the steps only to understand or troubleshoot what it did.

---

# Step 1 — Fork and clone the repo

1. On GitHub, open the original repository and click **Fork** (top right). This
   creates `https://github.com/YOUR_USERNAME/TradingBotTest-Claude` under your
   account.
2. Clone **your fork** locally:

   ```bash
   git clone https://github.com/YOUR_USERNAME/TradingBotTest-Claude.git
   cd TradingBotTest-Claude
   ```

3. **Decide where your trading data lives — this is a privacy decision.**

   This bot persists its "memory" in `*_state.json` files (open contracts,
   strikes, entry premiums, share quantities, average cost, realized P&L, and a
   running trade history) and **commits them back to the repo on every run**. On
   a **public** repo that means *anyone on the internet can read your open
   positions and your profit/loss* — both the current files and the full git
   history.

   > **⚠️ Strongly recommended: make your fork private.** GitHub → your fork →
   > **Settings** → **General** → bottom → **Change repository visibility** →
   > **Private**. Everything in this guide works identically on a private repo,
   > and your positions stay yours. Only keep it public if you genuinely don't
   > mind strangers seeing every trade you make.

4. **Reset the committed state files** so your fork doesn't start with the
   original author's positions:

   ```bash
   # From the repo root — gives every state file an empty object
   for f in strategy_state*.json wheel_state*.json; do echo "{}" > "$f"; done
   ```

   (On Windows PowerShell:
   `Get-ChildItem strategy_state*.json,wheel_state*.json | ForEach-Object { '{}' | Set-Content $_ }`)

   Commit and push that:

   ```bash
   git add strategy_state*.json wheel_state*.json
   git commit -m "reset state files for my own fork"
   git push
   ```

   > The bots rebuild state from your real Alpaca positions over the next few
   > cycles, so empty files are the correct starting point.

---

# Step 2 — Create an Alpaca paper account and get API keys

Alpaca is the brokerage the bot places trades through. "Paper" means a practice
account with fake money — no real money is ever at risk in this step.

**First, prepare a safe place to paste secrets.** Open a plain text file (Windows:
Notepad; Mac: TextEdit in plain-text mode; or any notes app) and keep it open.
You'll paste several keys into it as you go. Do **not** put this file inside the
project folder, and never share it or commit it anywhere.

1. Go to **https://alpaca.markets** and click **Sign Up**. Enter your email and a
   password, submit, then open the verification email Alpaca sends and click the
   link to confirm your account. Log in.
2. After login you land on the Alpaca dashboard. Look in the **top-left corner**
   for a toggle/dropdown that switches between **Live Trading** and **Paper
   Trading**. Click it and select **Paper Trading**. The page should now say
   "Paper" somewhere visible. **Confirm this before generating keys** — keys
   generated in Live mode are real-money keys.
3. On the paper dashboard **Home** page, find the **API Keys** box (usually on
   the right side). Click **Generate New Key** (or "View"/"Regenerate" if a key
   already exists). A popup shows two values:
   - **Key ID** — a short code that starts with `PK` (paper keys start `PK`;
     real-money keys start `AK` — if yours starts `AK` you are not in paper mode,
     stop and redo step 2).
   - **Secret Key** — a longer code. **This is shown only once.** Copy *both*
     values into your text file right now, labeled "CONSERVATIVE PAPER". If you
     lose the secret you must regenerate (which invalidates the old one).
4. Also write down the paper base URL exactly as:
   `https://paper-api.alpaca.markets/v2`

You now have the three values for your first ("conservative") account: the Key
ID, the Secret Key, and the base URL.

> **Want multiple paper accounts later?** Alpaca only allows up to 3 paper
> accounts per login by default. For the aggressive / manual / small-account
> variants you create **additional Alpaca logins** using the Gmail "+" trick —
> if your email is `you@gmail.com`, signing up with `you+agg@gmail.com` and
> `you+sm@gmail.com` are treated as separate Alpaca accounts but all the
> verification emails still arrive in your one real `you@gmail.com` inbox.
> Generate paper keys on each. Do this only when you reach Step 8.

---

# Step 3 — Create a Discord server and webhooks

The bot has **no screen or app of its own** — Discord is how it tells you what
it did. Discord is a free chat app. A "server" is your private space; a
"channel" is a chat room inside it; a "webhook" is a special URL that lets a
program post messages into one channel.

1. **Get Discord.** Go to **https://discord.com**, create a free account
   (or log in). You can use it in the web browser — no download required.
2. **Create a server.** On the far left, click the large **`+`** button →
   **Create My Own** → **For me and my friends** → give it any name (e.g.
   "Trading Bot") → **Create**.
3. **Create four channels.** In the channel list on the left, hover over the
   word **TEXT CHANNELS** and click the small **`+`** that appears. For each one:
   type the name, leave it as a Text channel, click **Create Channel**. Make
   these four (type the name *without* the `#` — Discord adds it):
   - `trades`
   - `daily-summary`
   - `errors`
   - `all-actions`
4. **Make a webhook for each channel.** For one channel at a time:
   - Hover the channel name → click the **gear icon** (⚙ "Edit Channel").
   - In the left menu of that settings page click **Integrations**.
   - Click **Webhooks** → **New Webhook**. A webhook is created automatically.
   - Click it, then click **Copy Webhook URL**.
   - Paste that URL into your text file, labeled with the channel name. It looks
     like `https://discord.com/api/webhooks/123456.../abcXYZ...`.
   - Click **Save Changes**, go **Back**, and repeat for the next channel.
5. You should now have **four webhook URLs** saved. Each channel maps to one
   setting name you'll use in Step 4:

   | Channel | Setting name (env var) |
   |---|---|
   | `#trades` | `DISCORD_TSLA_WEBHOOK` |
   | `#daily-summary` | `DISCORD_SUMMARY_WEBHOOK` |
   | `#errors` | `DISCORD_ERRORS_WEBHOOK` |
   | `#all-actions` | `DISCORD_ACTIONS_WEBHOOK` |

> Treat a webhook URL like a password — anyone who has it can post into that
> channel. Don't share them or commit them anywhere.

> The full multi-account channel layout (aggressive/manual/live/sm*) is in
> [`CLAUDE.md`](CLAUDE.md) under "Discord channels". You only need the four above
> for the minimal start.

---

# Step 4 — Local `.env` and a first test run

A `.env` file is just a plain text file holding your private settings as
`NAME=value`, one per line. The bot reads it to know your keys. It is
**gitignored**, meaning Git is configured to never upload it — your secrets stay
on your computer.

1. **Make sure your terminal is "in" the project folder.** In the terminal,
   type `cd ` (with a space) then drag the project folder onto the terminal
   window and press Enter — or type the path manually. Confirm with:
   - Windows: `dir` → you should see `strategy.py`, `wheel_strategy.py`, etc.
   - Mac/Linux: `ls` → same files should be listed.

2. **Create the `.env` file from the example:**
   - Mac/Linux: `cp .env.example .env`
   - Windows PowerShell: `Copy-Item .env.example .env`

3. **Open `.env` in a text editor.** Right-click it in your file explorer →
   "Open with" → Notepad (Windows) / TextEdit (Mac), or any code editor. Fill in
   **only the conservative block** with the values from your text file. Format
   rules: no spaces around the `=`, no quotes, the whole value on one line.

   ```
   ALPACA_API_KEY=PK...your paper key id...
   ALPACA_API_SECRET=...your paper secret...
   ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2

   DISCORD_TSLA_WEBHOOK=https://discord.com/api/webhooks/...
   DISCORD_SUMMARY_WEBHOOK=https://discord.com/api/webhooks/...
   DISCORD_ERRORS_WEBHOOK=https://discord.com/api/webhooks/...
   DISCORD_ACTIONS_WEBHOOK=https://discord.com/api/webhooks/...
   ```

   Leave every other line as its placeholder for now. **Save the file** (make
   sure it's named exactly `.env`, not `.env.txt` — in Notepad choose "Save as
   type: All Files" if needed).

4. **Install the bot's Python libraries.** In the terminal, in the project
   folder, run these one at a time (the bot needs the first two; the third adds
   the testing tools):

   ```bash
   pip install -r requirements.txt
   pip install -r requirements-dev.txt
   ```

   > If `pip` isn't found, try `python -m pip install -r requirements.txt`
   > instead (and `python3` instead of `python` on Mac/Linux if needed).

5. **Run the test suite.** This uses fake data — it does not touch Alpaca or
   Discord, so it's safe any time:

   ```bash
   python -m pytest tests/ -q
   ```

   You want to see a line ending in **`passed`** with no failures. If tests
   pass, the code is intact on your machine.

6. **Do one real cycle** against your *paper* account. Run this **during US
   stock-market hours**: Monday–Friday, 9:30 AM–4:00 PM US Eastern Time. (Not
   sure what that is locally? Search "time in New York" — that's Eastern. If
   it's a weekday between 9:30 AM and 4:00 PM there, the market is open.)

   ```bash
   python strategy.py once
   python wheel_strategy.py once
   python long_options_strategy.py once
   ```

   What to check:
   - **Discord:** you should see new messages in `#trades` or `#all-actions`,
     and **nothing** in `#errors`.
   - **Alpaca:** open your paper dashboard in the browser — a new order should
     appear under Orders/Positions. The wheel may sell a cash-secured put on a
     symbol from the conservative list (TSLA, BAC, XOM, KO, PLTR, SOFI, PFE, F,
     T, INTC) if the account has enough buying power.

   > If you run it **outside** market hours, the wheel logs a "heartbeat" and
   > places no orders — that's normal, not a failure. Run during market hours to
   > actually see a trade.

If Discord lit up and Alpaca shows the order, the bot works on your computer.
Next we make it run automatically in the cloud so your computer doesn't have to
be on.

---

# Step 5 — Add GitHub Actions secrets

"GitHub Actions" is GitHub's free service that runs your bot on a schedule in
the cloud, so your own computer can be off. It cannot read your local `.env`
file, so you must give GitHub the same values as encrypted **secrets**. A secret
is a value GitHub stores encrypted and hands to the bot only while it runs;
nobody (not even you) can read it back afterward.

**Use the website (easiest — no extra tools):**

1. In your browser open **your fork** on GitHub
   (`https://github.com/YOUR_USERNAME/TradingBotTest-Claude`).
2. Click **Settings** (top menu of the repo, not your account settings).
3. In the left sidebar: **Secrets and variables** → **Actions**.
4. Click the green **New repository secret** button.
5. In **Name** type the setting name exactly (e.g. `ALPACA_API_KEY`). In
   **Secret** paste the value (no quotes, no spaces). Click **Add secret**.
6. Repeat **New repository secret** for every one of these, using the values
   from your text file:

   - `ALPACA_API_KEY`
   - `ALPACA_API_SECRET`
   - `ALPACA_BASE_URL`  → `https://paper-api.alpaca.markets/v2`
   - `DISCORD_TSLA_WEBHOOK`
   - `DISCORD_SUMMARY_WEBHOOK`
   - `DISCORD_ERRORS_WEBHOOK`
   - `DISCORD_ACTIONS_WEBHOOK`
   - `BOT_PUSH_TOKEN`  → if you're **not** doing the dashboard yet, put any
     random text here (e.g. `placeholder123`). The bot has a "send state to
     dashboard" step that needs this name to exist; with no dashboard it just
     fails quietly and the bot keeps going. Step 9 replaces it with a real value.

> **The Name must match exactly** — same spelling, same capital letters, no
> extra spaces. The bot finds each value by its exact name. A typo here = the
> bot can't see that credential.

*(Optional, faster if you already use it: the GitHub CLI `gh secret set NAME
--body "value"` does the same thing from the terminal. Skip if "GitHub CLI"
means nothing to you — the website is fine.)*

**Test that it works end-to-end in the cloud:**

1. In your fork, click the **Actions** tab. If it shows a banner asking to
   enable workflows, click the green **enable** button.
2. In the left list click **TSLA Monitor**.
3. On the right, click the **Run workflow** dropdown → green **Run workflow**
   button. (This manually triggers one run now.)
4. Wait ~1–2 minutes, refresh. A run appears. Click it → click the `monitor`
   job to watch the steps. A green check ✓ = success. A red ✗ = open the failed
   step and read the red error text.
5. Check Discord again — you should see fresh activity, same as the local run.

---

# Step 6 — Schedule the bots with cron-job.org

Something has to "press the button" to run the bot every 10 minutes during
market hours. We use a free service called **cron-job.org** as that timer — on
schedule it pokes GitHub, which runs the bot. (A "cron job" is just industry
slang for "a task that runs on a timer.") The script `tools/setup_cronjobs.py`
sets up all those timers for you automatically; you just need to give it two
keys and tell it which repo is yours.

### 6a. Create a GitHub access token (so cron-job.org may start your bot)

A "personal access token" (PAT) is like a scoped password that lets another
service act on your GitHub on your behalf.

1. Go to **https://github.com/settings/personal-access-tokens** (or: your GitHub
   avatar top-right → **Settings** → scroll down to **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens**).
2. Click **Generate new token**.
3. Fill it in:
   - **Token name:** anything, e.g. `cron-job-trigger`.
   - **Expiration:** pick a date (e.g. 1 year out). When it expires you'll just
     repeat this step and update the value.
   - **Resource owner:** your own username.
   - **Repository access:** choose **Only select repositories** → pick
     **your fork** (`YOUR_USERNAME/TradingBotTest-Claude`).
   - **Permissions:** expand **Repository permissions**. Set **Actions** to
     **Read and write**, set **Contents** to **Read and write**, and set
     **Workflows** to **Read and write** (Workflows is required because the
     installer rewrites and pushes `.github/workflows/*.yml`). Leave everything
     else as "No access".
4. Click **Generate token**. Copy the token (it starts with `github_pat_`) into
   your text file **now** — like the Alpaca secret, it's shown only once.

### 6b. Create a cron-job.org account + API key

1. Go to **https://cron-job.org** and sign up (free). Verify your email and
   log in.
2. Click your account/profile, find the **API** section (sometimes under
   **Settings → API**). **Enable the API** if there's a toggle, then **create /
   copy your API key**. Paste it into your text file.

### 6c. Point the setup script at YOUR fork

> **Critical fork gotcha #1.** The script has the original author's repo name
> written into it. You must change it to yours or it will try to control the
> wrong repository.
>
> 1. Open `tools/setup_cronjobs.py` in a text editor (it's a plain text file
>    despite the `.py` extension).
> 2. Use the editor's Find (Ctrl+F / Cmd+F) to locate the line:
>    ```python
>    REPO = "tsronco/TradingBotTest-Claude"
>    ```
> 3. Change only the part in quotes to your fork, keeping the quotes:
>    ```python
>    REPO = "YOUR_USERNAME/TradingBotTest-Claude"
>    ```
> 4. Save the file. Then commit and push the change so the cloud copy matches:
>    ```bash
>    git add tools/setup_cronjobs.py
>    git commit -m "point cron setup at my fork"
>    git push
>    ```

### 6d. Run the scheduler setup

1. Open your `.env` file again and add these two lines (values from your text
   file):

   ```
   GITHUB_ACCESS_TOKEN=github_pat_...your token from 6a...
   CRONJOB_API_KEY=...your key from 6b...
   ```

   Save the file.

2. In the terminal, in the project folder, run:

   ```bash
   python tools/setup_cronjobs.py
   ```

   It prints the jobs it lists/creates/updates. Success looks like a series of
   "created" / "updated" lines and no error/traceback at the end. It is safe to
   re-run this command any time (it updates existing timers in place rather than
   duplicating them).

3. **Trim to the minimal set.** The script creates a timer for every account
   (aggressive, manual, live, small accounts, congress) even though you only
   have the conservative one so far. Log in to **cron-job.org**, open the
   **Cronjobs** list, and **disable every job except** these three:
   - **TSLA Monitor**
   - **Daily Summary**
   - **Wheel Screener**

   (Disable, don't delete — when you add accounts in Step 8 you just re-enable
   them, or re-run the script.) The disabled ones would otherwise fail
   harmlessly every 10 minutes because their accounts don't exist yet.

> **About the schedule times:** all times in the script are in **UTC** (a global
> reference time zone) and tuned to US market hours. Twice a year US clocks shift
> for daylight saving — when that happens the bot would run an hour off. The fix
> (shift each UTC hour value by 1) and the full schedule table are in
> [`CLAUDE.md`](CLAUDE.md) under "Scheduled workflows" → the **DST note**. You
> don't need to act on this now; just know where it's documented.

---

# Step 7 — Verify the minimal system

You now have a working single-account paper bot running in the cloud. Over the
next market day, confirm each of these:

- [ ] **It's running on schedule.** Your fork → **Actions** tab. During market
      hours you should see a new `TSLA Monitor` run appear roughly every 10
      minutes, each with a green ✓. (cron-job.org is what triggers them.)
- [ ] **Discord shows activity.** During market hours, `#trades` and/or
      `#all-actions` get new messages.
- [ ] **`#errors` stays empty.** This is the success signal — *if `#errors` is
      empty all day, the system worked.* Anything in `#errors` is a problem to
      investigate (see the runbook below).
- [ ] **Daily summary arrives.** On a weekday at 4:12 PM US Eastern Time,
      `#daily-summary` gets a summary card.
- [ ] **State is being saved.** Your fork → **Code** tab → click where it shows
      the latest commit / "commits". You should see automatic commits by
      `github-actions[bot]` updating `strategy_state.json` / `wheel_state.json`.
      That's the bot remembering its positions between runs.

If something is wrong, read the **"Runbook — when something breaks"** section of
[`CLAUDE.md`](CLAUDE.md) — it walks through rejected orders, missed runs, error
messages, and state-file issues, in plain steps.

**You can stop here if you just want the core bot.** Steps 8–10 are optional and
add complexity — only continue when the minimal setup has run cleanly for a
while.

---

# Step 8 — (Optional) Add more paper accounts

The same scripts run in seven "modes" selected by `--mode`. Each mode needs its
own Alpaca login, its own Discord channels, and its own secrets. The modes:

| Mode | Behaviour | Capital |
|---|---|---|
| `conservative` | Auto wheel, 10% OTM, 14–28 DTE (done in Steps 1–7) | paper |
| `aggressive` | Auto wheel, 5% OTM, 7–14 DTE, +crypto | paper |
| `manual` | You open trades by hand; bot only *manages* them | paper |
| `sm500` / `sm1000` / `sm2000` | Autonomous earnings-screened put credit spreads | paper, seeded $500/$1k/$2k |
| `live` | **Real money. See Step 10.** | **REAL** |

Each extra account is just **Steps 2, 3, and 5 repeated** with a different
name prefix. For one extra account at a time:

1. **New Alpaca login.** Repeat Step 2 but sign up with a different address using
   the Gmail "+" trick (e.g. `you+agg@gmail.com` for aggressive). Switch it to
   **Paper**, generate keys, save them to your text file labeled with the
   account.
2. **New Discord channels + webhooks.** Repeat Step 3 to make that account's
   channels (the full naming list per account is in [`CLAUDE.md`](CLAUDE.md) →
   "Discord channels"). Copy the new webhook URLs.
3. **Add the new settings in two places — same names in both:**
   - your local `.env` file, **and**
   - GitHub → your fork → Settings → Secrets and variables → Actions (Step 5).

   Use the exact names from `.env.example`. Each account has its own prefix:

   | Account | Alpaca key names | Discord prefix |
   |---|---|---|
   | aggressive | `ALPACA_AGG_API_KEY` / `ALPACA_AGG_API_SECRET` / `ALPACA_AGG_BASE_URL` | `DISCORD_AGG_*` |
   | manual | `ALPACA_MANUAL_API_KEY` / `…_SECRET` / `…_BASE_URL` | `DISCORD_MANUAL_*` |
   | sm500 | `ALPACA_SM500_API_KEY` / `…_SECRET` / `…_BASE_URL` | `DISCORD_SM500_*` |
   | sm1000 | `ALPACA_SM1000_*` | `DISCORD_SM1000_*` |
   | sm2000 | `ALPACA_SM2000_*` | `DISCORD_SM2000_*` |

   (Open `.env.example` and copy the exact lines — it lists every name for every
   account.)
4. **Turn that account's timer back on.** In cron-job.org, enable that account's
   monitor job (the one you disabled in Step 6d), or just re-run
   `python tools/setup_cronjobs.py` and enable it in the list.

To tweak strategy behavior, the per-account parameters live in `config.py` in
the `MODES` section. To change which stocks the wheel trades, edit
`CONSERVATIVE_SYMBOLS` / `AGGRESSIVE_SYMBOLS` in `config.py` (not in
`wheel_strategy.py`). The **order of symbols is the fill priority** — read the
"heads-up" box in [`CLAUDE.md`](CLAUDE.md) before reordering, or you may change
which trades get funded first.

### Congress copier (optional, conservative-only)

`congress-copy/` is a separate add-on that mirrors stock trades disclosed by a
few members of Congress. It has its **own** isolated Python setup (a "virtual
environment" — a sandbox so its libraries don't collide with the main bot's):

```bash
cd congress-copy
python -m venv .venv
# activate it:
#   Windows PowerShell:  .venv\Scripts\Activate.ps1
#   Mac/Linux:           source .venv/bin/activate
pip install -r requirements.txt
python -m pytest tests/ -q     # should end in "passed"
```

The politician list and how much it trades per disclosure are in
`congress-copy/config.py`. It reuses the **conservative** Alpaca keys and posts
to a `DISCORD_CONGRESS_WEBHOOK` (make that channel + webhook and add the value
like any other). A built-in safety file (`paper_guard.py`) refuses to run if it
ever sees real-money keys — **never** wire congress-copy to the live account.

---

# Step 9 — (Optional) Deploy the monitoring dashboard

The dashboard is a private website (only you can log in) that shows what the bot
is doing and lets you place manual trades. It's hosted free on **Vercel**. This
is the longest step because a website has more pieces than a script — but every
piece below is "make an account, copy a value, paste it somewhere". Go slowly,
one sub-step at a time. Keep your secrets text file open.

> **Skip this entire step if you only want the bot.** Steps 1–8 are a complete
> working system without any of this.

### 9a. Create the two accounts you'll need

1. **Vercel** (hosts the website, free). Go to **https://vercel.com** → **Sign
   Up** → choose **Continue with GitHub** and authorize it. Using GitHub to sign
   in links them, which makes deploying easier. Pick the **Hobby** (free) plan
   if asked.
2. **Anthropic** (the AI that grades trades — this is the one paid piece). Go to
   **https://console.anthropic.com** → sign up → in the left menu open **API
   Keys** → **Create Key** → name it (e.g. `dashboard`) → **copy the key**
   (starts with `sk-ant-`) into your text file. It is shown only once.
   - Then open **Billing** / **Plans** and **add a payment method and a small
     amount of prepaid credit** (e.g. \$5). Anthropic won't answer API calls
     with a \$0 balance. Per the Cost summary, \$5 lasts a long time at personal
     volume.
3. **Upstash** (the dashboard's Redis database — provisioned automatically by
   the installer). Go to **https://console.upstash.com** → sign up (free) →
   **Account** → **Management API** → create a key and copy it. The installer
   uses this key to create (or reuse) a free Redis DB and wire it to Vercel
   automatically — no Vercel Marketplace click needed. The installer requests
   the free plan; if your account requires a card it falls back to
   pay-as-you-go (~$0–$1/mo) and warns you in the log.

### 9b. Install the dashboard's libraries

In your terminal, move into the dashboard folder and install its parts. `npm`
came with Node (Prerequisite #3):

```bash
cd dashboard
npm install
```

This downloads into a `node_modules` folder and may take a minute. (When you
later need to run bot commands again, `cd ..` moves back up to the project root.)

### 9c. Generate the dashboard's secret values

The dashboard needs several random secret strings. The easiest cross-platform
way to make one (you already have Python installed) is:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Run that command **once for each** of these and paste each result into your text
file, labeled:

- `SESSION_SECRET` — signs your login cookie so it can't be forged.
- `BOT_PUSH_TOKEN` — password the bot uses to send its state to the dashboard.
- `INTERNAL_FUNCTIONS_TOKEN` — internal gate between two dashboard parts.
- `CRON_TOKEN` — password the trade-grading timer uses to call the dashboard.

Two more:

- `DASHBOARD_PASSWORD` — the password **you** type to log in. Choose your own
  strong one (or generate one the same way).
- `TOTP_SECRET` + `BACKUP_CODES_HASHED` — these add a 6-digit phone code on top
  of the password (like a bank login). Generate them with the bundled tool:

  ```bash
  npx tsx scripts/generate-backup-codes.ts
  ```

  It prints: (a) a `TOTP_SECRET` value, (b) an `otpauth://` link, and (c) a
  `BACKUP_CODES_HASHED` value plus the matching plain backup codes.
  - Install an **authenticator app** on your phone (Google Authenticator, Authy,
    or 1Password — all free). In it choose "add account" → "enter a setup key"
    and type the `TOTP_SECRET` (or scan the `otpauth://` link if you turn it
    into a QR code). The app now shows a rotating 6-digit code — that's what
    you'll type to log in.
  - **Save the plain backup codes somewhere offline** (write them down). They
    log you in if you lose your phone. Paste `TOTP_SECRET` and
    `BACKUP_CODES_HASHED` into your text file.

### 9d. Fill in the dashboard's `.env`

The dashboard has its **own** `.env`, separate from the bot's:

- Mac/Linux: `cp .env.example .env`  (you're inside `dashboard/`)
- Windows PowerShell: `Copy-Item .env.example .env`

Open `dashboard/.env` in your text editor and fill in everything you just
generated, **plus** your Alpaca paper keys (`ALPACA_API_KEY` /
`ALPACA_API_SECRET`, and the `AGG`/`MANUAL`/`SM` ones if you made those
accounts) and `ANTHROPIC_API_KEY`. Save it.

> Leave `KV_REST_API_URL` / `KV_REST_API_TOKEN` blank — they get filled in
> automatically in 9f. Don't type them by hand.

(Optional sanity check, still inside `dashboard/`: `npm test` should end in
"passed"; `npm run dev` then opening http://localhost:5173 shows the login page.
Press `Ctrl+C` in the terminal to stop the dev server.)

### 9e. Put the website online (deploy to Vercel)

Still inside the `dashboard/` folder, run:

```bash
npx vercel link
```

It asks a series of questions in the terminal — answer like this:
- "Set up and link?" → **yes** (press `y` / Enter)
- "Which scope?" → pick your account
- "Link to existing project?" → **no** (you're creating a new one)
- "Project name?" → type something like `my-tradingbot-dashboard`
- "In which directory is your code?" → just press Enter (it's the current `./`)
- If it asks to modify/override build settings → **no**

Then deploy it for real:

```bash
npx vercel --prod
```

When it finishes it prints a **Production URL** like
`https://my-tradingbot-dashboard.vercel.app`. **Save that URL in your text
file** — you'll need it twice below.

> Important: `git push` does **not** update this website. Every time you change
> dashboard code you re-deploy with `npx vercel --prod` from the `dashboard/`
> folder.

### 9f. Add the cloud database (Upstash Redis)

The installer provisions this automatically from your Upstash email +
Management API key — no manual Vercel Storage / Marketplace step. Nothing to
do here.

### 9g. Tell Vercel your other secrets

The website online doesn't have your `.env` (that file stays on your computer),
so add the values to Vercel:

1. In your project on Vercel → **Settings** → **Environment Variables**.
2. For each of these, type the **Key** (exact name) and **Value**, set the
   environment to **Production** (and Preview/Development too is fine), click
   **Save**:
   `DASHBOARD_PASSWORD`, `TOTP_SECRET`, `SESSION_SECRET`,
   `BACKUP_CODES_HASHED`, `BOT_PUSH_TOKEN`, `INTERNAL_FUNCTIONS_TOKEN`,
   `ANTHROPIC_API_KEY`, `CRON_TOKEN`, and all your `ALPACA_*` keys.
3. Re-deploy so the new values take effect: from `dashboard/`, run
   `npx vercel --prod` again.

### 9h. Connect the bot to your dashboard

> **Critical fork gotcha #2.** The bot's cloud files still point at the original
> author's dashboard address. You must replace it with **your** Vercel URL from
> 9e, in two places:
>
> **(a) Every workflow file.** All eight files in `.github/workflows/` contain
> the literal text `https://tradingbot-dashboard-blue.vercel.app`. Replace every
> occurrence with your URL. Either open each `.yml` file in a text editor and
> use Find & Replace, or run one command from the **project root** (`cd ..`
> first if you're in `dashboard/`):
>
> - Mac/Linux:
>   ```bash
>   grep -rl tradingbot-dashboard-blue.vercel.app .github/workflows/ \
>     | xargs sed -i 's#https://tradingbot-dashboard-blue.vercel.app#https://YOUR-URL.vercel.app#g'
>   ```
> - Windows PowerShell:
>   ```powershell
>   Get-ChildItem .github\workflows\*.yml | ForEach-Object {
>     (Get-Content $_ -Raw) -replace 'https://tradingbot-dashboard-blue\.vercel\.app','https://YOUR-URL.vercel.app' | Set-Content $_
>   }
>   ```
>
> **(b) `tools/setup_cronjobs.py`.** Open it and replace the same
> `https://tradingbot-dashboard-blue.vercel.app` on the two lines that build the
> `grade-open-trades` and `detect-tendencies` URLs (near lines 152 and 166) with
> your Vercel URL.
>
> Replace `YOUR-URL` above with your real Vercel subdomain. Then commit & push:
> ```bash
> git add .github/workflows tools/setup_cronjobs.py
> git commit -m "point dashboard pushes at my Vercel URL"
> git push
> ```

Now make the **`BOT_PUSH_TOKEN` the same value in both places**: the GitHub
Actions secret (Step 5) and the Vercel environment variable (9g) must be the
identical string. If they differ, the bot's data won't be accepted by the
dashboard. (Same rule applies to `CRON_TOKEN` for the next sub-step.)

### 9i. Turn on the trade-grading timer

The dashboard can auto-grade your closed trades on a schedule. Add this line to
the **bot's** `.env` (the one in the project root, not `dashboard/.env`):

```
DASHBOARD_CRON_TOKEN=...the same value as your Vercel CRON_TOKEN...
```

Then re-run the scheduler from the project root:

```bash
python tools/setup_cronjobs.py
```

Because you fixed the URL in `setup_cronjobs.py` in 9h(b), this now also creates
the **Grade Open Trades** and weekly **Detect Tendencies** timers pointed at
*your* dashboard.

### 9j. Log in and confirm

1. Open your Vercel Production URL in a browser.
2. Enter your `DASHBOARD_PASSWORD`, then the current 6-digit code from your
   authenticator app.
3. You're in. The bot's positions appear after the next scheduled Actions run
   pushes its state (give it up to ~10 minutes during market hours, or trigger
   `TSLA Monitor` manually from the Actions tab to see it sooner).

> If you ever modify dashboard code, the technical gotchas (library versions,
> Vercel's 12-function limit, a known Alpaca SDK quirk) are documented in
> [`CLAUDE.md`](CLAUDE.md) → "Dashboard subproject" → "Known quirks". You don't
> need any of that just to run it.

---

# Step 10 — (Optional, DANGEROUS) The real-money live account

> **🛑 STOP. Real money. No human in the loop. Read this whole section twice.**

The `live` account works exactly like the `manual` account — the bot only
*manages* positions you open by hand, it never opens new cash-secured puts on
its own — but it is wired to Alpaca's **real-money** system using **your actual
funds**. A mistake here costs real dollars.

**Do not start this until ALL of these are true. This is not a checklist to rush
— it is the entire point of the warning:**

- You have run the paper accounts for **weeks** and understand every single
  trade the bot made and why.
- You have read and understood every strategy in [`CLAUDE.md`](CLAUDE.md).
- You have run the **`manual` paper** account specifically (same code path as
  live, fake money) and watched it behave correctly through full trade cycles.
- You fully accept that a bug, an Alpaca API change, or a bad market swing can
  lose real money while you are asleep or driving, with no human to stop it.

Only if all of the above is genuinely true:

1. **Enable real-money trading in Alpaca.** Log in to Alpaca and switch the
   top-left toggle to **Live Trading**. Complete the brokerage application
   Alpaca requires (identity, tax, agreements) and **fund the account** by
   linking a bank and transferring money. This is a real brokerage account; it
   can take a day or two to approve and for funds to settle.
2. **Generate LIVE API keys.** With the toggle on **Live Trading**, go to the
   API Keys box and generate a key pair. **These keys start with `AK`, not
   `PK`.** Treat them far more carefully than paper keys. Save them labeled
   "LIVE — REAL MONEY".
3. **Add them to your `.env` and to GitHub Actions secrets** (Step 5 method),
   exactly these names — note the base URL has **no** `paper-` in it:

   ```
   ALPACA_LIVE_API_KEY=AK...
   ALPACA_LIVE_API_SECRET=...
   ALPACA_LIVE_BASE_URL=https://api.alpaca.markets/v2
   ```

4. **Make the live Discord channels.** Repeat Step 3 for the `#live-*` channels
   and `DISCORD_LIVE_*` webhooks. Set these channels' notifications to **push to
   your phone** — for real money you want to know immediately.
5. **Enable the live timer.** In cron-job.org, enable the
   **TSLA Monitor (Live)** job (or re-run `python tools/setup_cronjobs.py` and
   enable it).
6. **Never** connect `congress-copy` to the live account — a built-in safety
   (`paper_guard.py`) will refuse it, and copying scraped political trades with
   real money is a bad idea regardless.
7. **Dashboard stays read-only for live by default.** The dashboard blocks
   placing live orders unless you deliberately add a Vercel environment variable
   `LIVE_ENABLED=true`. Leave it unset unless you specifically want to place
   real-money orders from the website, and understand that risk.

**Start with the smallest amount of money you are 100% willing to lose
entirely.** Treat anything above zero as already spent.

---

## Quick reference: the two fork gotchas

If something works locally but not when hosted, it's almost always one of these:

1. **`tools/setup_cronjobs.py`** → `REPO = "tsronco/TradingBotTest-Claude"` must
   become your fork's `OWNER/REPO`. (Step 6c)
2. **`.github/workflows/*.yml`** *and* the two URL lines in
   **`tools/setup_cronjobs.py`** (~lines 152 & 166) → every
   `https://tradingbot-dashboard-blue.vercel.app` must become your Vercel URL.
   (Step 9h)

Plus: GitHub Actions secret names must exactly match `.env` keys, and
`BOT_PUSH_TOKEN` / `CRON_TOKEN` must be identical on both the GitHub and Vercel
sides.

---

## Where to learn more

- [`CLAUDE.md`](CLAUDE.md) — the authoritative architecture doc: every mode,
  every strategy's exact parameters, the Discord channel map, the cron schedule
  table with DST notes, the full runbook, and dashboard internals.
- `config.py` — `MODES` table: credentials, state files, channels, and strategy
  parameters per mode.
- `tests/` — run `python -m pytest tests/ -q` any time you change strategy code;
  it mocks all external services.
- Alpaca docs — https://docs.alpaca.markets
