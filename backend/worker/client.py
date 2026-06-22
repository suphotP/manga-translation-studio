"""ChatGPT HTTP client with browser impersonation, proof-of-work, and file upload."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from curl_cffi.requests import AsyncSession

from .auth import Account
from .sse import SseEvent, parse_sse_stream

CHATGPT_URL = "https://chatgpt.com"
CONVERSATION_URL = f"{CHATGPT_URL}/backend-api/f/conversation"
CHAT_REQUIREMENTS_URL = f"{CHATGPT_URL}/backend-api/sentinel/chat-requirements"
FILES_URL = f"{CHATGPT_URL}/backend-api/files"

DEFAULT_MODEL = "gpt-5.5"

DEFAULT_HEADERS = {
    "accept": "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.8",
    "content-type": "application/json",
    "referer": f"{CHATGPT_URL}/",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}

UPLOAD_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.8",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": DEFAULT_HEADERS["user-agent"],
}


def generate_proof_token(
    seed: str,
    difficulty: str,
    proof_token: Optional[list] = None,
    user_agent: Optional[str] = None,
) -> Optional[str]:
    if not seed or not difficulty:
        return None
    if proof_token is None:
        screen = random.choice([3008, 4010, 6000]) * random.choice([1, 2, 4])
        now_str = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime())
        proof_token = [
            screen, now_str, None, 0,
            user_agent or DEFAULT_HEADERS["user-agent"],
            "https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js",
            "dpl=1440a687921de39ff5ee56b92807faaadce73f13",
            "en", "en-US", None,
            "plugins−[object PluginArray]",
            random.choice(["_reactListeningcfilawjnerp", "_reactListening9ne2dfo1i47",
                          "_reactListening410nzwhan2a"]),
            random.choice(["alert", "ontransitionend", "onprogress"]),
        ]
    diff_len = len(difficulty)
    for i in range(100_000):
        proof_token[3] = i
        json_data = json.dumps(proof_token)
        encoded = base64.b64encode(json_data.encode()).decode()
        hash_hex = hashlib.sha3_512((seed + encoded).encode()).hexdigest()
        if hash_hex[:diff_len] <= difficulty:
            return "gAAAAAB" + encoded
    fallback = base64.b64encode(f'"{seed}"'.encode()).decode()
    return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallback


def generate_requirements_token(proof_token: list) -> str:
    diff = "0fffff"
    diff_len = len(diff)
    target = bytes.fromhex(diff)
    seed = format(random.random())
    seed_encoded = seed.encode()
    p1 = (json.dumps(proof_token[:3], separators=(",", ":"), ensure_ascii=False)[:-1] + ",").encode()
    p2 = ("," + json.dumps(proof_token[4:9], separators=(",", ":"), ensure_ascii=False)[1:-1] + ",").encode()
    p3 = ("," + json.dumps(proof_token[10:], separators=(",", ":"), ensure_ascii=False)[1:]).encode()
    for i in range(500_000):
        d1 = str(i).encode()
        d2 = str(i >> 1).encode()
        string = p1 + d1 + p2 + d2 + p3
        encoded = base64.b64encode(string)
        hash_val = hashlib.new("sha3_512", seed_encoded + encoded).digest()
        if hash_val[:diff_len] <= target:
            return "gAAAAAC" + encoded.decode()
    raise RuntimeError("Failed to solve requirements token challenge")


def _build_headers(account: Account) -> dict[str, str]:
    h = {**DEFAULT_HEADERS}
    h["authorization"] = f"Bearer {account.api_key}"
    for key in ("oai-device-id", "openai-sentinel-proof-token", "cookie"):
        if key in account.headers:
            h[key] = account.headers[key]
    if "cookie" not in h and account.cookies:
        h["cookie"] = "; ".join(f"{k}={v}" for k, v in account.cookies.items())
    return h


async def _upload_file(
    session: AsyncSession,
    headers: dict[str, str],
    image_bytes: bytes,
) -> Optional[dict]:
    """Upload an image to ChatGPT's file service (Azure blob storage).

    3-step process matching g4f's upload_files:
    1. POST /backend-api/files — get upload_url + file_id
    2. PUT upload_url — upload raw bytes to Azure
    3. POST /backend-api/files/{file_id}/uploaded — confirm, get download_url
    """
    file_size = len(image_bytes)

    # Detect image format and dimensions
    if image_bytes[:8] == b'\x89PNG\r\n\x1a\n':
        mime_type = "image/png"
        ext = ".png"
        width = int.from_bytes(image_bytes[16:20], 'big')
        height = int.from_bytes(image_bytes[20:24], 'big')
    elif image_bytes[:3] == b'\xff\xd8\xff':
        mime_type = "image/jpeg"
        ext = ".jpg"
        width, height = 0, 0  # JPEG dimension parsing is complex
    elif image_bytes[:4] == b'RIFF' and image_bytes[8:12] == b'WEBP':
        mime_type = "image/webp"
        ext = ".webp"
        width, height = 0, 0
    else:
        mime_type = "image/png"
        ext = ".png"
        width, height = 0, 0

    file_name = f"file-{file_size}{ext}"

    # Step 1: Create file entry
    create_data = {"file_name": file_name, "file_size": file_size, "use_case": "multimodal"}
    if width and height:
        create_data["height"] = height
        create_data["width"] = width

    create_resp = await session.post(
        FILES_URL,
        json=create_data,
        headers=headers,
        timeout=30,
    )
    if create_resp.status_code != 200:
        print(f"[upload] Create file failed: {create_resp.status_code} {create_resp.text[:200]}")
        return None

    file_data = create_resp.json()
    file_id = file_data.get("file_id", "")
    upload_url = file_data.get("upload_url", "")

    if not file_id or not upload_url:
        print(f"[upload] Missing file_id or upload_url: {file_data}")
        return None

    # Step 2: Upload to Azure blob storage
    await asyncio.sleep(1)
    upload_resp = await session.put(
        upload_url,
        data=image_bytes,
        headers={
            **UPLOAD_HEADERS,
            "Content-Type": mime_type,
            "x-ms-blob-type": "BlockBlob",
            "x-ms-version": "2020-04-08",
            "Origin": "https://chatgpt.com",
        },
        timeout=60,
    )
    if upload_resp.status_code not in (200, 201):
        print(f"[upload] Azure upload failed: {upload_resp.status_code}")
        return None

    # Step 3: Confirm upload
    confirm_resp = await session.post(
        f"{FILES_URL}/{file_id}/uploaded",
        json={},
        headers=headers,
        timeout=30,
    )
    if confirm_resp.status_code != 200:
        print(f"[upload] Confirm failed: {confirm_resp.status_code}")
        return None

    result = confirm_resp.json()
    return {
        "file_id": file_id,
        "file_name": file_name,
        "file_size": file_size,
        "mime_type": mime_type,
        "download_url": result.get("download_url", ""),
        "width": width,
        "height": height,
    }


@dataclass
class ChatResult:
    text: str = ""
    image_urls: list[str] = field(default_factory=list)
    conversation_id: Optional[str] = None
    finish_reason: Optional[str] = None
    error: Optional[str] = None


class ChatGPTClient:
    def __init__(self, timeout: int = 360):
        self.timeout = timeout

    async def _get_chat_requirements(
        self, session: AsyncSession, headers: dict[str, str], account: Account,
    ) -> dict:
        payload = {}
        if account.proof_token:
            try:
                payload["p"] = generate_requirements_token(account.proof_token)
            except RuntimeError:
                payload["p"] = None
        resp = await session.post(CHAT_REQUIREMENTS_URL, json=payload, headers=headers, timeout=30)
        if resp.status_code in (401, 403):
            raise PermissionError(f"Auth failed: {resp.status_code}")
        resp.raise_for_status()
        result = resp.json()
        return result if isinstance(result, dict) else {}

    async def _download_image(
        self, session: AsyncSession, headers: dict[str, str],
        asset_pointer: str, conversation_id: Optional[str] = None,
    ) -> Optional[bytes]:
        file_id = asset_pointer
        is_sediment = False
        if file_id.startswith("file-service://"):
            file_id = file_id[len("file-service://"):]
        elif file_id.startswith("sediment://"):
            file_id = file_id[len("sediment://"):]
            is_sediment = True
        print(f"[download] file_id={file_id}, sediment={is_sediment}, conv_id={conversation_id}")

        # sediment:// uses a different URL pattern
        if is_sediment and conversation_id:
            url = f"{CHATGPT_URL}/backend-api/files/download/{file_id}?conversation_id={conversation_id}&inline=false"
            resp = await session.get(url, headers=headers, timeout=60)
            print(f"[download] sediment GET -> {resp.status_code}, size={len(resp.content)}")
            if resp.status_code == 200:
                try:
                    data = resp.json()
                    download_url = data.get("download_url")
                    if download_url:
                        dl_resp = await session.get(download_url, headers=headers, timeout=60)
                        print(f"[download] CDN GET -> {dl_resp.status_code}, size={len(dl_resp.content)}")
                        if dl_resp.status_code == 200 and len(dl_resp.content) > 1000:
                            return dl_resp.content
                except (json.JSONDecodeError, AttributeError):
                    if len(resp.content) > 1000:
                        return resp.content

        # file-service:// pattern
        url = f"{CHATGPT_URL}/backend-api/files/{file_id}/download"
        resp = await session.get(url, headers=headers, timeout=60)
        if resp.status_code == 200:
            try:
                data = resp.json()
                download_url = data.get("download_url")
                if download_url:
                    dl_resp = await session.get(download_url, headers=headers, timeout=60)
                    if dl_resp.status_code == 200 and len(dl_resp.content) > 1000:
                        return dl_resp.content
            except (json.JSONDecodeError, AttributeError):
                pass

        # Last resort fallback
        if conversation_id and not is_sediment:
            url = (f"{CHATGPT_URL}/backend-api/files/download/{file_id}"
                   f"?conversation_id={conversation_id}&inline=false")
            resp = await session.get(url, headers=headers, timeout=60)
            if resp.status_code == 200:
                if len(resp.content) > 1000:
                    return resp.content
                try:
                    data = resp.json()
                    download_url = data.get("download_url")
                    if download_url:
                        dl_resp = await session.get(download_url, headers=headers, timeout=60)
                        if dl_resp.status_code == 200 and len(dl_resp.content) > 1000:
                            return dl_resp.content
                except (json.JSONDecodeError, AttributeError):
                    pass
        print(f"[download] FAILED to download image")
        return None

    async def _poll_conversation_for_image(
        self, session: AsyncSession, headers: dict[str, str],
        conversation_id: str, max_attempts: int = 80, interval: float = 3.0,
    ) -> Optional[bytes]:
        """Poll conversation API for image_asset_pointer (handles both assistant and tool roles)."""
        seen_assets: set[str] = set()
        url = f"{CHATGPT_URL}/backend-api/conversation/{conversation_id}"

        for attempt in range(max_attempts):
            await asyncio.sleep(interval)
            try:
                resp = await session.get(url, headers=headers, timeout=30)
                if resp.status_code != 200:
                    continue
                data = resp.json()
                if not isinstance(data, dict):
                    continue
                mapping = data.get("mapping", {})
                if not mapping:
                    continue

                for node in reversed(list(mapping.values())):
                    if not isinstance(node, dict):
                        continue
                    msg = node.get("message") or {}
                    if not isinstance(msg, dict):
                        continue
                    # Check BOTH assistant and tool roles for image pointers
                    author = msg.get("author") or {}
                    role = author.get("role", "") if isinstance(author, dict) else ""
                    if role not in ("assistant", "tool"):
                        continue
                    content = msg.get("content") or {}
                    if not isinstance(content, dict):
                        continue
                    parts = content.get("parts", [])
                    if not isinstance(parts, list):
                        continue
                    for part in parts:
                        if not isinstance(part, dict):
                            continue
                        if part.get("content_type") != "image_asset_pointer":
                            continue
                        asset = part.get("asset_pointer", "")
                        if not asset or asset in seen_assets:
                            continue
                        seen_assets.add(asset)
                        print(f"[poll] Found image: {asset}")
                        img_data = await self._download_image(session, headers, asset, conversation_id)
                        if img_data:
                            return img_data
                        print(f"[poll] Download failed for {asset}")

                # Check if last assistant message is finished
                for node in reversed(list(mapping.values())):
                    if not isinstance(node, dict):
                        continue
                    msg = node.get("message") or {}
                    if not isinstance(msg, dict):
                        continue
                    author = msg.get("author") or {}
                    role = author.get("role", "") if isinstance(author, dict) else ""
                    if role == "assistant":
                        status = msg.get("status", "")
                        if status == "finished_successfully" and attempt > 3:
                            print(f"[poll] Conversation finished at attempt {attempt+1}")
                            break
            except Exception as e:
                print(f"[poll] attempt {attempt+1} error: {e}")

        print("[poll] No image found after all attempts")
        return None

    def _build_image_message(self, prompt: str, file_info: dict) -> dict:
        """Build a message with uploaded file reference (g4f-style)."""
        file_id = file_info["file_id"]
        w = file_info.get("width", 0)
        h = file_info.get("height", 0)

        asset_part = {
            "asset_pointer": f"file-service://{file_id}",
            "size_bytes": file_info.get("file_size", 0),
        }
        if w:
            asset_part["width"] = w
        if h:
            asset_part["height"] = h

        attachment = {
            "id": file_id,
            "mimeType": file_info.get("mime_type", "image/png"),
            "name": file_info.get("file_name", "image.png"),
            "size": file_info.get("file_size", 0),
        }
        if w:
            attachment["width"] = w
        if h:
            attachment["height"] = h

        return {
            "id": str(uuid.uuid4()),
            "author": {"role": "user"},
            "content": {
                "content_type": "multimodal_text",
                "parts": [asset_part, prompt],
            },
            "metadata": {
                "attachments": [attachment],
            },
            "create_time": time.time(),
        }

    def _build_text_message(self, prompt: str) -> dict:
        return {
            "id": str(uuid.uuid4()),
            "author": {"role": "user"},
            "content": {"content_type": "text", "parts": [prompt]},
            "metadata": {"serialization_metadata": {"custom_symbol_offsets": []}},
            "create_time": time.time(),
        }

    async def translate_image(
        self, account: Account, image_bytes: bytes, prompt: str, model: str = DEFAULT_MODEL,
    ) -> ChatResult:
        return await self._send_request(account, prompt, image_bytes, model)

    async def send_text(
        self, account: Account, prompt: str, model: str = DEFAULT_MODEL,
    ) -> ChatResult:
        return await self._send_request(account, prompt, None, model)

    async def _send_request(
        self, account: Account, prompt: str,
        image_bytes: Optional[bytes], model: str,
    ) -> ChatResult:
        headers = _build_headers(account)
        result = ChatResult()

        async with AsyncSession(impersonate="chrome", timeout=self.timeout) as session:
            # Step 1: Visit chatgpt.com
            try:
                resp = await session.get(CHATGPT_URL, headers=headers, timeout=30)
                if resp.status_code in (401, 403):
                    return ChatResult(error=f"Auth failed on initial GET: {resp.status_code}")
            except Exception as e:
                return ChatResult(error=f"Failed to connect to ChatGPT: {e}")

            # Step 2: Upload image if present
            file_info: Optional[dict] = None
            if image_bytes:
                print(f"[client] Uploading image ({len(image_bytes)} bytes)...")
                file_info = await _upload_file(session, headers, image_bytes)
                if not file_info:
                    return ChatResult(error="Failed to upload image to ChatGPT")
                print(f"[client] Uploaded: file_id={file_info['file_id']}")

            # Step 3: Get chat requirements
            proof_of_work = None
            chat_token = ""
            try:
                req_data = await self._get_chat_requirements(session, headers, account)
                chat_token = req_data.get("token", "")
                if "proofofwork" in req_data:
                    pow_data = req_data["proofofwork"]
                    ua = headers.get("user-agent")
                    proof_of_work = generate_proof_token(
                        seed=pow_data.get("seed", ""),
                        difficulty=pow_data.get("difficulty", ""),
                        proof_token=account.proof_token,
                        user_agent=ua,
                    )
            except PermissionError as e:
                return ChatResult(error=str(e))
            except Exception as e:
                print(f"[client] chat-requirements failed (continuing): {e}")

            # Step 4: Build and send conversation request
            if file_info:
                message = self._build_image_message(prompt, file_info)
            else:
                message = self._build_text_message(prompt)

            body = {
                "action": "next",
                "parent_message_id": str(uuid.uuid4()),
                "messages": [message],
                "model": model,
                "timezone_offset_min": -420,
                "timezone": "Asia/Bangkok",
                "conversation_mode": {"kind": "primary_assistant"},
                "supports_buffering": True,
                "supported_encodings": ["v1"],
                "enable_message_followups": True,
            }

            conv_headers = {**headers, "accept": "text/event-stream", "content-type": "application/json"}
            if chat_token:
                conv_headers["openai-sentinel-chat-requirements-token"] = chat_token
            if proof_of_work:
                conv_headers["openai-sentinel-proof-token"] = proof_of_work
            if account.turnstile_token:
                conv_headers["openai-sentinel-turnstile-token"] = account.turnstile_token

            resp = await session.post(
                CONVERSATION_URL, json=body, headers=conv_headers,
                timeout=self.timeout, stream=True,
            )

            if resp.status_code == 429:
                return ChatResult(error="rate_limit")
            elif resp.status_code in (401, 403):
                return ChatResult(error=f"auth_failed:{resp.status_code}")
            elif resp.status_code == 503:
                return ChatResult(error="service_unavailable")
            elif resp.status_code != 200:
                body_text = resp.text[:500] if hasattr(resp, 'text') else ""
                return ChatResult(error=f"http_{resp.status_code}:{body_text}")

            # Step 5: Parse SSE stream
            collected_images: list[str] = []
            collected_text: list[str] = []
            conversation_id: Optional[str] = None
            finish_reason: Optional[str] = None

            async for event in parse_sse_stream(resp.aiter_lines()):
                if event.event_type in ("image_pointer", "image"):
                    for pointer in event.image_pointers:
                        if pointer not in collected_images:
                            collected_images.append(pointer)
                elif event.event_type == "text_delta":
                    collected_text.append(event.text)
                elif event.event_type == "text_final":
                    if not collected_text:
                        collected_text.append(event.text)
                elif event.event_type == "done":
                    finish_reason = event.finish_reason
                elif event.event_type == "error":
                    return ChatResult(error=event.text)
                if event.conversation_id:
                    conversation_id = event.conversation_id

            result.conversation_id = conversation_id
            result.finish_reason = finish_reason
            result.text = "".join(collected_text).strip()

            # Step 6: Download generated images from SSE pointers
            print(f"[client] collected_images={collected_images}, text={result.text[:200] if result.text else 'none'}")
            if collected_images:
                for pointer in collected_images:
                    try:
                        img_data = await self._download_image(session, headers, pointer, conversation_id)
                        if img_data:
                            result.image_urls.append(pointer)
                            result._image_data = img_data
                            break
                    except Exception as e:
                        print(f"[client] Download failed for {pointer}: {e}")

            # Step 7: Fallback — poll conversation API for image_asset_pointer
            # ChatGPT sometimes generates images asynchronously and the SSE stream
            # only contains text. Poll the conversation to find the image.
            if not result.image_urls and conversation_id:
                print(f"[poll] No images in SSE, polling conversation {conversation_id}")
                img_data = await self._poll_conversation_for_image(session, headers, conversation_id)
                if img_data:
                    result._image_data = img_data

            return result
