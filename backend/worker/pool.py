"""Multi-account pool manager for ChatGPT workers."""

from __future__ import annotations

import asyncio
import time
from typing import Optional

from .auth import Account, load_accounts


class AccountPool:
    """Manages a pool of ChatGPT accounts with load balancing and health tracking."""

    MAX_CONCURRENT_PER_ACCOUNT = 2
    COOLDOWN_429_SECONDS = 60.0

    def __init__(self, accounts: Optional[list[Account]] = None):
        self._accounts: list[Account] = accounts or []
        self._lock = asyncio.Lock()
        self._rr_index = 0

    async def initialize(self, directory=None) -> None:
        """Load accounts from disk."""
        accounts = load_accounts(directory)
        async with self._lock:
            self._accounts = accounts

    @property
    def size(self) -> int:
        return len(self._accounts)

    @property
    def available_count(self) -> int:
        return sum(1 for a in self._accounts if self._is_available(a))

    def _is_available(self, account: Account) -> bool:
        """Check if an account can accept a new request."""
        if account.is_expired:
            return False
        if account.is_cooling_down:
            return False
        if account.busy_count >= self.MAX_CONCURRENT_PER_ACCOUNT:
            return False
        return True

    async def acquire(self, timeout: float = 300.0) -> Optional[Account]:
        """Acquire the best available account. Blocks until one is free or timeout."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            async with self._lock:
                # First try: find available accounts
                available = [a for a in self._accounts if self._is_available(a)]
                if available:
                    # Least-busy selection
                    available.sort(key=lambda a: a.busy_count)
                    account = available[0]
                    account.busy_count += 1
                    return account

            # No account available — wait and retry
            await asyncio.sleep(1.0)

        return None

    async def release(self, account: Account) -> None:
        """Release an account back to the pool."""
        async with self._lock:
            account.busy_count = max(0, account.busy_count - 1)

    async def handle_result(self, account: Account, error: Optional[str] = None) -> None:
        """Handle a request result — update health and apply cooldowns."""
        async with self._lock:
            account.busy_count = max(0, account.busy_count - 1)

            if error is None:
                account.record_success()
            else:
                account.record_failure()
                if error == "rate_limit":
                    account.set_cooldown(self.COOLDOWN_429_SECONDS)
                    print(f"[pool] {account.id} rate limited — cooldown {self.COOLDOWN_429_SECONDS}s")
                elif error.startswith("auth_failed"):
                    print(f"[pool] {account.id} auth failed — marking expired")
                    # Force expiry so it won't be selected
                    account.expires = int(time.time()) - 1

    def get_status(self) -> dict:
        """Get pool status for all accounts."""
        return {
            "total": len(self._accounts),
            "available": self.available_count,
            "accounts": [a.to_status() for a in self._accounts],
        }
