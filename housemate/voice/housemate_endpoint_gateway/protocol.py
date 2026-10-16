"""Versioned, bounded control messages for the assistant voice endpoints."""

from __future__ import annotations

import dataclasses
import json
import math
import re
import uuid
from collections.abc import Mapping, Sequence
from typing import Any


PROTOCOL_VERSION = 2
SUPPORTED_PROTOCOL_VERSIONS = (PROTOCOL_VERSION,)
MAX_CONTROL_FRAME_BYTES = 64 * 1024
MAX_ENDPOINT_ID_LENGTH = 36
MAX_HARDWARE_ID_LENGTH = 128
MAX_CONNECTION_ID_LENGTH = 36
MAX_FIRMWARE_COMPONENTS = 16
MAX_CAPABILITIES = 64
MAX_CAPABILITY_LENGTH = 96
MAX_FIRMWARE_VALUE_LENGTH = 128
MAX_AUTH_PROOF_LENGTH = 128
MAX_JSON_DEPTH = 8
MAX_JSON_NODES = 1024
MAX_WAKE_WORD_LENGTH = 64
MAX_PREROLL_MS = 3000
MAX_CANCEL_REASON_LENGTH = 64

_TOKEN_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]*$")
# The voice turn messages carry audio routing only: no action,
# entity, service or tool authority, and no speaker identity.
_ENDPOINT_MESSAGE_TYPES = frozenset({"endpoint_hello", "authenticate", "heartbeat", "turn_start", "turn_cancel"})
_FORBIDDEN_MESSAGE_TYPES = frozenset(
    {
        "action",
        "command",
        "entity_action",
        "execute",
        "ha_service",
        "service_call",
        "tool_call",
    }
)
_FORBIDDEN_AUTHORITY_FIELDS = frozenset(
    {
        "action",
        "command",
        "entity_id",
        "service",
        "service_call",
        "tool",
        "tool_call",
    }
)


class ProtocolError(ValueError):
    """Raised when an endpoint control frame violates the fleet contract."""


@dataclasses.dataclass(frozen=True, slots=True)
class EndpointHello:
    endpoint_id: str
    hardware_id: str
    protocol_versions: tuple[int, ...]
    firmware: dict[str, str]
    capabilities: tuple[str, ...]
    enrollment_public_value: str | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class AuthenticateRequest:
    endpoint_id: str
    credential_version: int
    connection_id: str
    challenge_id: str
    proof: str


@dataclasses.dataclass(frozen=True, slots=True)
class TurnStart:
    endpoint_id: str
    connection_id: str
    stream_id: str
    wake_word: str
    preroll_ms: int
    candidate: bool = False
    wake_score: float | None = None
    follow_up: bool = False


@dataclasses.dataclass(frozen=True, slots=True)
class TurnCancel:
    endpoint_id: str
    connection_id: str
    stream_id: str
    reason: str


@dataclasses.dataclass(frozen=True, slots=True)
class Heartbeat:
    endpoint_id: str
    connection_id: str
    sequence: int
    health: dict[str, str | int | float | bool | None]


def encode_control_frame(message: Mapping[str, Any]) -> bytes:
    if not isinstance(message, Mapping):
        raise ProtocolError("control message must be an object")
    try:
        encoded = json.dumps(
            dict(message),
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as err:
        raise ProtocolError(f"control message is not JSON serializable: {err}") from err
    if len(encoded) > MAX_CONTROL_FRAME_BYTES:
        raise ProtocolError("control frame exceeds byte limit")
    return encoded


def decode_control_frame(raw: bytes | bytearray | memoryview | str) -> dict[str, Any]:
    if isinstance(raw, str):
        encoded = raw.encode("utf-8")
    elif isinstance(raw, (bytes, bytearray, memoryview)):
        encoded = bytes(raw)
    else:
        raise ProtocolError("control frame must be UTF-8 text bytes")
    if not encoded:
        raise ProtocolError("control frame is empty")
    if len(encoded) > MAX_CONTROL_FRAME_BYTES:
        raise ProtocolError("control frame exceeds byte limit")
    try:
        value = json.loads(encoded.decode("utf-8"), parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as err:
        raise ProtocolError(f"control frame is not valid UTF-8 JSON: {err}") from err
    if not isinstance(value, dict):
        raise ProtocolError("control message must be an object")
    _validate_json_complexity(value)
    message_type = _required_token(value, "type", max_length=64)
    if message_type in _FORBIDDEN_MESSAGE_TYPES:
        raise ProtocolError("endpoint protocol does not permit action authority")
    if message_type not in _ENDPOINT_MESSAGE_TYPES:
        raise ProtocolError(f"unsupported endpoint message type: {message_type}")
    forbidden_fields = _FORBIDDEN_AUTHORITY_FIELDS.intersection(value)
    if forbidden_fields:
        raise ProtocolError("endpoint control message contains forbidden authority fields")
    return value


def parse_endpoint_hello(message: Mapping[str, Any]) -> EndpointHello:
    if _required_token(message, "type", max_length=64) != "endpoint_hello":
        raise ProtocolError("expected endpoint_hello")
    endpoint_id = canonical_uuid(_required_string(message, "endpoint_id", MAX_ENDPOINT_ID_LENGTH), "endpoint_id")
    hardware_id = _required_string(message, "hardware_id", MAX_HARDWARE_ID_LENGTH)
    if not hardware_id.isprintable():
        raise ProtocolError("hardware_id contains non-printable characters")
    versions = _bounded_int_sequence(
        message.get("protocol_versions"),
        "protocol_versions",
        maximum_items=8,
        minimum=1,
        maximum=65535,
    )
    if not versions:
        raise ProtocolError("protocol_versions must not be empty")
    firmware = _bounded_string_map(
        message.get("firmware"),
        "firmware",
        maximum_items=MAX_FIRMWARE_COMPONENTS,
        maximum_value_length=MAX_FIRMWARE_VALUE_LENGTH,
    )
    capabilities = _bounded_token_sequence(
        message.get("capabilities"),
        "capabilities",
        maximum_items=MAX_CAPABILITIES,
        maximum_item_length=MAX_CAPABILITY_LENGTH,
    )
    enrollment_public_value = _optional_string(message.get("enrollment_public_value"), 512)
    return EndpointHello(
        endpoint_id=endpoint_id,
        hardware_id=hardware_id,
        protocol_versions=tuple(sorted(set(versions), reverse=True)),
        firmware=firmware,
        capabilities=tuple(sorted(set(capabilities))),
        enrollment_public_value=enrollment_public_value,
    )


def parse_authenticate(message: Mapping[str, Any]) -> AuthenticateRequest:
    if _required_token(message, "type", max_length=64) != "authenticate":
        raise ProtocolError("expected authenticate")
    endpoint_id = canonical_uuid(_required_string(message, "endpoint_id", MAX_ENDPOINT_ID_LENGTH), "endpoint_id")
    connection_id = canonical_uuid(
        _required_string(message, "connection_id", MAX_CONNECTION_ID_LENGTH),
        "connection_id",
    )
    challenge_id = canonical_uuid(
        _required_string(message, "challenge_id", MAX_CONNECTION_ID_LENGTH),
        "challenge_id",
    )
    credential_version = _required_int(message, "credential_version", minimum=1, maximum=2_147_483_647)
    proof = _required_string(message, "proof", MAX_AUTH_PROOF_LENGTH).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", proof):
        raise ProtocolError("proof must be a lowercase SHA-256 HMAC hex digest")
    return AuthenticateRequest(
        endpoint_id=endpoint_id,
        credential_version=credential_version,
        connection_id=connection_id,
        challenge_id=challenge_id,
        proof=proof,
    )


def parse_heartbeat(message: Mapping[str, Any]) -> Heartbeat:
    if _required_token(message, "type", max_length=64) != "heartbeat":
        raise ProtocolError("expected heartbeat")
    endpoint_id = canonical_uuid(_required_string(message, "endpoint_id", MAX_ENDPOINT_ID_LENGTH), "endpoint_id")
    connection_id = canonical_uuid(
        _required_string(message, "connection_id", MAX_CONNECTION_ID_LENGTH),
        "connection_id",
    )
    sequence = _required_int(message, "sequence", minimum=0, maximum=9_223_372_036_854_775_807)
    health = _bounded_health_map(message.get("health"), "health", maximum_items=64)
    return Heartbeat(
        endpoint_id=endpoint_id,
        connection_id=connection_id,
        sequence=sequence,
        health=health,
    )


def parse_turn_start(message: Mapping[str, Any]) -> TurnStart:
    if _required_token(message, "type", max_length=64) != "turn_start":
        raise ProtocolError("expected turn_start")
    endpoint_id = canonical_uuid(_required_string(message, "endpoint_id", MAX_ENDPOINT_ID_LENGTH), "endpoint_id")
    connection_id = canonical_uuid(
        _required_string(message, "connection_id", MAX_CONNECTION_ID_LENGTH),
        "connection_id",
    )
    stream_id = canonical_uuid(_required_string(message, "stream_id", MAX_CONNECTION_ID_LENGTH), "stream_id")
    wake_word = _required_string(message, "wake_word", MAX_WAKE_WORD_LENGTH)
    if not wake_word.isprintable():
        raise ProtocolError("wake_word contains non-printable characters")
    preroll_ms = _required_int(message, "preroll_ms", minimum=0, maximum=MAX_PREROLL_MS)
    candidate = message.get("candidate", False)
    follow_up = message.get("follow_up", False)
    if not isinstance(candidate, bool) or not isinstance(follow_up, bool):
        raise ProtocolError("candidate and follow_up must be booleans")
    if candidate and follow_up:
        raise ProtocolError("a follow-up is not a possible wake")
    wake_score = message.get("wake_score")
    if wake_score is not None:
        if isinstance(wake_score, bool) or not isinstance(wake_score, (int, float)) or not 0.0 <= float(wake_score) <= 1.0:
            raise ProtocolError("wake_score must be a number from 0 to 1")
        wake_score = float(wake_score)
    return TurnStart(
        endpoint_id=endpoint_id,
        connection_id=connection_id,
        stream_id=stream_id,
        wake_word=wake_word,
        preroll_ms=preroll_ms,
        candidate=candidate,
        wake_score=wake_score,
        follow_up=follow_up,
    )


def parse_turn_cancel(message: Mapping[str, Any]) -> TurnCancel:
    if _required_token(message, "type", max_length=64) != "turn_cancel":
        raise ProtocolError("expected turn_cancel")
    endpoint_id = canonical_uuid(_required_string(message, "endpoint_id", MAX_ENDPOINT_ID_LENGTH), "endpoint_id")
    connection_id = canonical_uuid(
        _required_string(message, "connection_id", MAX_CONNECTION_ID_LENGTH),
        "connection_id",
    )
    stream_id = canonical_uuid(_required_string(message, "stream_id", MAX_CONNECTION_ID_LENGTH), "stream_id")
    reason = _required_token(message, "reason", max_length=MAX_CANCEL_REASON_LENGTH)
    return TurnCancel(endpoint_id=endpoint_id, connection_id=connection_id, stream_id=stream_id, reason=reason)


def negotiate_protocol(
    endpoint_versions: Sequence[int],
    gateway_versions: Sequence[int] = SUPPORTED_PROTOCOL_VERSIONS,
) -> int:
    endpoint = {
        int(version)
        for version in endpoint_versions
        if isinstance(version, int) and not isinstance(version, bool)
    }
    gateway = {
        int(version)
        for version in gateway_versions
        if isinstance(version, int) and not isinstance(version, bool)
    }
    common = endpoint & gateway
    if not common:
        raise ProtocolError("no compatible endpoint protocol version")
    return max(common)


def canonical_uuid(value: str, label: str) -> str:
    try:
        parsed = uuid.UUID(str(value))
    except (ValueError, AttributeError) as err:
        raise ProtocolError(f"{label} must be a UUID") from err
    canonical = str(parsed)
    if str(value).lower() != canonical:
        raise ProtocolError(f"{label} must use canonical UUID form")
    return canonical


def _required_string(message: Mapping[str, Any], key: str, max_length: int) -> str:
    value = message.get(key)
    if not isinstance(value, str):
        raise ProtocolError(f"{key} must be a string")
    normalized = value.strip()
    if not normalized:
        raise ProtocolError(f"{key} must not be empty")
    if len(normalized) > max_length:
        raise ProtocolError(f"{key} exceeds length limit")
    return normalized


def _optional_string(value: Any, max_length: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ProtocolError("optional value must be a string")
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > max_length:
        raise ProtocolError("optional value exceeds length limit")
    return normalized


def _required_token(message: Mapping[str, Any], key: str, max_length: int) -> str:
    value = _required_string(message, key, max_length).lower()
    if not _TOKEN_RE.fullmatch(value):
        raise ProtocolError(f"{key} must be a lowercase protocol token")
    return value


def _required_int(
    message: Mapping[str, Any],
    key: str,
    *,
    minimum: int,
    maximum: int,
) -> int:
    value = message.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ProtocolError(f"{key} must be an integer")
    if value < minimum or value > maximum:
        raise ProtocolError(f"{key} is outside its allowed range")
    return value


def _bounded_int_sequence(
    value: Any,
    label: str,
    *,
    maximum_items: int,
    minimum: int,
    maximum: int,
) -> list[int]:
    if not isinstance(value, list):
        raise ProtocolError(f"{label} must be an array")
    if len(value) > maximum_items:
        raise ProtocolError(f"{label} exceeds item limit")
    result: list[int] = []
    for item in value:
        if not isinstance(item, int) or isinstance(item, bool) or item < minimum or item > maximum:
            raise ProtocolError(f"{label} contains an invalid integer")
        result.append(item)
    return result


def _bounded_token_sequence(
    value: Any,
    label: str,
    *,
    maximum_items: int,
    maximum_item_length: int,
) -> list[str]:
    if not isinstance(value, list):
        raise ProtocolError(f"{label} must be an array")
    if len(value) > maximum_items:
        raise ProtocolError(f"{label} exceeds item limit")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ProtocolError(f"{label} contains a non-string item")
        normalized = item.strip().lower()
        if not normalized or len(normalized) > maximum_item_length or not _TOKEN_RE.fullmatch(normalized):
            raise ProtocolError(f"{label} contains an invalid token")
        result.append(normalized)
    return result


def _bounded_string_map(
    value: Any,
    label: str,
    *,
    maximum_items: int,
    maximum_value_length: int,
) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ProtocolError(f"{label} must be an object")
    if len(value) > maximum_items:
        raise ProtocolError(f"{label} exceeds item limit")
    result: dict[str, str] = {}
    for key, item in value.items():
        if (
            not isinstance(key, str)
            or len(key.strip()) > 64
            or not _TOKEN_RE.fullmatch(key.strip().lower())
        ):
            raise ProtocolError(f"{label} contains an invalid key")
        if not isinstance(item, str):
            raise ProtocolError(f"{label} contains a non-string value")
        normalized = item.strip()
        if not normalized or len(normalized) > maximum_value_length:
            raise ProtocolError(f"{label} contains an invalid value")
        result[key.strip().lower()] = normalized
    return result


def _bounded_health_map(
    value: Any,
    label: str,
    *,
    maximum_items: int,
) -> dict[str, str | int | float | bool | None]:
    if not isinstance(value, dict):
        raise ProtocolError(f"{label} must be an object")
    if len(value) > maximum_items:
        raise ProtocolError(f"{label} exceeds item limit")
    result: dict[str, str | int | float | bool | None] = {}
    for key, item in value.items():
        normalized_key = str(key).strip().lower() if isinstance(key, str) else ""
        if not normalized_key or len(normalized_key) > 64 or not _TOKEN_RE.fullmatch(normalized_key):
            raise ProtocolError(f"{label} contains an invalid key")
        if isinstance(item, str):
            normalized_item = item.strip()
            if len(normalized_item) > 128:
                raise ProtocolError(f"{label} contains an oversized string")
            result[normalized_key] = normalized_item
        elif isinstance(item, bool) or item is None:
            result[normalized_key] = item
        elif isinstance(item, int):
            if abs(item) > 9_223_372_036_854_775_807:
                raise ProtocolError(f"{label} contains an out-of-range integer")
            result[normalized_key] = item
        elif isinstance(item, float):
            if not math.isfinite(item):
                raise ProtocolError(f"{label} contains a non-finite number")
            result[normalized_key] = item
        else:
            raise ProtocolError(f"{label} contains a non-scalar value")
    return result


def _validate_json_complexity(value: Any) -> None:
    nodes = 0
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES:
            raise ProtocolError("control message exceeds structural node limit")
        if depth > MAX_JSON_DEPTH:
            raise ProtocolError("control message exceeds nesting limit")
        if isinstance(current, dict):
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)


def _reject_json_constant(value: str):
    raise ValueError(f"non-standard JSON constant is forbidden: {value}")
