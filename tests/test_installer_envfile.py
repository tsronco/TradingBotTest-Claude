"""The .env merge must never destroy a user's existing secrets or layout."""
from tools.installer import envfile


def test_parse_ignores_comments_and_blanks():
    text = "# c\n\nA=1\n  B = two \n#X=skip\n"
    assert envfile.parse(text) == {"A": "1", "B": "two"}


def test_merge_replaces_in_place_preserving_everything_else():
    existing = "# header\nA=old\n\n# keep me\nB=keepme\n"
    out = envfile.merge(existing, {"A": "new"})
    assert "A=new" in out
    assert "B=keepme" in out
    assert "# header" in out and "# keep me" in out
    # B untouched, comments untouched, A line position preserved
    assert out.splitlines()[1] == "A=new"


def test_merge_appends_new_keys_under_header():
    out = envfile.merge("A=1\n", {"NEW": "val"})
    assert "A=1" in out
    assert "# === Added by setup.py ===" in out
    assert "NEW=val" in out


def test_merge_skips_empty_values_and_never_blanks_existing():
    existing = "SECRET=do-not-lose\n"
    out = envfile.merge(existing, {"SECRET": "", "OTHER": None})
    assert "SECRET=do-not-lose" in out
    assert "OTHER" not in out


def test_merge_is_idempotent():
    existing = "A=1\n"
    once = envfile.merge(existing, {"A": "2", "B": "3"})
    twice = envfile.merge(once, {"A": "2", "B": "3"})
    assert once == twice


def test_write_merged_creates_and_returns_written(tmp_path):
    p = tmp_path / ".env"
    written = envfile.write_merged(p, {"A": "1", "EMPTY": ""})
    assert written == {"A": "1"}
    assert "A=1" in p.read_text()


def test_write_merged_preserves_unrelated_lines(tmp_path):
    p = tmp_path / ".env"
    p.write_text("# mine\nKEEP=yes\nA=old\n")
    envfile.write_merged(p, {"A": "new"})
    body = p.read_text()
    assert "KEEP=yes" in body and "# mine" in body and "A=new" in body


def test_mask_hides_secret():
    assert envfile.mask("") == "(empty)"
    assert envfile.mask("short") == "*****"
    m = envfile.mask("abcdefghijklmnop")
    assert m.startswith("abcd") and "mnop" in m and "16 chars" in m
    assert "efghijkl" not in m  # the middle is never shown
