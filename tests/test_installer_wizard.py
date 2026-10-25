"""Wizard behaviours that aren't part of the pure-logic modules.

Only the non-interactive surface is exercised here (write_env_files calls
print + envfile, no input()), so these stay deterministic.
"""
from tools.installer import wizard


def test_dry_run_write_env_files_writes_nothing(tmp_path, monkeypatch, capsys):
    env = tmp_path / ".env"
    dash = tmp_path / "dashboard" / ".env"
    monkeypatch.setattr(wizard, "ENV_PATH", env)
    monkeypatch.setattr(wizard, "DASH_ENV_PATH", dash)

    w = wizard.Wizard(dry_run=True)
    w.do_dashboard = True
    w.bot_env = {"ALPACA_API_KEY": "PKfake", "EMPTY": ""}
    w.dash_env = {"SESSION_SECRET": "deadbeef"}
    w.write_env_files()

    assert not env.exists()
    assert not dash.exists()
    out = capsys.readouterr().out
    assert "DRY-RUN, not written" in out
    assert "ALPACA_API_KEY" in out
    assert "PKfake" not in out  # secret is masked, never echoed raw


def test_real_write_env_files_writes_and_masks(tmp_path, monkeypatch, capsys):
    env = tmp_path / ".env"
    monkeypatch.setattr(wizard, "ENV_PATH", env)

    w = wizard.Wizard(dry_run=False)
    w.do_dashboard = False
    w.bot_env = {"ALPACA_API_KEY": "PKrealvalue1234"}
    w.write_env_files()

    assert env.exists()
    assert "ALPACA_API_KEY=PKrealvalue1234" in env.read_text()
    assert "PKrealvalue1234" not in capsys.readouterr().out  # console stays masked
