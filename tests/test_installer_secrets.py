"""Locally-minted secrets must be the right shape (and degrade gracefully)."""
import base64

from tools.installer import secrets_gen


def test_token_is_hex_and_right_length():
    t = secrets_gen.token(32)
    assert len(t) == 64
    int(t, 16)  # raises if not hex
    assert secrets_gen.token() != secrets_gen.token()


def test_totp_secret_is_valid_base32():
    s = secrets_gen.totp_secret()
    assert s == s.upper() and "=" not in s
    # decodable as base32 once padding is restored
    base64.b32decode(s + "=" * (-len(s) % 8))


def test_otpauth_uri_carries_secret_and_issuer():
    s = secrets_gen.totp_secret()
    uri = secrets_gen.otpauth_uri(s, issuer="TB")
    assert uri.startswith("otpauth://totp/")
    assert f"secret={s}" in uri and "issuer=TB" in uri


def test_generate_backup_codes_returns_none_when_script_missing(tmp_path):
    # tmp_path has no scripts/generate-backup-codes.ts
    assert secrets_gen.generate_backup_codes(tmp_path) is None
