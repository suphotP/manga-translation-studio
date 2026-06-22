"""Worker route tests for account release behavior."""

from __future__ import annotations

import asyncio
import time
import unittest
from types import SimpleNamespace

from fastapi import HTTPException

from . import server
from .auth import Account
from .pool import AccountPool
from .server import TextRequest


def make_account() -> Account:
    return Account(
        id="test-account",
        api_key="test-token",
        headers={},
        cookies={},
        expires=int(time.time()) + 3600,
    )


def text_result(error: str | None = None):
    return SimpleNamespace(
        error=error,
        text="ok",
        conversation_id="conversation-1",
        finish_reason="stop",
    )


class SuccessClient:
    async def send_text(self, account: Account, prompt: str, model: str):
        return text_result()


class ProviderErrorClient:
    async def send_text(self, account: Account, prompt: str, model: str):
        return text_result("service_unavailable")


class CancelledClient:
    async def send_text(self, account: Account, prompt: str, model: str):
        raise asyncio.CancelledError()


class SlowClient:
    async def send_text(self, account: Account, prompt: str, model: str):
        await asyncio.sleep(1)
        return text_result()


class WorkerServerAccountReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_pool = server.pool
        self.original_client = server.client
        self.original_timeout = server.WORKER_REQUEST_TIMEOUT_SECONDS
        self.account = make_account()
        server.pool = AccountPool([self.account])
        server.WORKER_REQUEST_TIMEOUT_SECONDS = 5

    async def asyncTearDown(self):
        server.pool = self.original_pool
        server.client = self.original_client
        server.WORKER_REQUEST_TIMEOUT_SECONDS = self.original_timeout

    async def test_success_releases_account_slot(self):
        server.client = SuccessClient()

        await server.text(TextRequest(prompt="hello"))

        self.assertEqual(self.account.busy_count, 0)
        self.assertEqual(self.account.success_count, 1)
        self.assertEqual(server.pool.available_count, 1)

    async def test_provider_error_releases_account_slot(self):
        server.client = ProviderErrorClient()

        with self.assertRaises(HTTPException) as error:
            await server.text(TextRequest(prompt="hello"))

        self.assertEqual(error.exception.status_code, 502)
        self.assertEqual(self.account.busy_count, 0)
        self.assertEqual(self.account.failure_count, 1)
        self.assertEqual(server.pool.available_count, 1)

    async def test_timeout_releases_account_slot(self):
        server.client = SlowClient()
        server.WORKER_REQUEST_TIMEOUT_SECONDS = 0.01

        with self.assertRaises(HTTPException) as error:
            await server.text(TextRequest(prompt="hello"))

        self.assertEqual(error.exception.status_code, 504)
        self.assertEqual(self.account.busy_count, 0)
        self.assertEqual(self.account.failure_count, 1)
        self.assertEqual(server.pool.available_count, 1)

    async def test_cancellation_releases_account_slot(self):
        server.client = CancelledClient()

        with self.assertRaises(asyncio.CancelledError):
            await server.text(TextRequest(prompt="hello"))

        self.assertEqual(self.account.busy_count, 0)
        self.assertEqual(self.account.success_count, 0)
        self.assertEqual(self.account.failure_count, 0)
        self.assertEqual(server.pool.available_count, 1)


if __name__ == "__main__":
    unittest.main()
