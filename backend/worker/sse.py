"""SSE stream parser for ChatGPT responses."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional


@dataclass
class SseEvent:
    """A parsed SSE event from ChatGPT."""

    event_type: str = ""
    text: str = ""
    image_pointers: list[str] = field(default_factory=list)
    conversation_id: Optional[str] = None
    message_id: Optional[str] = None
    finish_reason: Optional[str] = None
    raw: Optional[dict] = None


def _extract_text_from_parts(parts: list) -> str:
    """Extract text content from message parts."""
    texts: list[str] = []
    for part in parts:
        if isinstance(part, str):
            texts.append(part)
    return "".join(texts)


def _extract_image_pointers(parts: list) -> list[str]:
    """Extract image asset pointers from message parts."""
    pointers: list[str] = []
    for part in parts:
        if isinstance(part, dict):
            if part.get("content_type") == "image_asset_pointer":
                pointer = part.get("asset_pointer", "")
                if pointer:
                    pointers.append(pointer)
    return pointers


def _parse_sse_line(line: bytes) -> Optional[dict]:
    """Parse a single SSE data line into a dict."""
    if not line.startswith(b"data: "):
        return None
    if line.startswith(b"data: [DONE]"):
        return None
    try:
        data = json.loads(line[6:])
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def _extract_finish_reason(data: dict) -> Optional[str]:
    """Extract finish reason from various locations in the SSE data."""
    v = data.get("v")
    if isinstance(v, list):
        for item in v:
            p = item.get("p", "")
            if p == "/message/metadata":
                metadata = item.get("v", {})
                return metadata.get("finish_details", {}).get("type")
    return None


def _extract_message_fields(data: dict) -> dict:
    """Extract conversation_id, message_id, recipient from SSE data."""
    result = {}
    # Check top-level conversation_id (newer format)
    if data.get("conversation_id"):
        result["conversation_id"] = data["conversation_id"]
    # Check nested in v (older format)
    v = data.get("v")
    if isinstance(v, dict):
        if v.get("conversation_id") and not result.get("conversation_id"):
            result["conversation_id"] = v["conversation_id"]
        msg = v.get("message", {})
        if msg.get("id"):
            result["message_id"] = msg["id"]
        if msg.get("recipient"):
            result["recipient"] = msg["recipient"]
    return result


async def parse_sse_stream(lines: AsyncIterator[bytes]) -> AsyncIterator[SseEvent]:
    """Parse an SSE stream from ChatGPT and yield structured events.

    Handles multiple SSE message formats:
    - Text delta: {"p": "/message/content/parts/0", "v": "text"}
    - Image: parts with content_type="image_asset_pointer"
    - Done: finish_reason in metadata
    """
    pattern = re.compile(r"file-service://[\w-]+")
    buffer = ""
    conversation_id: Optional[str] = None
    message_id: Optional[str] = None

    async for line in lines:
        # Also scan raw line for file-service pointers (early detection)
        raw_line = line.decode(errors="ignore")
        for match in pattern.finditer(raw_line):
            yield SseEvent(
                event_type="image_pointer",
                image_pointers=[match.group(0)],
                conversation_id=conversation_id,
            )

        data = _parse_sse_line(line)
        if data is None:
            continue

        # Check for errors
        if data.get("error"):
            yield SseEvent(
                event_type="error",
                text=str(data["error"]),
                raw=data,
            )
            return

        # Handle type field
        if data.get("type") == "title_generation":
            continue

        p = data.get("p", "")
        v = data.get("v")

        # Text delta
        if isinstance(v, str) and p in ("", "/message/content/parts/0"):
            if p == "/message/content/parts/0" or not p:
                buffer += v
                yield SseEvent(
                    event_type="text_delta",
                    text=v,
                    conversation_id=conversation_id,
                )

        # Dict value — full message or image
        elif isinstance(v, dict):
            fields = _extract_message_fields(data)
            if fields.get("conversation_id"):
                conversation_id = fields["conversation_id"]
            if fields.get("message_id"):
                message_id = fields["message_id"]

            msg = v.get("message", {})
            author = msg.get("author", {})
            content = msg.get("content", {})
            parts = content.get("parts", [])

            # Process assistant and tool messages (images often come from tool role)
            if parts and author.get("role") in ("assistant", "tool"):
                image_pointers = _extract_image_pointers(parts)
                if image_pointers:
                    yield SseEvent(
                        event_type="image",
                        image_pointers=image_pointers,
                        conversation_id=conversation_id,
                        message_id=message_id,
                        raw=data,
                    )

                text = _extract_text_from_parts(parts)
                if text:
                    yield SseEvent(
                        event_type="text_final",
                        text=text,
                        conversation_id=conversation_id,
                        raw=data,
                    )

        # List value — delta operations
        elif isinstance(v, list):
            for item in v:
                ip = item.get("p", "")
                iv = item.get("v")

                if ip == "/message/content/parts/0" and isinstance(iv, str):
                    buffer += iv
                    yield SseEvent(
                        event_type="text_delta",
                        text=iv,
                        conversation_id=conversation_id,
                    )

                elif ip == "/message/content/parts/0/asset_pointer" and isinstance(iv, str):
                    yield SseEvent(
                        event_type="image_pointer",
                        image_pointers=[iv],
                        conversation_id=conversation_id,
                    )

                elif ip == "/message/metadata":
                    metadata = iv if isinstance(iv, dict) else {}
                    finish = metadata.get("finish_details", {}).get("type")
                    if finish:
                        # Flush remaining text buffer
                        if buffer.strip():
                            yield SseEvent(
                                event_type="text",
                                text=buffer.strip(),
                                conversation_id=conversation_id,
                            )
                            buffer = ""
                        yield SseEvent(
                            event_type="done",
                            finish_reason=finish,
                            conversation_id=conversation_id,
                            message_id=message_id,
                        )

                elif ip == "/message/metadata/image_gen_title" and isinstance(iv, str):
                    yield SseEvent(
                        event_type="image_title",
                        text=iv,
                        conversation_id=conversation_id,
                    )

    # End of stream
    if buffer.strip():
        yield SseEvent(
            event_type="text",
            text=buffer.strip(),
            conversation_id=conversation_id,
        )
