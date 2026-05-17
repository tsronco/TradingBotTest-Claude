"""Fork-gotcha auto-fix: remote parsing + idempotent in-place rewrites."""
import pytest

from tools.installer import fork


@pytest.mark.parametrize("url,expected", [
    ("https://github.com/alice/TradingBotTest-Claude.git", "alice/TradingBotTest-Claude"),
    ("https://github.com/alice/TradingBotTest-Claude", "alice/TradingBotTest-Claude"),
    ("git@github.com:alice/TradingBotTest-Claude.git", "alice/TradingBotTest-Claude"),
    ("https://github.com/alice/repo/", "alice/repo"),
    ("http://local_proxy@127.0.0.1:43695/git/tsronco/TradingBotTest-Claude",
     "tsronco/TradingBotTest-Claude"),
    ("", None),
    ("not-a-url", None),
])
def test_parse_owner_repo(url, expected):
    assert fork.parse_owner_repo(url) == expected


def test_rewrite_repo_replaces_any_old_value_once():
    src = 'X=1\nREPO      = "tsronco/TradingBotTest-Claude"\nREPO = "other"\n'
    out = fork.rewrite_repo(src, "bob/fork")
    assert 'REPO      = "bob/fork"' in out
    # only the first assignment is rewritten (count=1)
    assert out.count('"bob/fork"') == 1
    assert 'REPO = "other"' in out


def test_rewrite_repo_idempotent():
    src = 'REPO = "tsronco/TradingBotTest-Claude"\n'
    once = fork.rewrite_repo(src, "bob/fork")
    assert fork.rewrite_repo(once, "bob/fork") == once


def test_rewrite_dashboard_url_replaces_all_and_is_safe_when_absent():
    src = (f"a {fork.ORIGINAL_DASHBOARD_URL}/api/x\n"
           f"b {fork.ORIGINAL_DASHBOARD_URL}/api/y\n")
    out = fork.rewrite_dashboard_url(src, "https://my.vercel.app/")
    assert fork.ORIGINAL_DASHBOARD_URL not in out
    assert out.count("https://my.vercel.app/api/") == 2
    # trailing slash trimmed; re-running with original absent is a no-op
    assert fork.rewrite_dashboard_url(out, "https://my.vercel.app") == out


def test_apply_rewrites_files_and_is_idempotent(tmp_path):
    (tmp_path / "tools").mkdir()
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    cron = tmp_path / "tools" / "setup_cronjobs.py"
    cron.write_text(
        'REPO      = "tsronco/TradingBotTest-Claude"\n'
        f'URL = "{fork.ORIGINAL_DASHBOARD_URL}/api/cron/x"\n'
    )
    wf = tmp_path / ".github" / "workflows" / "tsla-monitor.yml"
    wf.write_text(f"curl {fork.ORIGINAL_DASHBOARD_URL}/api/bot-state\n")

    changes = fork.apply(tmp_path, "bob/fork", "https://bob.vercel.app")
    assert any("setup_cronjobs.py" in c for c in changes)
    assert any("tsla-monitor.yml" in c for c in changes)
    assert 'REPO      = "bob/fork"' in cron.read_text()
    assert "https://bob.vercel.app/api/cron/x" in cron.read_text()
    assert "https://bob.vercel.app/api/bot-state" in wf.read_text()

    # second run: nothing left to change
    assert fork.apply(tmp_path, "bob/fork", "https://bob.vercel.app") == []


def test_apply_without_dashboard_url_only_touches_repo(tmp_path):
    (tmp_path / "tools").mkdir()
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    cron = tmp_path / "tools" / "setup_cronjobs.py"
    cron.write_text(f'REPO = "tsronco/TradingBotTest-Claude"\nU="{fork.ORIGINAL_DASHBOARD_URL}"\n')
    wf = tmp_path / ".github" / "workflows" / "a.yml"
    wf.write_text(f"{fork.ORIGINAL_DASHBOARD_URL}\n")

    fork.apply(tmp_path, "bob/fork", None)
    assert 'REPO = "bob/fork"' in cron.read_text()
    # URL left alone when no dashboard URL supplied
    assert fork.ORIGINAL_DASHBOARD_URL in wf.read_text()


def test_git_push_fork_uses_token_without_persisting(monkeypatch, tmp_path):
    from tools.installer import webapp

    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "setup_cronjobs.py").write_text("# x\n")
    calls = []

    def fake_run(args, **kw):
        calls.append(args)
        class R:
            returncode = 0
            stdout = "main" if args[:2] == ["git", "rev-parse"] else ""
            stderr = ""
        if args[1:4] == ["diff", "--cached", "--quiet"]:
            R.returncode = 1
        return R()

    monkeypatch.setattr(webapp.subprocess, "run", fake_run)
    inst = webapp.WebInstaller()
    inst._git_push_fork("bob/fork", "ghp_SECRET", dry=False)

    push = next(a for a in calls if "push" in a)
    joined = " ".join(push)
    assert "http.https://github.com/.extraheader=AUTHORIZATION: basic " in joined
    assert "ghp_SECRET" not in joined  # raw token never on argv
    assert not any(a[1:3] == ["remote", "set-url"] for a in calls)

    import base64 as _b64, re as _re
    _m = _re.search(r"AUTHORIZATION: basic (\S+)", joined)
    assert _m and _b64.b64decode(_m.group(1)).decode() == "x-access-token:ghp_SECRET"


def test_workflow_scope_error_is_classified():
    from tools.installer.github_api import is_workflow_scope_error

    rej = ("! [remote rejected] b -> b (refusing to allow a Personal Access "
           "Token to create or update workflow `.github/workflows/x.yml` "
           "without `workflow` scope)")
    assert is_workflow_scope_error(rej) is True
    assert is_workflow_scope_error("fatal: Authentication failed") is False


def test_push_failure_emits_workflow_remedy(monkeypatch, tmp_path):
    from tools.installer import webapp

    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "setup_cronjobs.py").write_text("# x\n")

    def fake_run(args, **kw):
        class R:
            returncode = 0
            stdout = "main" if args[:2] == ["git", "rev-parse"] else ""
            stderr = ""
        if args[1:4] == ["diff", "--cached", "--quiet"]:
            R.returncode = 1
        if "push" in args:
            R.returncode = 1
            R.stderr = ("refusing to allow a Personal Access Token to "
                        "create or update workflow `.github/workflows/x.yml` "
                        "without `workflow` scope")
        return R()

    monkeypatch.setattr(webapp.subprocess, "run", fake_run)
    inst = webapp.WebInstaller()
    inst._git_push_fork("bob/fork", "ghp_x", dry=False)
    msgs = " ".join(l["msg"] for l in inst.snapshot()["lines"])
    assert "Workflows: Read and write" in msgs
