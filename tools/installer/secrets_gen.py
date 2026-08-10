"""Generate the secrets the installer *can* mint locally.

- Plain shared secrets -> ``secrets.token_hex`` (no scheme to drift).
- TOTP secret -> RFC-4648 base32, the format otplib expects, plus an
  ``otpauth://`` URI the user can turn into a QR code.
- Backup codes -> delegated to the dashboard's own canonical generator
  (``dashboard/scripts/generate-backup-codes.ts``) so the hashing scheme can
  never diverge from what the dashboard validates against.
"""
from __future__ import annotations

import base64
import os
import re
import secrets
import subprocess
from pathlib import Path
from urllib.parse import quote


def token(nbytes: int = 32) -> str:
    """Hex secret for SESSION_SECRET, BOT_PUSH_TOKEN, CRON_TOKEN, etc."""
    return secrets.token_hex(nbytes)


def totp_secret() -> str:
    """20 random bytes -> 32-char unpadded base32 (a standard TOTP seed)."""
    return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")


def otpauth_uri(secret: str, label: str = "TradingBot Dashboard", issuer: str = "TradingBot") -> str:
    return (
        f"otpauth://totp/{quote(label)}"
        f"?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"
    )


def generate_backup_codes(dashboard_dir: Path) -> tuple[list[str], str] | None:
    """Run the dashboard's canonical generator.

    Returns ``(plain_codes, hashed_csv)`` or ``None`` if Node/npx is
    unavailable (backup codes are optional — TOTP still works without them).
    """
    script = dashboard_dir / "scripts" / "generate-backup-codes.ts"
    if not script.exists():
        return None
    try:
        proc = subprocess.run(
            ["npx", "tsx", "scripts/generate-backup-codes.ts"],
            cwd=dashboard_dir,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout
    m = re.search(r"BACKUP_CODES_HASHED=([^\s]+)", out)
    if not m:
        return None
    hashed = m.group(1)
    codes = re.findall(r"^\s*\d+\.\s+(\S+)", out, re.MULTILINE)
    return codes, hashed
