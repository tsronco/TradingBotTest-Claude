"""Bulk-push repository Actions secrets via the GitHub REST API.

GitHub requires each secret value be encrypted client-side with the repo's
public key using a libsodium **sealed box** (PyNaCl). PyNaCl is the one
dependency the rest of the installer doesn't need, so it's imported lazily
and ``MissingDependency`` is raised with an actionable message if absent.
"""
from __future__ import annotations

from base64 import b64encode

import requests

API = "https://api.github.com"


class MissingDependency(RuntimeError):
    pass


class GitHubError(RuntimeError):
    pass


def _require_nacl():
    try:
        from nacl import encoding, public  # type: ignore
    except ModuleNotFoundError as e:  # pragma: no cover - env-dependent
        raise MissingDependency(
            "PyNaCl is required to encrypt GitHub secrets.\n"
            "  Install it with:  pip install pynacl\n"
            "  (or:  pip install -r tools/installer/requirements.txt)"
        ) from e
    return encoding, public


def encrypt_secret(public_key_b64: str, value: str) -> str:
    """Sealed-box encrypt ``value`` for the repo public key (base64 out)."""
    encoding, public = _require_nacl()
    pk = public.PublicKey(public_key_b64.encode("ascii"), encoding.Base64Encoder())
    sealed = public.SealedBox(pk).encrypt(value.encode("utf-8"))
    return b64encode(sealed).decode("ascii")


class GitHubSecrets:
    def __init__(self, owner_repo: str, token: str, *, dry_run: bool = False):
        self.owner_repo = owner_repo
        self.dry_run = dry_run
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        self._pk: tuple[str, str] | None = None

    def _public_key(self) -> tuple[str, str]:
        if self._pk is None:
            r = requests.get(
                f"{API}/repos/{self.owner_repo}/actions/secrets/public-key",
                headers=self._headers,
                timeout=20,
            )
            if r.status_code == 404:
                raise GitHubError(
                    f"Repo '{self.owner_repo}' not found, or the token lacks "
                    "'Secrets: read/write' permission on it."
                )
            if r.status_code in (401, 403):
                raise GitHubError(
                    "GitHub token rejected. It needs fine-grained permissions "
                    "Secrets: Read and write on this repo (Contents + Actions too)."
                )
            r.raise_for_status()
            data = r.json()
            self._pk = (data["key"], data["key_id"])
        return self._pk

    def put_secret(self, name: str, value: str) -> str:
        """Create/update one secret. Returns a short status string."""
        if self.dry_run:
            return f"DRY-RUN would set {name}"
        key, key_id = self._public_key()
        r = requests.put(
            f"{API}/repos/{self.owner_repo}/actions/secrets/{name}",
            headers=self._headers,
            json={"encrypted_value": encrypt_secret(key, value), "key_id": key_id},
            timeout=20,
        )
        if r.status_code not in (201, 204):
            raise GitHubError(f"Setting secret {name} failed: HTTP {r.status_code} {r.text[:200]}")
        return f"set {name}"

    def enable_actions(self) -> str:
        """Flip on GitHub Actions for a fork (the 'enable workflows' button).

        Needs the token's *Administration: write* scope — a repo-settings
        change, distinct from Secrets/Actions. Raises GitHubError with an
        actionable fallback if the token lacks it so the caller can degrade
        to the one-click manual instruction instead of hard-failing.
        """
        if self.dry_run:
            return "DRY-RUN would enable GitHub Actions on the fork"
        r = requests.put(
            f"{API}/repos/{self.owner_repo}/actions/permissions",
            headers=self._headers,
            json={"enabled": True, "allowed_actions": "all"},
            timeout=20,
        )
        if r.status_code != 204:
            raise GitHubError(
                f"Couldn't auto-enable Actions (HTTP {r.status_code}). The PAT "
                "likely lacks 'Administration: read/write'. Enable it by hand: "
                "your fork → Actions tab → 'I understand, enable workflows'."
            )
        return "GitHub Actions enabled on the fork"


def is_workflow_scope_error(text: str) -> bool:
    """True if a git-push rejection is the fine-grained-PAT workflow-scope
    refusal (vs. generic auth/network failure)."""
    t = (text or "").lower()
    return "workflow" in t and ("scope" in t or "refusing to allow" in t)
