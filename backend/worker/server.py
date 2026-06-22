"""FastAPI HTTP server for the ChatGPT worker."""

from __future__ import annotations

import asyncio
import base64
import os
import time
from contextlib import asynccontextmanager
from typing import Awaitable, Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .client import ChatGPTClient
from .pool import AccountPool

pool = AccountPool()
client = ChatGPTClient(timeout=360)
WORKER_REQUEST_TIMEOUT_SECONDS = float(os.getenv("WORKER_REQUEST_TIMEOUT_SECONDS", "360"))


@asynccontextmanager
async def lifespan(application: FastAPI):
    await pool.initialize()
    print(f"[server] Pool initialized: {pool.size} accounts")
    yield


app = FastAPI(title="ChatGPT Worker", version="1.0.0", lifespan=lifespan)


async def run_account_request(
    account,
    operation: Callable[[], Awaitable],
):
    try:
        return await asyncio.wait_for(operation(), timeout=WORKER_REQUEST_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        await pool.handle_result(account, error="timeout")
        raise HTTPException(504, "ChatGPT worker request timed out")
    except asyncio.CancelledError:
        await pool.release(account)
        raise
    except Exception as e:
        await pool.handle_result(account, error=str(e))
        raise HTTPException(500, f"ChatGPT error: {e}")


# ── Request models ────────────────────────────────────────────

class TranslateRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded image (PNG or WebP)")
    prompt: str = Field(..., description="Translation prompt")
    model: str = "gpt-5.5"

class CoverRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded source image")
    prompt: str = Field(..., description="Cover art prompt")
    model: str = "gpt-5.5"

class TextRequest(BaseModel):
    prompt: str = Field(..., description="Text prompt")
    model: str = "gpt-5.5"


# ── Routes ────────────────────────────────────────────────────

@app.post("/translate")
async def translate(req: TranslateRequest):
    """Translate an image using ChatGPT. Returns the result image as PNG."""
    account = await pool.acquire(timeout=300)
    if not account:
        raise HTTPException(503, "No available accounts")

    try:
        image_bytes = base64.b64decode(req.image_base64)
    except Exception:
        await pool.release(account)
        raise HTTPException(400, "Invalid base64 image data")

    t0 = time.time()
    result = await run_account_request(
        account,
        lambda: client.translate_image(account, image_bytes, req.prompt, req.model),
    )
    elapsed = time.time() - t0

    if result.error:
        await pool.handle_result(account, error=result.error)
        if result.error == "rate_limit":
            raise HTTPException(429, "Rate limited — retry later")
        elif result.error.startswith("auth_failed"):
            raise HTTPException(401, f"Auth failed: {result.error}")
        elif result.error == "service_unavailable":
            raise HTTPException(503, "ChatGPT service unavailable")
        else:
            raise HTTPException(502, f"ChatGPT error: {result.error}")

    await pool.handle_result(account)

    # Return image if we got one
    image_data = getattr(result, "_image_data", None)
    if image_data:
        return Response(
            content=image_data,
            media_type="image/png",
            headers={"X-Conversation-Id": result.conversation_id or ""},
        )

    # No image — return text response as JSON
    return JSONResponse({
        "text": result.text,
        "conversation_id": result.conversation_id,
        "finish_reason": result.finish_reason,
        "elapsed": round(elapsed, 1),
    })


@app.post("/cover")
async def cover(req: CoverRequest):
    """Generate cover art from an image. Returns the result image as PNG."""
    account = await pool.acquire(timeout=300)
    if not account:
        raise HTTPException(503, "No available accounts")

    try:
        image_bytes = base64.b64decode(req.image_base64)
    except Exception:
        await pool.release(account)
        raise HTTPException(400, "Invalid base64 image data")

    t0 = time.time()
    result = await run_account_request(
        account,
        lambda: client.translate_image(account, image_bytes, req.prompt, req.model),
    )
    elapsed = time.time() - t0

    if result.error:
        await pool.handle_result(account, error=result.error)
        raise HTTPException(502, f"ChatGPT error: {result.error}")

    await pool.handle_result(account)

    image_data = getattr(result, "_image_data", None)
    if image_data:
        return Response(
            content=image_data,
            media_type="image/png",
            headers={"X-Conversation-Id": result.conversation_id or ""},
        )

    return JSONResponse({
        "text": result.text,
        "conversation_id": result.conversation_id,
        "elapsed": round(elapsed, 1),
    })


@app.post("/text")
async def text(req: TextRequest):
    """Send a text-only request to ChatGPT."""
    account = await pool.acquire(timeout=300)
    if not account:
        raise HTTPException(503, "No available accounts")

    t0 = time.time()
    result = await run_account_request(
        account,
        lambda: client.send_text(account, req.prompt, req.model),
    )
    elapsed = time.time() - t0

    if result.error:
        await pool.handle_result(account, error=result.error)
        raise HTTPException(502, f"ChatGPT error: {result.error}")

    await pool.handle_result(account)

    return JSONResponse({
        "text": result.text,
        "conversation_id": result.conversation_id,
        "finish_reason": result.finish_reason,
        "elapsed": round(elapsed, 1),
    })


@app.get("/health")
async def health():
    """Health check endpoint."""
    status = pool.get_status()
    return {
        "ok": True,
        "accounts_total": status["total"],
        "accounts_available": status["available"],
    }


@app.get("/readyz")
async def readyz():
    """Readiness endpoint for container orchestration."""
    status = pool.get_status()
    return {
        "ok": True,
        "accounts_total": status["total"],
        "accounts_available": status["available"],
    }


@app.get("/accounts")
async def accounts():
    """Get account pool status."""
    return pool.get_status()


# ── Entry point ───────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "worker.server:app",
        host="0.0.0.0",
        port=8001,
        log_level="info",
    )
