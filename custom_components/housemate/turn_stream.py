"""The Housemate turn API's NDJSON events as chat-log deltas. No Home Assistant imports, so it tests alone.

The Voice Loop runs the whole turn and makes the reply audio itself; HA only has to start its TTS
stream as soon as the first words exist, because HA's TTS request is how that audio reaches the
satellite (Housemate's TTS server hands back the turn's own audio for those words).

HA streams TTS without waiting for the whole reply once a reply has text followed by a tool call
(``assist_pipeline`` ``chat_log_delta_listener``), and a streamed reply skips HA's TTS cache, which
would otherwise answer a repeated sentence with old audio. So the first words are followed by one
external tool call that HA never runs, and its empty result.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterable, AsyncIterator, Callable
from typing import Any

SPEAKING_TOOL = "housemate_speaking"


def parse_line(raw: bytes | str) -> dict | None:
    line = raw.decode() if isinstance(raw, bytes) else raw
    line = line.strip()
    if not line:
        return None
    event = json.loads(line)
    return event if isinstance(event, dict) else None


def remaining_text(full: str, first: str) -> str:
    """The reply after the words already streamed."""
    full = " ".join(str(full or "").split())
    first = " ".join(str(first or "").split())
    if not first:
        return full
    return full[len(first):].strip() if full.startswith(first) else ""


async def turn_deltas(
    lines: AsyncIterable[bytes | str],
    done: dict[str, Any],
    tool_call: Callable[[], Any],
    tool_result: Callable[[Any], dict],
) -> AsyncIterator[dict]:
    """Chat-log deltas for one turn; the final ``done`` event is copied into ``done``.

    ``tool_call`` makes the external ToolInput, ``tool_result`` its result delta.
    """
    first = ""
    async for raw in lines:
        event = parse_line(raw)
        if event is None:
            continue
        kind = event.get("event")
        if kind == "speech" and not first:
            first = " ".join(str(event.get("text") or "").split())
            if not first:
                continue
            call = tool_call()
            yield {"role": "assistant", "content": first}
            yield {"tool_calls": [call]}
            yield tool_result(call)
        elif kind == "done":
            done.update(event)
            rest = remaining_text(str(event.get("reply_text") or ""), first) if first else str(
                event.get("reply_text") or ""
            ).strip()
            if rest:
                yield {"role": "assistant", "content": rest}
            return
