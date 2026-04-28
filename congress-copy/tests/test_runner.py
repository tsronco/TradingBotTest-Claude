import sys
from unittest.mock import MagicMock, patch

import pytest


def test_runner_disclosures_subcommand_invokes_trader(paper_env):
    with patch("src.runner.Trader") as TraderClass, \
         patch("src.runner.Monitor") as MonitorClass, \
         patch("src.runner.AlpacaClient"), \
         patch("src.runner.State"), \
         patch("src.runner.scraper"):
        TraderClass.return_value.run_disclosure_cycle.return_value = {
            "new": 0, "ordered": 0, "skipped": 0, "circuit_broken": 0, "errors": 0,
        }
        from src import runner
        runner.main(["disclosures"])
        TraderClass.return_value.run_disclosure_cycle.assert_called_once()
        MonitorClass.return_value.run_monitor_cycle.assert_not_called()


def test_runner_monitor_subcommand_invokes_monitor(paper_env):
    with patch("src.runner.Trader") as TraderClass, \
         patch("src.runner.Monitor") as MonitorClass, \
         patch("src.runner.AlpacaClient"), \
         patch("src.runner.State"):
        MonitorClass.return_value.run_monitor_cycle.return_value = {
            "checked": 0, "stopped_out": 0, "skipped_market_closed": 0,
        }
        from src import runner
        runner.main(["monitor"])
        MonitorClass.return_value.run_monitor_cycle.assert_called_once()
        TraderClass.return_value.run_disclosure_cycle.assert_not_called()


def test_runner_unknown_subcommand_exits_nonzero(paper_env):
    from src import runner
    with pytest.raises(SystemExit) as exc:
        runner.main(["nonsense"])
    assert exc.value.code != 0
