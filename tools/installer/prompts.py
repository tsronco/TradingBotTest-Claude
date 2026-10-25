"""Terminal prompt + pretty-print helpers for the wizard.

Deliberately tiny and dependency-free (stdlib only). Colour is auto-disabled
when stdout isn't a TTY or ``NO_COLOR`` is set.
"""
from __future__ import annotations

import os
import sys
from getpass import getpass

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def header(text: str) -> None:
    bar = "─" * min(len(text) + 2, 70)
    print(f"\n{_c('1;36', bar)}\n{_c('1;36', ' ' + text)}\n{_c('1;36', bar)}")


def info(text: str) -> None:
    print(f"  {text}")


def success(text: str) -> None:
    print(f"  {_c('1;32', '✓')} {text}")


def warn(text: str) -> None:
    print(f"  {_c('1;33', '!')} {text}")


def error(text: str) -> None:
    print(f"  {_c('1;31', '✗')} {text}")


def step(n: int, total: int, text: str) -> None:
    print(f"\n{_c('1;35', f'[{n}/{total}]')} {_c('1', text)}")


def ask(prompt: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        val = input(f"  {prompt}{suffix}: ").strip()
        if val:
            return val
        if default is not None:
            return default


def ask_secret(prompt: str) -> str:
    while True:
        val = getpass(f"  {prompt} (hidden): ").strip()
        if val:
            return val


def yes_no(prompt: str, default: bool = True) -> bool:
    d = "Y/n" if default else "y/N"
    while True:
        val = input(f"  {prompt} [{d}]: ").strip().lower()
        if not val:
            return default
        if val in ("y", "yes"):
            return True
        if val in ("n", "no"):
            return False


def choose_multi(prompt: str, options: list[tuple[str, str]], preselected: set[str]) -> list[str]:
    """Numbered toggle menu. ``options`` is [(key, label)]. Returns chosen keys."""
    chosen = set(preselected)
    while True:
        print(f"\n  {prompt}")
        for i, (key, label) in enumerate(options, 1):
            mark = "[x]" if key in chosen else "[ ]"
            print(f"    {i:>2}. {mark} {label}")
        raw = input("  Toggle numbers (comma-sep), 'a'=all, or Enter to confirm: ").strip().lower()
        if not raw:
            return [k for k, _ in options if k in chosen]
        if raw == "a":
            chosen = {k for k, _ in options}
            continue
        for tok in raw.replace(" ", "").split(","):
            if tok.isdigit() and 1 <= int(tok) <= len(options):
                key = options[int(tok) - 1][0]
                chosen.symmetric_difference_update({key})
