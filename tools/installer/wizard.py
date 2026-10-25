"""Interactive setup orchestrator.

Drives the whole flow but stays thin: the account/credential model lives in
``spec``, file safety in ``envfile``, fork fixes in ``fork``, and each
external service is a small wrapper module. ``--dry-run`` skips every
mutating network/subprocess call so the flow can be walked safely.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from . import envfile, fork, secrets_gen, spec, validate
from .prompts import (
    ask,
    ask_secret,
    choose_multi,
    error,
    header,
    info,
    step,
    success,
    warn,
    yes_no,
)

ROOT = Path(__file__).resolve().parent.parent.parent
ENV_PATH = ROOT / ".env"
DASH_DIR = ROOT / "dashboard"
DASH_ENV_PATH = DASH_DIR / ".env"
DATA_URL = "https://data.alpaca.markets/v2"


class Wizard:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.bot_env: dict[str, str] = {}
        self.dash_env: dict[str, str] = {}
        self.modes: list[str] = []
        self.include_congress = False
        self.do_dashboard = False
        self.owner_repo = ""
        self.dashboard_url = ""

    # ── phases ────────────────────────────────────────────────────────────

    def welcome(self) -> None:
        header("TradingBot setup wizard")
        info("This collects the credentials you created, writes your .env files,")
        info("fixes the two fork gotchas, and (optionally) wires Discord, GitHub")
        info("secrets, cron-job.org, and the Vercel dashboard for you.")
        warn("It cannot create the third-party ACCOUNTS — sign up first, per")
        warn("instructions.md. Have your keys/tokens pasted somewhere handy.")
        if self.dry_run:
            warn("DRY-RUN: nothing external will be changed.")

    def detect_fork(self) -> None:
        step(1, 9, "Identify your fork")
        guess = ""
        try:
            url = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                cwd=ROOT, capture_output=True, text=True, timeout=15,
            ).stdout.strip()
            guess = fork.parse_owner_repo(url) or ""
        except Exception:
            pass
        if guess:
            success(f"Detected git remote: {guess}")
            if yes_no(f"Use '{guess}' as your fork?", True):
                self.owner_repo = guess
        if not self.owner_repo:
            self.owner_repo = ask("Your fork (OWNER/REPO)", guess or None)

    def choose_accounts(self) -> None:
        step(2, 9, "Choose accounts to configure")
        opts = [(a.mode, a.label) for a in spec.all_accounts()]
        self.modes = choose_multi(
            "Select accounts (Enter=confirm):", opts, preselected={"conservative"}
        )
        if not self.modes:
            self.modes = ["conservative"]
        if "live" in self.modes:
            header("⚠  LIVE = REAL MONEY, no human in the loop")
            warn("Only continue if you've run paper for weeks and read CLAUDE.md.")
            if not yes_no("Keep the LIVE real-money account selected?", False):
                self.modes.remove("live")
        success("Configuring: " + ", ".join(self.modes))
        if "conservative" in self.modes:
            self.include_congress = yes_no(
                "Enable the (conservative-only) congress copier?", False
            )
        self.do_dashboard = yes_no("Set up the Vercel monitoring dashboard?", True)

    def collect_alpaca(self) -> None:
        step(3, 9, "Alpaca API keys (per account)")
        for mode in self.modes:
            acc = spec.account(mode)
            print()
            info(f"{acc.label}  [{acc.mode}]")
            if acc.is_real:
                warn("These are REAL-MONEY keys — they start with AK, not PK.")
            key = ask_secret(f"{acc.key_env}")
            sec = ask_secret(f"{acc.secret_env}")
            url = ask(acc.url_env, acc.default_url)
            self.bot_env[acc.key_env] = key
            self.bot_env[acc.secret_env] = sec
            self.bot_env[acc.url_env] = url
            if not self.dry_run and yes_no("Test these credentials now?", True):
                ok, msg = validate.check_alpaca(key, sec, url)
                (success if ok else error)(f"Alpaca: {msg}")

    def collect_discord(self) -> None:
        step(4, 9, "Discord notifications")
        auto = not self.dry_run and yes_no(
            "Auto-create channels + webhooks via a Discord bot? "
            "(No = paste webhook URLs yourself)", False
        )
        ds = None
        if auto:
            from .discord_api import DiscordSetup

            token = ask_secret("Discord BOT token")
            guild = ask("Discord server (guild) ID")
            ds = DiscordSetup(token, guild, dry_run=self.dry_run)
        for mode in self.modes:
            acc = spec.account(mode)
            for env, channel in acc.webhooks.items():
                if env == spec.CONGRESS_WEBHOOK_ENV and not self.include_congress:
                    continue
                if ds is not None:
                    try:
                        self.bot_env[env] = ds.ensure(channel)
                        success(f"#{channel} -> {env}")
                        continue
                    except Exception as e:  # fall back to manual for this one
                        error(f"#{channel}: {e}")
                val = ask(f"{env} (#{channel}) webhook URL — Enter to skip", "")
                if val:
                    self.bot_env[env] = val

    def collect_globals(self) -> None:
        step(5, 9, "GitHub / cron-job.org / shared tokens")
        info("The GitHub token needs fine-grained perms on your fork:")
        info("Contents + Actions + Secrets = Read and write.")
        self.bot_env["GITHUB_ACCESS_TOKEN"] = ask_secret("GITHUB_ACCESS_TOKEN")
        self.bot_env["CRONJOB_API_KEY"] = ask_secret("CRONJOB_API_KEY")
        self.bot_env["BOT_PUSH_TOKEN"] = self._gen_or_paste("BOT_PUSH_TOKEN")
        self.bot_env["DASHBOARD_CRON_TOKEN"] = self._gen_or_paste("DASHBOARD_CRON_TOKEN")

    def collect_dashboard(self) -> None:
        if not self.do_dashboard:
            return
        step(6, 9, "Dashboard secrets")
        d = self.dash_env
        d["BOT_PUSH_TOKEN"] = self.bot_env["BOT_PUSH_TOKEN"]
        d["CRON_TOKEN"] = self.bot_env["DASHBOARD_CRON_TOKEN"]
        d["SESSION_SECRET"] = secrets_gen.token()
        d["INTERNAL_FUNCTIONS_TOKEN"] = secrets_gen.token()
        d["DASHBOARD_PASSWORD"] = self._gen_or_paste("DASHBOARD_PASSWORD")
        d["ANTHROPIC_API_KEY"] = ask_secret("ANTHROPIC_API_KEY (sk-ant-...)")
        ts = secrets_gen.totp_secret()
        d["TOTP_SECRET"] = ts
        success("TOTP secret generated. Add it to your authenticator app:")
        info(f"  secret : {ts}")
        info(f"  otpauth: {secrets_gen.otpauth_uri(ts)}")
        bc = secrets_gen.generate_backup_codes(DASH_DIR)
        if bc:
            codes, hashed = bc
            d["BACKUP_CODES_HASHED"] = hashed
            success("Backup codes (write these down offline — shown once):")
            for i, c in enumerate(codes, 1):
                info(f"  {i}. {c}")
        else:
            warn("Skipped backup codes (needs Node/npx). TOTP still works; "
                 "generate later with dashboard/scripts/generate-backup-codes.ts.")
        d["ALPACA_DATA_BASE_URL"] = DATA_URL
        for mode in self.modes:
            if mode == "live":
                continue
            acc = spec.account(mode)
            for e in acc.alpaca_env:
                if e in self.bot_env:
                    d[e] = self.bot_env[e]

    def _preview_env(self, label: str, values: dict[str, str]) -> None:
        keep = {k: v for k, v in values.items() if v not in (None, "")}
        success(f"{label} — would set {len(keep)} keys (DRY-RUN, not written):")
        for k in sorted(keep):
            info(f"  {k} = {envfile.mask(keep[k])}")

    def write_env_files(self) -> None:
        step(7, 9, "Write .env files")
        if self.dry_run:
            self._preview_env(".env", self.bot_env)
            if self.do_dashboard:
                self._preview_env("dashboard/.env", self.dash_env)
            return
        written = envfile.write_merged(ENV_PATH, self.bot_env)
        success(f".env — {len(written)} keys set")
        for k in sorted(written):
            info(f"  {k} = {envfile.mask(written[k])}")
        if self.do_dashboard:
            dw = envfile.write_merged(DASH_ENV_PATH, self.dash_env)
            success(f"dashboard/.env — {len(dw)} keys set")

    def fix_fork(self) -> None:
        step(8, 9, "Fix the two fork gotchas")
        url = self.dashboard_url or None
        if self.do_dashboard and not url:
            warn("No dashboard URL yet — workflows still point at the original.")
            warn("Re-run with --fix-urls after the first Vercel deploy, or set "
                 "the URL when prompted below.")
            maybe = ask("Vercel dashboard URL (Enter to skip for now)", "")
            url = maybe or None
        if self.dry_run:
            info(f"DRY-RUN: would set REPO={self.owner_repo}"
                 + (f", dashboard URL={url}" if url else ""))
            return
        changes = fork.apply(ROOT, self.owner_repo, url)
        for c in changes:
            success(c)
        if changes:
            warn("These are TRACKED files — commit & push them to your fork:")
            info("  git add tools/setup_cronjobs.py .github/workflows")
            info('  git commit -m "point setup at my fork" && git push')

    def push_and_schedule(self) -> None:
        step(9, 9, "Push GitHub secrets + schedule cron jobs")
        if not yes_no("Bulk-push the Actions secrets to your fork now?", True):
            warn("Skipped. You can re-run setup.py later to push them.")
        else:
            self._push_github_secrets()
        if self.dry_run:
            info("DRY-RUN: would run tools/setup_cronjobs.py")
        elif yes_no("Configure cron-job.org schedules now?", True):
            self._run_cronjobs()
        if self.do_dashboard and not self.dry_run:
            self._deploy_dashboard()

    def doctor(self) -> None:
        header("Health check")
        existing = envfile.read_values(ENV_PATH)
        for mode in (self.modes or spec.ACCOUNT_ORDER):
            acc = spec.account(mode)
            k, s, u = (existing.get(x, "") for x in acc.alpaca_env)
            if not (k and s):
                continue
            ok, msg = validate.check_alpaca(k, s, u or acc.default_url)
            (success if ok else error)(f"{acc.mode}: Alpaca {msg}")

    # ── helpers ───────────────────────────────────────────────────────────

    def _gen_or_paste(self, name: str) -> str:
        if yes_no(f"Generate a strong random {name}?", True):
            return secrets_gen.token()
        return ask_secret(name)

    def _push_github_secrets(self) -> None:
        from .github_api import GitHubError, GitHubSecrets, MissingDependency

        envs = spec.github_secret_envs(self.modes, self.include_congress)
        gh = GitHubSecrets(
            self.owner_repo, self.bot_env["GITHUB_ACCESS_TOKEN"], dry_run=self.dry_run
        )
        for name in envs:
            value = self.bot_env.get(name)
            if not value:
                warn(f"{name}: no value collected — skipped")
                continue
            try:
                info("  " + gh.put_secret(name, value))
            except MissingDependency as e:
                error(str(e))
                if yes_no("Install PyNaCl now and retry?", True) and self._pip("pynacl"):
                    try:
                        info("  " + gh.put_secret(name, value))
                        continue
                    except Exception as e2:
                        error(str(e2))
                return
            except GitHubError as e:
                error(str(e))
                return

    def _run_cronjobs(self) -> None:
        try:
            p = subprocess.run(
                [sys.executable, "tools/setup_cronjobs.py"],
                cwd=ROOT, capture_output=True, text=True, timeout=300,
            )
            (success if p.returncode == 0 else error)("setup_cronjobs.py finished")
            print(p.stdout[-1500:] or p.stderr[-800:])
            warn("Trim cron-job.org to your enabled accounts (see instructions Step 6d).")
        except Exception as e:
            error(f"setup_cronjobs.py: {e}")

    def _deploy_dashboard(self) -> None:
        from . import vercel_cli

        if not vercel_cli.available():
            warn("Vercel CLI unavailable — deploy manually (instructions Step 9e).")
            return
        proj = ask("Vercel project name", "my-tradingbot-dashboard")
        ok, msg = vercel_cli.link(DASH_DIR, proj)
        (success if ok else warn)(f"vercel link: {msg[:120]}")
        for k, v in self.dash_env.items():
            ok, msg = vercel_cli.set_env(DASH_DIR, k, v)
            (info if ok else warn)(f"  env {msg[:120]}")
        ok, msg = vercel_cli.deploy(DASH_DIR)
        if ok:
            self.dashboard_url = msg
            success(f"Deployed: {msg}")
            warn("Re-run: python setup.py --fix-urls  (points workflows here)")
        else:
            error(f"Deploy failed: {msg[:200]}")

    def _pip(self, pkg: str) -> bool:
        try:
            return subprocess.run(
                [sys.executable, "-m", "pip", "install", pkg], cwd=ROOT, timeout=300
            ).returncode == 0
        except Exception:
            return False

    # ── entry ─────────────────────────────────────────────────────────────

    def run(self) -> None:
        self.welcome()
        self.detect_fork()
        self.choose_accounts()
        self.collect_alpaca()
        self.collect_discord()
        self.collect_globals()
        self.collect_dashboard()
        self.write_env_files()
        self.fix_fork()
        self.push_and_schedule()
        self.doctor()
        header("Done")
        info("Next: enable Actions on your fork, commit the fork-fix changes,")
        info("and verify per instructions.md Step 7.")


def run_wizard(dry_run: bool = False) -> None:
    Wizard(dry_run=dry_run).run()


def run_doctor() -> None:
    Wizard().doctor()


def run_fix_urls() -> None:
    """Re-apply just the fork fixes (post-deploy URL pass)."""
    header("Fix fork URLs")
    w = Wizard()
    w.detect_fork()
    url = ask("Vercel dashboard URL", "")
    changes = fork.apply(ROOT, w.owner_repo, url or None)
    for c in changes:
        success(c)
    if not changes:
        info("Nothing to change (already pointed at your fork/URL).")
