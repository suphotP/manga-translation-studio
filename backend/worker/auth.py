"""Account JSON loader for ChatGPT auth credentials."""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

ACCOUNTS_DIR = Path(os.getenv("WORKER_ACCOUNTS_DIR", Path(__file__).parent / "accounts"))


@dataclass
class Account:
    """A single ChatGPT account with all auth data."""

    id: str
    api_key: str
    headers: dict[str, str]
    cookies: dict[str, str]
    proof_token: Optional[list] = None
    turnstile_token: Optional[str] = None
    expires: int = 0
    source_file: Optional[Path] = None

    # Runtime state
    busy_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    cooldown_until: float = 0.0

    @property
    def is_expired(self) -> bool:
        if not self.expires:
            return True
        return time.time() > self.expires - 300  # 5-min buffer

    @property
    def is_cooling_down(self) -> bool:
        return time.time() < self.cooldown_until

    def set_cooldown(self, seconds: float) -> None:
        self.cooldown_until = time.time() + seconds

    def record_success(self) -> None:
        self.success_count += 1
        self.cooldown_until = 0.0

    def record_failure(self) -> None:
        self.failure_count += 1

    def to_status(self) -> dict:
        return {
            "id": self.id,
            "expired": self.is_expired,
            "busy": self.busy_count,
            "cooling_down": self.is_cooling_down,
            "successes": self.success_count,
            "failures": self.failure_count,
            "source": self.source_file.name if self.source_file else None,
        }


def _decode_jwt_expiry(token: str) -> int:
    """Extract expiry timestamp from a JWT token."""
    try:
        payload = token.split(".")[1]
        padding = 4 - len(payload) % 4
        payload += "=" * padding
        data = json.loads(base64.b64decode(payload))
        return data.get("exp", 0)
    except Exception:
        return 0


def load_account(path: Path) -> Optional[Account]:
    """Load a single account JSON file."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"[auth] Failed to load {path.name}: {e}")
        return None

    api_key = data.get("api_key", "")
    headers = data.get("headers", {})
    cookies = data.get("cookies", {})
    expires = data.get("expires", 0)

    if not api_key:
        print(f"[auth] No api_key in {path.name}")
        return None

    if not expires:
        expires = _decode_jwt_expiry(api_key)

    return Account(
        id=path.stem,
        api_key=api_key,
        headers=headers,
        cookies=cookies,
        proof_token=data.get("proof_token"),
        turnstile_token=data.get("turnstile_token"),
        expires=expires,
        source_file=path,
    )


def load_accounts(directory: Optional[Path] = None) -> list[Account]:
    """Load all account JSON files from the accounts directory."""
    acc_dir = directory or ACCOUNTS_DIR
    if not acc_dir.exists():
        print(f"[auth] Accounts directory not found: {acc_dir}")
        return []

    accounts: list[Account] = []
    for path in sorted(acc_dir.glob("*.json")):
        account = load_account(path)
        if account:
            accounts.append(account)
            status = "expired" if account.is_expired else "valid"
            print(f"[auth] Loaded {account.id} ({status}, expires={account.expires})")

    print(f"[auth] {len(accounts)} account(s) loaded")
    return accounts
