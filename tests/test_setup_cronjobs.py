"""cron-job.org scheduler resilience — backoff math + exit classification."""
import importlib

sc = importlib.import_module("tools.setup_cronjobs")


def test_backoff_grows_capped_and_jittered():
    waits = [sc.compute_backoff(a) for a in range(8)]
    assert waits[0] >= 2.0 and waits[0] <= 4
    assert waits[3] >= waits[1]            # grows
    assert all(w <= sc.BACKOFF_CAP + 2 for w in waits)  # capped (+jitter)


def test_backoff_honors_retry_after():
    assert sc.compute_backoff(0, retry_after="30") == 30.0
    assert sc.compute_backoff(0, retry_after="not-a-number") >= 2.0


def test_exit_code_partial_is_75_only_for_rate_limit():
    assert sc.exit_code_for([]) == 0
    assert sc.exit_code_for([("Job A", "ratelimit")]) == 75
    assert sc.exit_code_for([("Job B", "hard")]) == 1
    assert sc.exit_code_for([("A", "ratelimit"), ("B", "hard")]) == 1


def test_retries_count_is_generous():
    assert sc.RETRIES >= 6
