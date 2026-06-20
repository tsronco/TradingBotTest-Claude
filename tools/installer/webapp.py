"""Local web-UI front-end for the installer.

Same engine as the CLI wizard (spec / envfile / fork / secrets_gen /
github_api / discord_api / vercel_cli / validate) — this is just a different
front-end: a stdlib-only HTTP server bound to 127.0.0.1, gated by a random
per-run token, serving one guided page. No new dependencies, no build step.

Security model: localhost-only bind, ephemeral port, a ``secrets``-grade
token required on every request (page + API), HTML served from a constant
(no filesystem static serving), and no secret values are ever echoed back to
the client by the server (the user's own browser holds what they typed; the
progress log masks anything it reports).
"""
from __future__ import annotations

import base64
import hmac
import json
import secrets as _secrets
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import envfile, fork, secrets_gen, spec, validate, wizard

# _UpstashProvisioner is the concrete class imported at module load time.
# Inside _deploy_dashboard, the constructor is accessed via the module
# (upstash_api.UpstashProvisioner) so tests can monkeypatch the class;
# the static kv_env() call uses this alias, which always points to the
# real implementation regardless of patching.  Both spellings are
# intentional — do not consolidate.
from .upstash_api import UpstashProvisioner as _UpstashProvisioner, UpstashError

ROOT = wizard.ROOT
ENV_PATH = wizard.ENV_PATH
DASH_DIR = wizard.DASH_DIR
DASH_ENV_PATH = wizard.DASH_ENV_PATH
DATA_URL = wizard.DATA_URL


def _reset_state_files(dry: bool) -> list[str]:
    """Blank inherited bot memory so a fresh fork starts clean.

    Mirrors the manual ``echo "{}" > strategy_state*.json wheel_state*.json``
    step from instructions.md — local file writes only, idempotent.
    """
    targets = sorted(
        p for pat in ("strategy_state*.json", "wheel_state*.json")
        for p in ROOT.glob(pat)
    )
    names = [p.name for p in targets]
    if not dry:
        for p in targets:
            p.write_text("{}\n")
    return names


class WebInstaller:
    """Holds wizard state and runs the apply orchestration off a thread."""

    def __init__(self, dry_run: bool = False):
        self.default_dry_run = dry_run
        self.progress: list[dict] = []
        self.done = False
        self.dashboard_url = ""
        self._lock = threading.Lock()

    # ── read-only catalog for the page ────────────────────────────────────

    def init_state(self) -> dict:
        import subprocess

        guess = ""
        try:
            url = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                cwd=ROOT, capture_output=True, text=True, timeout=15,
            ).stdout.strip()
            guess = fork.parse_owner_repo(url) or ""
        except Exception:
            pass
        accounts = [
            {
                "mode": a.mode,
                "label": a.label,
                "is_real": a.is_real,
                "key_env": a.key_env,
                "secret_env": a.secret_env,
                "url_env": a.url_env,
                "default_url": a.default_url,
                "webhooks": a.webhooks,
            }
            for a in spec.all_accounts()
        ]
        return {
            "owner_repo": guess,
            "accounts": accounts,
            "global_secrets": [
                {"name": n, "kind": k, "desc": d} for n, k, d in spec.GLOBAL_SECRETS
            ],
            "dashboard_secrets": [
                {"name": n, "kind": k, "desc": d} for n, k, d in spec.DASHBOARD_SECRETS
            ],
            "congress_env": spec.CONGRESS_WEBHOOK_ENV,
            "data_url": DATA_URL,
            "existing_env_keys": sorted(envfile.read_values(ENV_PATH)),
            "existing_dash_keys": sorted(envfile.read_values(DASH_ENV_PATH)),
            "default_dry_run": self.default_dry_run,
        }

    # ── progress helpers ──────────────────────────────────────────────────

    def _log(self, level: str, msg: str) -> None:
        with self._lock:
            self.progress.append({"level": level, "msg": msg})

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "lines": list(self.progress),
                "done": self.done,
                "dashboard_url": self.dashboard_url,
            }

    # ── apply (runs on a background thread) ───────────────────────────────

    def start_apply(self, cfg: dict) -> None:
        with self._lock:
            self.progress = []
            self.done = False
            self.dashboard_url = ""
        threading.Thread(target=self._apply, args=(cfg,), daemon=True).start()

    def _apply(self, cfg: dict) -> None:
        try:
            self._run_apply(cfg)
        except Exception as e:  # never let the thread die silently
            self._log("error", f"Unexpected error: {e}")
        finally:
            with self._lock:
                self.done = True
            self._log("info", "Finished. You can close this tab.")

    def _run_apply(self, cfg: dict) -> None:
        dry = bool(cfg.get("dry_run"))
        owner_repo = cfg["owner_repo"]
        modes = cfg["modes"]
        include_congress = bool(cfg.get("include_congress"))
        do_dashboard = bool(cfg.get("do_dashboard"))
        bot_env = {k: v for k, v in cfg.get("bot_env", {}).items() if v}
        dash_env = {k: v for k, v in cfg.get("dash_env", {}).items() if v}

        self._log("info", f"{'DRY-RUN — ' if dry else ''}Configuring {owner_repo}")

        # 0. reset inherited bot memory (fresh-fork hygiene)
        if cfg.get("reset_state", True):
            for name in _reset_state_files(dry):
                self._log("info" if dry else "ok",
                          f"{'Would reset' if dry else 'Reset'} {name}")

        # 1. .env files
        if dry:
            for k in sorted(bot_env):
                self._log("info", f".env would set {k} = {envfile.mask(bot_env[k])}")
            if do_dashboard:
                for k in sorted(dash_env):
                    self._log("info", f"dashboard/.env would set {k} = {envfile.mask(dash_env[k])}")
        else:
            w = envfile.write_merged(ENV_PATH, bot_env)
            self._log("ok", f".env — {len(w)} keys written")
            if do_dashboard:
                dw = envfile.write_merged(DASH_ENV_PATH, dash_env)
                self._log("ok", f"dashboard/.env — {len(dw)} keys written")

        # After step 1 the .env files are the complete merged truth (form
        # values + already-set keys preserved by write_merged). Every step
        # below must source from that, NOT the in-memory form — the re-run
        # safety UI deliberately leaves already-set fields blank.
        if dry:
            eff_bot, eff_dash = bot_env, dash_env  # files unwritten; preview=form
        else:
            eff_bot = envfile.read_values(ENV_PATH)
            eff_dash = (envfile.read_values(DASH_ENV_PATH)
                        if do_dashboard else {})

        # 2. fork gotchas
        url = self.dashboard_url or cfg.get("dashboard_url") or None
        if dry:
            self._log("info", f"Would set REPO={owner_repo}"
                      + (f", dashboard URL={url}" if url else ""))
        else:
            for c in fork.apply(ROOT, owner_repo, url):
                self._log("ok", f"Rewrote {c}")

        # 3. GitHub Actions secrets + enable workflows on the fork
        self._push_secrets(owner_repo, modes, include_congress, eff_bot, dry)
        self._enable_actions(owner_repo, eff_bot, dry)

        # 4. cron-job.org
        if dry:
            self._log("info", "Would run tools/setup_cronjobs.py")
        else:
            self._run_cron()

        # 5. dashboard deploy (provisions Upstash Redis, then deploys)
        if do_dashboard and not dry:
            self._deploy_dashboard(cfg, dict(eff_dash), eff_bot, owner_repo)

        # 6. commit & push the rewrites to the fork
        if cfg.get("auto_push", True):
            self._git_push_fork(owner_repo, eff_bot.get("GITHUB_ACCESS_TOKEN", ""), dry)
        else:
            self._log("warn", "Auto-push off — commit & push the rewritten "
                      "files to your fork by hand.")

        # 7. health check
        if not dry:
            for mode in modes:
                acc = spec.account(mode)
                k = eff_bot.get(acc.key_env)
                s = eff_bot.get(acc.secret_env)
                u = eff_bot.get(acc.url_env, acc.default_url)
                if k and s:
                    ok, msg = validate.check_alpaca(k, s, u)
                    self._log("ok" if ok else "error", f"{mode}: Alpaca {msg}")

    def _push_secrets(self, owner_repo, modes, include_congress, bot_env, dry) -> None:
        from .github_api import GitHubError, GitHubSecrets, MissingDependency

        envs = spec.github_secret_envs(modes, include_congress)
        gh = GitHubSecrets(owner_repo, bot_env.get("GITHUB_ACCESS_TOKEN", ""), dry_run=dry)
        for name in envs:
            val = bot_env.get(name)
            if not val:
                self._log("warn", f"{name}: no value — skipped")
                continue
            try:
                self._log("ok", gh.put_secret(name, val))
            except MissingDependency:
                self._log("error", "PyNaCl missing — run: "
                          "pip install -r tools/installer/requirements.txt, then re-apply")
                return
            except GitHubError as e:
                self._log("error", str(e))
                return

    def _enable_actions(self, owner_repo, bot_env, dry) -> None:
        from .github_api import GitHubError, GitHubSecrets

        token = bot_env.get("GITHUB_ACCESS_TOKEN", "")
        if not token:
            self._log("warn", "No GitHub token — enable Actions by hand "
                      "(fork → Actions tab → enable workflows).")
            return
        try:
            gh = GitHubSecrets(owner_repo, token, dry_run=dry)
            self._log("ok", gh.enable_actions())
        except GitHubError as e:
            self._log("warn", str(e))  # graceful: manual fallback in message

    def _git_push_fork(self, owner_repo, token, dry) -> None:
        """Commit & push ONLY the installer-rewritten files to the fork.

        Explicit allowlist — never ``git add -A``, never ``.env`` — so a
        credential can't be swept in. Authenticates via a transient
        http.extraheader git config flag (never persisted to .git/config).
        Degrades to printing the manual commands (never crashes the install)
        if git identity/auth/hooks block it.
        """
        paths = []
        sc = ROOT / "tools" / "setup_cronjobs.py"
        if sc.exists():
            paths.append(sc)
        paths += sorted((ROOT / ".github" / "workflows").glob("*.yml"))
        for pat in ("strategy_state*.json", "wheel_state*.json"):
            paths += sorted(ROOT.glob(pat))
        rel = [str(p.relative_to(ROOT)) for p in paths]
        if not rel:
            return
        if dry:
            self._log("info", f"Would commit & push {len(rel)} rewritten "
                      "files to origin (no .env, explicit allowlist)")
            return

        def git(*args, **kw):
            return subprocess.run(["git", *args], cwd=ROOT,
                                  capture_output=True, text=True,
                                  timeout=180, **kw)

        branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        if branch in ("", "HEAD"):
            branch = "main"
        ident = []
        if not git("config", "user.email").stdout.strip():
            ident = ["-c", "user.email=installer@localhost",
                     "-c", "user.name=TradingBot Installer"]
        git("add", "--", *rel)
        if git("diff", "--cached", "--quiet").returncode == 0:
            self._log("ok", "Fork already current — nothing to push.")
            return
        msg = f"Configure fork: point automation at {owner_repo} + reset state"
        if git(*ident, "commit", "-m", msg).returncode != 0:
            self._log("warn", "Auto-commit blocked (git identity or a commit "
                      f"hook). Run by hand:\n  git add {' '.join(rel)}\n"
                      f'  git commit -m "configure fork"\n  git push')
            return
        push_cfg: list[str] = []
        if token:
            blob = base64.b64encode(
                f"x-access-token:{token}".encode()
            ).decode()
            push_cfg = ["-c",
                        "http.https://github.com/.extraheader="
                        f"AUTHORIZATION: basic {blob}"]
        last_err = ""
        for attempt in range(4):
            p = git(*push_cfg, "push", "-u", "origin", branch)
            if p.returncode == 0:
                self._log("ok", f"Committed & pushed fork config to "
                          f"origin/{branch}.")
                return
            last_err = (p.stderr or p.stdout or "")  # consumed by Task 6 (workflow-scope classifier)
            if attempt < 3:
                time.sleep(2 ** (attempt + 1))
        from .github_api import is_workflow_scope_error
        if is_workflow_scope_error(last_err):
            self._log("warn", "Push rejected: your GitHub PAT lacks the "
                      "Workflows permission (the installer rewrites workflow "
                      "files). Fix: edit the fine-grained PAT -> Repository "
                      "permissions -> Workflows: Read and write -> Update "
                      "token, then re-run Apply.")
        else:
            self._log("warn", "Auto-push failed (check git auth/network). "
                      "Your commit is saved locally — finish with:  "
                      f"git push -u origin {branch}")

    def _run_cron(self) -> None:
        import sys

        try:
            p = subprocess.run(
                [sys.executable, "tools/setup_cronjobs.py"],
                cwd=ROOT, capture_output=True, text=True, timeout=300,
            )
            if p.returncode == 0:
                level = "ok"
            elif p.returncode == 75:
                level = "warn"  # rate-limited partial — re-run finishes it
            else:
                level = "error"
            self._log(level, "setup_cronjobs.py finished")
            tail = (p.stdout or p.stderr).strip().splitlines()[-6:]
            for line in tail:
                self._log("info", line)
        except Exception as e:
            self._log("error", f"setup_cronjobs.py: {e}")

    def _deploy_dashboard(self, cfg, dash_env, bot_env, owner_repo) -> None:
        from . import upstash_api, vercel_cli

        if not vercel_cli.available():
            self._log("warn", "Vercel CLI unavailable — deploy manually "
                      "(instructions Step 9).")
            return

        email = bot_env.get("UPSTASH_EMAIL", "")
        api_key = bot_env.get("UPSTASH_API_KEY", "")
        if not (email and api_key):
            self._log("error", "Upstash email + Management API key required "
                      "(the dashboard needs a Redis store). Add them and "
                      "re-Apply.")
            return
        try:
            prov = upstash_api.UpstashProvisioner(email, api_key)
            db, plan = prov.find_or_create()
            # KV vars are pushed to Vercel only (production reads Vercel runtime
            # env); intentionally not written to dashboard/.env — see spec §1.
            dash_env.update(_UpstashProvisioner.kv_env(db))
        except UpstashError as e:
            self._log("error", f"Upstash provisioning failed: {e}")
            return
        if plan == "payg":
            self._log("warn", "Upstash free plan unavailable — created a "
                      "pay-as-you-go DB (~$0-$1/mo for this dashboard). Add a "
                      "card at console.upstash.com if it prompts you.")
        elif plan == "existing":
            self._log("ok", "Reusing existing Upstash DB "
                      f"'{db.get('database_name')}'.")
        else:
            self._log("ok", "Created free Upstash DB "
                      f"'{db.get('database_name')}'.")

        proj = cfg.get("vercel_project") or "my-tradingbot-dashboard"
        ok, msg = vercel_cli.link(DASH_DIR, proj)
        self._log("ok" if ok else "warn", f"vercel link: {msg[:160]}")
        for k, v in dash_env.items():
            ok, msg = vercel_cli.set_env(DASH_DIR, k, v)
            self._log("info" if ok else "warn", f"env {msg[:120]}")
        ok, msg = vercel_cli.deploy(DASH_DIR)
        if ok:
            self.dashboard_url = msg
            self._log("ok", f"Deployed: {msg}")
            for c in fork.apply(ROOT, owner_repo, msg):
                self._log("ok", f"Re-pointed {c} at {msg}")
            self._log("info", "Re-syncing cron-job.org with deployed URL…")
            self._run_cron()
        else:
            self._log("error", f"Deploy failed: {msg[:200]}")


# ── HTTP layer ────────────────────────────────────────────────────────────

def _make_handler(installer: WebInstaller, token: str):
    PAGE = _PAGE_HTML

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # silence default stderr logging
            pass

        def _authed(self) -> bool:
            q = parse_qs(urlparse(self.path).query)
            supplied = (
                self.headers.get("X-Installer-Token")
                or (q.get("t", [""])[0])
            )
            return hmac.compare_digest(supplied, token)

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj: dict) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _read_json(self) -> dict:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0:
                return {}
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return {}

        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            if not self._authed():
                return self._send(403, b"forbidden", "text/plain")
            if path == "/":
                html = PAGE.replace("__TOKEN__", token)
                return self._send(200, html.encode(), "text/html; charset=utf-8")
            if path == "/api/init":
                return self._json(200, installer.init_state())
            if path == "/api/progress":
                return self._json(200, installer.snapshot())
            return self._send(404, b"not found", "text/plain")

        def do_POST(self):  # noqa: N802
            path = urlparse(self.path).path
            if not self._authed():
                return self._json(403, {"error": "forbidden"})
            body = self._read_json()
            if path == "/api/validate/alpaca":
                ok, msg = validate.check_alpaca(
                    body.get("key", ""), body.get("secret", ""), body.get("url", "")
                )
                return self._json(200, {"ok": ok, "msg": msg})
            if path == "/api/validate/discord":
                ok, msg = validate.check_discord(body.get("url", ""))
                return self._json(200, {"ok": ok, "msg": msg})
            if path == "/api/discord":
                return self._json(200, _discord_create(body))
            if path == "/api/generate":
                return self._json(200, _generate(body.get("kind", "")))
            if path == "/api/apply":
                installer.start_apply(body)
                return self._json(200, {"started": True})
            if path == "/api/quit":
                threading.Thread(
                    target=self.server.shutdown, daemon=True
                ).start()
                return self._json(200, {"bye": True})
            return self._json(404, {"error": "not found"})

    return Handler


def _generate(kind: str) -> dict:
    if kind == "token":
        return {"value": secrets_gen.token()}
    if kind == "totp":
        s = secrets_gen.totp_secret()
        return {"secret": s, "otpauth": secrets_gen.otpauth_uri(s)}
    if kind == "backup":
        bc = secrets_gen.generate_backup_codes(DASH_DIR)
        if not bc:
            return {"codes": None}
        codes, hashed = bc
        return {"codes": codes, "hashed": hashed}
    return {"error": f"unknown kind {kind}"}


def _discord_create(body: dict) -> dict:
    from .discord_api import DiscordSetup

    ds = DiscordSetup(body.get("bot_token", ""), body.get("guild", ""))
    results: dict[str, str] = {}
    errors: dict[str, str] = {}
    for item in body.get("channels", []):
        env, channel = item.get("env"), item.get("channel")
        try:
            results[env] = ds.ensure(channel)
        except Exception as e:
            errors[env] = str(e)
    return {"results": results, "errors": errors}


def serve(dry_run: bool = False, open_browser: bool = True) -> None:
    installer = WebInstaller(dry_run=dry_run)
    token = _secrets.token_urlsafe(32)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(installer, token))
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/?t={token}"
    print("\n  Local installer running — open this in your browser:\n")
    print(f"    {url}\n")
    print("  (Bound to localhost only. Ctrl+C here to stop.)\n")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        print("\n  Installer stopped.")


_PAGE_HTML = r"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TradingBot Installer</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
background:#0b0f14;color:#cfe3d8}main{max-width:760px;margin:0 auto;padding:24px}
h1{font-size:18px;color:#7fe3b0}h2{font-size:15px;color:#7fe3b0;border-bottom:1px solid #1d2a25;padding-bottom:6px}
.step{display:none}.step.on{display:block}label{display:block;margin:10px 0 4px;color:#9fb8ac}
input[type=text],input[type=password]{width:100%;padding:8px;background:#0f151b;border:1px solid #25342d;
color:#dff;border-radius:4px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{padding:8px 14px;background:#15392a;color:#7fe3b0;border:1px solid #2c6b4f;border-radius:4px;
cursor:pointer;margin-top:12px}button:hover{background:#1c4d39}button.sec{background:#16202a;color:#9fb8ac;border-color:#2a3a44}
.acct{border:1px solid #1d2a25;border-radius:6px;padding:10px;margin:8px 0}.muted{color:#6f867c;font-size:12px}
.tag{font-size:11px;padding:1px 6px;border-radius:3px;background:#3a1f1f;color:#f3b0b0;margin-left:6px}
.ok{color:#7fe3b0}.err{color:#f08c8c}.warn{color:#e3c77f}.log{background:#070a0d;border:1px solid #1d2a25;
border-radius:6px;padding:12px;height:280px;overflow:auto;white-space:pre-wrap;font-size:12.5px}
.pill{font-size:11px;color:#6f867c}a{color:#7fe3b0}.note{background:#10211a;border-left:3px solid #2c6b4f;
padding:8px 12px;margin:10px 0;font-size:12.5px;color:#9fb8ac}</style></head><body><main>
<h1>TradingBot setup</h1>
<p class="muted">Local-only. It cannot create the third-party accounts — make those
first (see instructions.md), then paste keys here. Nothing leaves this machine
except the API calls you authorize at the end.</p>
<div id="s0" class="step on"><h2>1 · Your fork</h2>
<label>GitHub fork (OWNER/REPO)</label><input id="owner_repo" type="text">
<div class="note">Auto-detected from <code>git remote</code> when possible.</div>
<button onclick="next(0)">Continue</button></div>

<div id="s1" class="step"><h2>2 · Accounts</h2><div id="accts"></div>
<label class="row"><input type="checkbox" id="congress"> Enable the (conservative-only) congress copier</label>
<label class="row"><input type="checkbox" id="dash" checked> Set up the Vercel dashboard</label>
<label class="row"><input type="checkbox" id="reset" checked> Reset inherited bot memory (recommended on a fresh fork)</label>
<label class="row"><input type="checkbox" id="autopush" checked> Auto-commit &amp; push the rewritten files to my fork</label>
<button class="sec" onclick="prev(1)">Back</button><button onclick="next(1)">Continue</button></div>

<div id="s2" class="step"><h2>3 · Alpaca keys</h2><div id="alpaca"></div>
<button class="sec" onclick="prev(2)">Back</button><button onclick="next(2)">Continue</button></div>

<div id="s3" class="step"><h2>4 · Discord</h2>
<p class="muted">Paste a webhook URL per channel, or auto-create them with a bot token.</p>
<label class="row"><input type="checkbox" id="dauto"> Auto-create via Discord bot</label>
<div id="dbot" style="display:none"><label>Bot token</label><input id="dbot_token" type="password">
<label>Server (guild) ID</label><input id="dguild" type="text"></div>
<div id="dwh"></div>
<button class="sec" onclick="prev(3)">Back</button>
<button class="sec" id="dgo" style="display:none" onclick="discordCreate()">Create channels</button>
<button onclick="next(3)">Continue</button></div>

<div id="s4" class="step"><h2>5 · Tokens</h2><div id="globals"></div>
<button class="sec" onclick="prev(4)">Back</button><button onclick="next(4)">Continue</button></div>

<div id="s5" class="step"><h2>6 · Dashboard secrets</h2><div id="dashsec"></div>
<button class="sec" onclick="prev(5)">Back</button><button onclick="next(5)">Continue</button></div>

<div id="s6" class="step"><h2>7 · Review & apply</h2>
<label class="row"><input type="checkbox" id="dry"> Dry run (preview only — write/push nothing)</label>
<div id="review" class="log" style="height:180px"></div>
<button class="sec" onclick="prev(6)">Back</button><button onclick="apply()">Apply</button></div>

<div id="s7" class="step"><h2>8 · Progress</h2><div id="plog" class="log"></div>
<div class="row"><a id="dashlink" target="_blank"></a></div>
<button class="sec" onclick="show(6)">Re-run Apply</button>
<button onclick="quit()">Finish &amp; stop server</button></div>

<script>
const T="__TOKEN__";const H={'X-Installer-Token':T,'Content-Type':'application/json'};
let S={},cfg={bot_env:{},dash_env:{}};
const $=id=>document.getElementById(id);
async function gj(u){return (await fetch(u,{headers:H})).json()}
async function pj(u,b){return (await fetch(u,{method:'POST',headers:H,body:JSON.stringify(b)})).json()}
function show(n){for(let i=0;i<8;i++)$('s'+i).classList.toggle('on',i===n)}
function prev(n){show(n-1)}
init();
async function init(){
 S=await gj('/api/init');$('owner_repo').value=S.owner_repo||'';
 // NOTE: bot (.env) + dashboard (.env) key namespaces merged into one Set;
 // safe only while GLOBAL_SECRETS and DASHBOARD_SECRETS names stay disjoint.
 window.HAVE=new Set([...(S.existing_env_keys||[]),...(S.existing_dash_keys||[])]);
 let a=$('accts');S.accounts.forEach(x=>{a.insertAdjacentHTML('beforeend',
  `<div class="acct"><label class="row"><input type="checkbox" class="mode" value="${x.mode}"
   ${x.mode==='conservative'?'checked':''}> <b>${x.label}</b>
   ${x.is_real?'<span class="tag">REAL MONEY</span>':''}</label></div>`)});
 $('dash').onchange=()=>{};
}
function chosen(){return [...document.querySelectorAll('.mode:checked')].map(e=>e.value)}
function next(n){
 if(n===0){cfg.owner_repo=$('owner_repo').value.trim();if(!cfg.owner_repo)return alert('Fork required');}
 if(n===1){cfg.modes=chosen();if(!cfg.modes.length)return alert('Pick at least one account');
   cfg.include_congress=$('congress').checked;cfg.do_dashboard=$('dash').checked;
   cfg.reset_state=$('reset').checked;cfg.auto_push=$('autopush').checked;buildAlpaca();}
 if(n===2){if(!grabAlpaca())return;buildDiscord();}
 if(n===3){grabDiscord();buildGlobals();}
 if(n===4){grabGlobals();if(cfg.do_dashboard){buildDash();}else{show(6);buildReview();return;}}
 if(n===5){grabDash();buildReview();show(6);return;}
 show(n+1);
}
function buildAlpaca(){let h='';S.accounts.filter(a=>cfg.modes.includes(a.mode)).forEach(a=>{
 let set=HAVE.has(a.key_env)&&HAVE.has(a.secret_env);
 h+=`<div class="acct"><b>${a.label}</b>${a.is_real?' <span class="tag">REAL MONEY</span>':''}
 ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
 <label>${a.key_env}</label><input type="password" data-k="${a.key_env}">
 <label>${a.secret_env}</label><input type="password" data-k="${a.secret_env}">
 <label>${a.url_env}</label><input type="text" data-k="${a.url_env}" value="${a.default_url}">
 <button class="sec" onclick="testAlpaca(this,'${a.key_env}','${a.secret_env}','${a.url_env}')">Test</button>
 <span class="pill" data-t="${a.key_env}"></span></div>`});$('alpaca').innerHTML=h;}
function grabAlpaca(){document.querySelectorAll('#alpaca input').forEach(i=>{if(i.value.trim())cfg.bot_env[i.dataset.k]=i.value.trim();});
 for(const a of S.accounts.filter(a=>cfg.modes.includes(a.mode))){
  let have=(cfg.bot_env[a.key_env]&&cfg.bot_env[a.secret_env])||(HAVE.has(a.key_env)&&HAVE.has(a.secret_env));
  if(!have){alert('Fill keys for '+a.mode+' (none on file yet)');return false}}return true;}
async function testAlpaca(btn,k,s,u){let g=q=>document.querySelector(`#alpaca input[data-k="${q}"]`).value.trim();
 let sp=btn.nextElementSibling;sp.textContent='…';let r=await pj('/api/validate/alpaca',{key:g(k),secret:g(s),url:g(u)});
 sp.textContent=r.msg;sp.className='pill '+(r.ok?'ok':'err');}
function webhookList(){let L=[];S.accounts.filter(a=>cfg.modes.includes(a.mode)).forEach(a=>{
 for(const[env,ch]of Object.entries(a.webhooks)){if(env===S.congress_env&&!cfg.include_congress)continue;L.push([env,ch]);}});return L;}
function buildDiscord(){let h='';webhookList().forEach(([env,ch])=>{
 h+=`<label>${env} <span class="muted">#${ch}</span></label>
 <input type="text" data-w="${env}" placeholder="https://discord.com/api/webhooks/...">`});$('dwh').innerHTML=h;
 $('dauto').onchange=e=>{$('dbot').style.display=e.target.checked?'block':'none';
  $('dgo').style.display=e.target.checked?'inline-block':'none';};}
async function discordCreate(){let ch=webhookList().map(([env,channel])=>({env,channel}));
 let r=await pj('/api/discord',{bot_token:$('dbot_token').value,guild:$('dguild').value.trim(),channels:ch});
 for(const[env,u]of Object.entries(r.results||{})){let i=document.querySelector(`[data-w="${env}"]`);if(i)i.value=u;}
 let e=Object.entries(r.errors||{});alert(e.length?('Some failed:\n'+e.map(x=>x[0]+': '+x[1]).join('\n')):'Channels created.');}
function grabDiscord(){document.querySelectorAll('[data-w]').forEach(i=>{if(i.value.trim())cfg.bot_env[i.dataset.w]=i.value.trim();});}
function buildGlobals(){let h='';S.global_secrets.forEach(g=>{
 let set=HAVE.has(g.name),gen=g.kind==='generate';
 h+=`<label>${g.name} <span class="muted">${g.desc}</span></label>
 ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
 <div class="row"><input type="password" data-g="${g.name}" style="flex:1">
 ${gen?`<button class="sec" onclick="genInto(this,'${g.name}')">${set?'Regenerate (replaces existing)':'Generate'}</button>`:''}</div>`});
 $('globals').innerHTML=h;}
function grabGlobals(){document.querySelectorAll('[data-g]').forEach(i=>{if(i.value.trim())cfg.bot_env[i.dataset.g]=i.value.trim();});}
async function genInto(btn,name){let r=await pj('/api/generate',{kind:'token'});
 btn.parentElement.querySelector('input').value=r.value;}
function buildDash(){let h='';S.dashboard_secrets.forEach(g=>{
 if(g.kind==='totp'){let set=HAVE.has(g.name);h+=`<label>${g.name} <span class="muted">${g.desc}</span></label>
  ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
  <div class="row"><input type="text" data-d="TOTP_SECRET" style="flex:1">
  <button class="sec" onclick="genTotp(this)">${set?'Regenerate (replaces existing)':'Generate'}</button></div><div class="muted" id="otpa"></div>`;}
 else if(g.kind==='backup'){let set=HAVE.has(g.name);h+=`<label>${g.name} <span class="muted">${g.desc}</span></label>
  ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
  <div class="row"><input type="text" data-d="BACKUP_CODES_HASHED" style="flex:1">
  <button class="sec" onclick="genBackup(this)">${set?'Regenerate (replaces existing)':'Generate'}</button></div><div class="muted" id="bcodes"></div>`;}
 else{let gen=g.kind==='generate',set=HAVE.has(g.name);h+=`<label>${g.name} <span class="muted">${g.desc}</span></label>
  ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
  <div class="row"><input type="password" data-d="${g.name}" style="flex:1">
  ${gen?`<button class="sec" onclick="genInto2(this,'${g.name}')">${set?'Regenerate (replaces existing)':'Generate'}</button>`:''}</div>`;}});
 h+=`<div class="note">BOT_PUSH_TOKEN / CRON_TOKEN are auto-shared with the bot side.</div>`;
 $('dashsec').innerHTML=h;
 // share the two tokens that must match the bot side
 setD('BOT_PUSH_TOKEN',cfg.bot_env['BOT_PUSH_TOKEN']||'');
 setD('CRON_TOKEN',cfg.bot_env['DASHBOARD_CRON_TOKEN']||'');}
function setD(n,v){let i=document.querySelector(`[data-d="${n}"]`);if(i)i.value=v;}
async function genInto2(b,n){let r=await pj('/api/generate',{kind:'token'});b.parentElement.querySelector('input').value=r.value;}
async function genTotp(b){let r=await pj('/api/generate',{kind:'totp'});b.parentElement.querySelector('input').value=r.secret;
 $('otpa').textContent='otpauth: '+r.otpauth;}
async function genBackup(b){let r=await pj('/api/generate',{kind:'backup'});
 if(!r.codes){$('bcodes').innerHTML='<span class="warn">Needs Node/npx — generate later.</span>';return;}
 b.parentElement.querySelector('input').value=r.hashed;
 $('bcodes').innerHTML='<b class="warn">Write these down (shown once):</b><br>'+r.codes.join('<br>');}
function grabDash(){document.querySelectorAll('[data-d]').forEach(i=>{if(i.value.trim())cfg.dash_env[i.dataset.d]=i.value.trim();});}
function buildReview(){let m=v=>!v?'(empty)':v.length<=8?'*'.repeat(v.length):v.slice(0,4)+'…'+v.slice(-4);
 let tag=(k,v)=>v?(' = '+m(v)+'  [will write]'):(HAVE.has(k)?'  [unchanged (kept)]':' = (empty)');
 let L=['fork: '+cfg.owner_repo,'accounts: '+cfg.modes.join(', '),
  'congress: '+cfg.include_congress,'dashboard: '+cfg.do_dashboard,
  'reset bot memory: '+cfg.reset_state,'auto-push to fork: '+cfg.auto_push,
  '','.env keys:'];
 let bk=new Set([...Object.keys(cfg.bot_env),...(S.existing_env_keys||[])]);
 [...bk].sort().forEach(k=>L.push('  '+k+tag(k,cfg.bot_env[k])));
 if(cfg.do_dashboard){L.push('','dashboard/.env keys:');
  let dk=new Set([...Object.keys(cfg.dash_env),...(S.existing_dash_keys||[])]);
  [...dk].sort().forEach(k=>L.push('  '+k+tag(k,cfg.dash_env[k])));}
 $('review').textContent=L.join('\n');}
async function apply(){cfg.dry_run=$('dry').checked;$('plog').textContent='';let dl=$('dashlink');dl.href='';dl.textContent='';show(7);await pj('/api/apply',cfg);poll();}
async function poll(){let r=await gj('/api/progress');
 $('plog').textContent=r.lines.map(l=>({ok:'✓ ',error:'✗ ',warn:'! ',info:'  '}[l.level]||'  ')+l.msg).join('\n');
 $('plog').scrollTop=$('plog').scrollHeight;
 if(r.dashboard_url){let a=$('dashlink');a.href=r.dashboard_url;a.textContent='Open dashboard: '+r.dashboard_url;}
 if(!r.done)setTimeout(poll,1200);}
async function quit(){await pj('/api/quit',{});document.body.innerHTML='<main><h1>Stopped. You can close this tab.</h1></main>';}
</script></main></body></html>"""
