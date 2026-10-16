"""Persistent dynamic endpoint fleet registry."""

from __future__ import annotations

import dataclasses
import json
import os
import sqlite3
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .protocol import EndpointHello


SCHEMA_VERSION = 2
ENDPOINT_STATES = frozenset({"pending", "approved", "revoked", "replaced"})


class RegistryError(RuntimeError):
    """Raised when a fleet registry transition is invalid."""


@dataclasses.dataclass(frozen=True, slots=True)
class EndpointRecord:
    endpoint_id: str
    hardware_id: str
    state: str
    credential_version: int
    ha_device_id: str | None
    friendly_name: str | None
    area_id: str | None
    area_name: str | None
    protocol_version: int | None
    firmware: dict[str, str]
    capabilities: tuple[str, ...]
    health: dict[str, str | int | float | bool | None]
    enrollment_public_value: str | None
    first_seen_at: float
    last_seen_at: float
    last_ip: str | None
    last_disconnect_reason: str | None
    last_error_code: str | None
    connection_generation: int
    # Its Music Assistant player: the voice host is the brains, the endpoint plays.
    media_player: str | None = None


class FleetRegistry:
    """SQLite-backed registry with explicit endpoint lifecycle transitions."""

    def __init__(self, path: str | os.PathLike[str], *, clock: Callable[[], float] = time.time):
        self._path = str(path)
        self._clock = clock
        self._lock = threading.RLock()
        self._prepare_path()
        self._connection = sqlite3.connect(self._path, check_same_thread=False, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        if self._path != ":memory:":
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = NORMAL")
        self._migrate()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def __enter__(self) -> "FleetRegistry":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def observe_endpoint(
        self,
        hello: EndpointHello,
        *,
        protocol_version: int,
        peer_ip: str | None = None,
    ) -> EndpointRecord:
        now = float(self._clock())
        firmware_json = _compact_json(hello.firmware)
        capabilities_json = _compact_json(list(hello.capabilities))
        normalized_ip = _nullable_text(peer_ip, 128)
        with self._lock, self._transaction():
            existing = self._select(hello.endpoint_id)
            hardware_owner = self._connection.execute(
                "SELECT endpoint_id FROM endpoints WHERE hardware_id = ?",
                (hello.hardware_id,),
            ).fetchone()
            if hardware_owner is not None and hardware_owner["endpoint_id"] != hello.endpoint_id:
                raise RegistryError("hardware identity is already bound to another endpoint")
            if existing is None:
                self._connection.execute(
                    """
                    INSERT INTO endpoints (
                        endpoint_id, hardware_id, state, credential_version,
                        protocol_version, firmware_json, capabilities_json,
                        enrollment_public_value, first_seen_at, last_seen_at, last_ip
                    ) VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        hello.endpoint_id,
                        hello.hardware_id,
                        protocol_version,
                        firmware_json,
                        capabilities_json,
                        hello.enrollment_public_value,
                        now,
                        now,
                        normalized_ip,
                    ),
                )
            else:
                if existing.hardware_id != hello.hardware_id:
                    raise RegistryError("endpoint UUID was presented by different hardware")
                self._connection.execute(
                    """
                    UPDATE endpoints
                    SET protocol_version = ?, firmware_json = ?, capabilities_json = ?,
                        enrollment_public_value = ?, last_seen_at = ?, last_ip = ?
                    WHERE endpoint_id = ?
                    """,
                    (
                        protocol_version,
                        firmware_json,
                        capabilities_json,
                        hello.enrollment_public_value,
                        now,
                        normalized_ip,
                        hello.endpoint_id,
                    ),
                )
            return self._require(hello.endpoint_id)

    def approve(
        self,
        endpoint_id: str,
        *,
        friendly_name: str,
        area_id: str,
        area_name: str | None = None,
        ha_device_id: str | None = None,
    ) -> EndpointRecord:
        name = _required_text(friendly_name, "friendly_name", 128)
        normalized_area_id = _required_text(area_id, "area_id", 128)
        normalized_area_name = _nullable_text(area_name, 128)
        normalized_ha_device_id = _nullable_text(ha_device_id, 128)
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "pending":
                raise RegistryError(f"only pending endpoints can be approved, not {existing.state}")
            self._connection.execute(
                """
                UPDATE endpoints
                SET state = 'approved', credential_version = credential_version + 1,
                    friendly_name = ?, area_id = ?, area_name = ?, ha_device_id = ?,
                    last_error_code = NULL
                WHERE endpoint_id = ?
                """,
                (name, normalized_area_id, normalized_area_name, normalized_ha_device_id, endpoint_id),
            )
            return self._require(endpoint_id)

    def revoke(self, endpoint_id: str, *, reason: str = "operator_revoked") -> EndpointRecord:
        normalized_reason = _required_text(reason, "reason", 128)
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state == "replaced":
                raise RegistryError("replaced endpoint cannot be revoked")
            if existing.state != "revoked":
                self._connection.execute(
                    """
                    UPDATE endpoints
                    SET state = 'revoked', credential_version = credential_version + 1,
                        last_error_code = ?
                    WHERE endpoint_id = ?
                    """,
                    (normalized_reason, endpoint_id),
                )
            return self._require(endpoint_id)

    def rotate_credential(self, endpoint_id: str) -> EndpointRecord:
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "approved":
                raise RegistryError("only approved endpoints can rotate credentials")
            self._connection.execute(
                "UPDATE endpoints SET credential_version = credential_version + 1 WHERE endpoint_id = ?",
                (endpoint_id,),
            )
            return self._require(endpoint_id)

    def replace(self, old_endpoint_id: str, new_endpoint_id: str) -> EndpointRecord:
        if old_endpoint_id == new_endpoint_id:
            raise RegistryError("replacement endpoint must be different")
        with self._lock, self._transaction():
            old = self._require(old_endpoint_id)
            new = self._require(new_endpoint_id)
            if old.state != "approved":
                raise RegistryError("only an approved endpoint can be replaced")
            if new.state != "pending":
                raise RegistryError("replacement endpoint must be pending")
            self._connection.execute(
                """
                UPDATE endpoints
                SET state = 'replaced', credential_version = credential_version + 1,
                    ha_device_id = NULL, last_error_code = 'replaced'
                WHERE endpoint_id = ?
                """,
                (old_endpoint_id,),
            )
            self._connection.execute(
                """
                UPDATE endpoints
                SET state = 'approved', credential_version = credential_version + 1,
                    friendly_name = ?, area_id = ?, area_name = ?, ha_device_id = ?,
                    media_player = ?, last_error_code = NULL
                WHERE endpoint_id = ?
                """,
                (
                    old.friendly_name,
                    old.area_id,
                    old.area_name,
                    old.ha_device_id,
                    old.media_player,
                    new_endpoint_id,
                ),
            )
            return self._require(new_endpoint_id)

    def rename(self, endpoint_id: str, friendly_name: str) -> EndpointRecord:
        name = _required_text(friendly_name, "friendly_name", 128)
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "approved":
                raise RegistryError("only approved endpoints can be renamed")
            self._connection.execute(
                "UPDATE endpoints SET friendly_name = ? WHERE endpoint_id = ?",
                (name, endpoint_id),
            )
            return self._require(endpoint_id)

    def assign_media_player(self, endpoint_id: str, entity_id: str | None) -> EndpointRecord:
        """Records the endpoint's Music Assistant player; None clears it."""
        player = _nullable_text(entity_id, 255)
        if player is not None and not player.startswith("media_player."):
            raise RegistryError("media_player must be a media_player entity id")
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "approved":
                raise RegistryError("only approved endpoints can have a media player")
            self._connection.execute(
                "UPDATE endpoints SET media_player = ? WHERE endpoint_id = ?",
                (player, endpoint_id),
            )
            return self._require(endpoint_id)

    def assign_ha_device(self, endpoint_id: str, device_id: str | None) -> EndpointRecord:
        """Records the endpoint's Home Assistant device (an Assist satellite's turns arrive by it); None clears it."""
        device = _nullable_text(device_id, 128)
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "approved":
                raise RegistryError("only approved endpoints can have a Home Assistant device")
            self._connection.execute(
                "UPDATE endpoints SET ha_device_id = ? WHERE endpoint_id = ?",
                (device, endpoint_id),
            )
            return self._require(endpoint_id)

    def find_by_ha_device(self, device_id: str) -> EndpointRecord | None:
        """The approved endpoint recorded for this Home Assistant device, if any."""
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM endpoints WHERE ha_device_id = ? AND state = 'approved' ORDER BY first_seen_at LIMIT 1",
                (str(device_id or ""),),
            ).fetchone()
            return _record_from_row(row) if row is not None else None

    def assign_area(self, endpoint_id: str, area_id: str, area_name: str | None = None) -> EndpointRecord:
        normalized_area_id = _required_text(area_id, "area_id", 128)
        normalized_area_name = _nullable_text(area_name, 128)
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "approved":
                raise RegistryError("only approved endpoints can move areas")
            self._connection.execute(
                "UPDATE endpoints SET area_id = ?, area_name = ? WHERE endpoint_id = ?",
                (normalized_area_id, normalized_area_name, endpoint_id),
            )
            return self._require(endpoint_id)

    def next_connection_generation(self, endpoint_id: str) -> int:
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "approved":
                raise RegistryError("only approved endpoints can connect")
            self._connection.execute(
                """
                UPDATE endpoints
                SET connection_generation = connection_generation + 1,
                    last_seen_at = ?, last_disconnect_reason = NULL, last_error_code = NULL
                WHERE endpoint_id = ?
                """,
                (float(self._clock()), endpoint_id),
            )
            return self._require(endpoint_id).connection_generation

    def update_health(
        self,
        endpoint_id: str,
        health: dict[str, str | int | float | bool | None],
    ) -> EndpointRecord:
        with self._lock, self._transaction():
            existing = self._require(endpoint_id)
            if existing.state != "approved":
                raise RegistryError("only approved endpoints can publish health")
            self._connection.execute(
                "UPDATE endpoints SET health_json = ?, last_seen_at = ? WHERE endpoint_id = ?",
                (_compact_json(health), float(self._clock()), endpoint_id),
            )
            return self._require(endpoint_id)

    def record_disconnect(self, endpoint_id: str, reason: str) -> EndpointRecord:
        normalized_reason = _required_text(reason, "reason", 128)
        with self._lock, self._transaction():
            self._require(endpoint_id)
            self._connection.execute(
                """
                UPDATE endpoints SET last_disconnect_reason = ?, last_seen_at = ?
                WHERE endpoint_id = ?
                """,
                (normalized_reason, float(self._clock()), endpoint_id),
            )
            return self._require(endpoint_id)

    def get(self, endpoint_id: str) -> EndpointRecord | None:
        with self._lock:
            return self._select(endpoint_id)

    def require(self, endpoint_id: str) -> EndpointRecord:
        with self._lock:
            return self._require(endpoint_id)

    def list(self, *, state: str | None = None) -> list[EndpointRecord]:
        if state is not None and state not in ENDPOINT_STATES:
            raise RegistryError(f"invalid endpoint state: {state}")
        with self._lock:
            if state is None:
                rows = self._connection.execute(
                    "SELECT * FROM endpoints ORDER BY first_seen_at, endpoint_id"
                ).fetchall()
            else:
                rows = self._connection.execute(
                    "SELECT * FROM endpoints WHERE state = ? ORDER BY first_seen_at, endpoint_id",
                    (state,),
                ).fetchall()
            return [_record_from_row(row) for row in rows]

    def _prepare_path(self) -> None:
        if self._path == ":memory:":
            return
        path = Path(self._path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.touch(mode=0o600)
        os.chmod(path, 0o600)

    def _migrate(self) -> None:
        with self._lock, self._transaction():
            version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise RegistryError(f"fleet registry schema {version} is newer than supported {SCHEMA_VERSION}")
            if version == 0:
                self._connection.execute(
                    """
                    CREATE TABLE endpoints (
                        endpoint_id TEXT PRIMARY KEY,
                        hardware_id TEXT NOT NULL UNIQUE,
                        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'revoked', 'replaced')),
                        credential_version INTEGER NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
                        ha_device_id TEXT,
                        friendly_name TEXT,
                        area_id TEXT,
                        area_name TEXT,
                        protocol_version INTEGER,
                        firmware_json TEXT NOT NULL DEFAULT '{}',
                        capabilities_json TEXT NOT NULL DEFAULT '[]',
                        health_json TEXT NOT NULL DEFAULT '{}',
                        enrollment_public_value TEXT,
                        first_seen_at REAL NOT NULL,
                        last_seen_at REAL NOT NULL,
                        last_ip TEXT,
                        last_disconnect_reason TEXT,
                        last_error_code TEXT,
                        connection_generation INTEGER NOT NULL DEFAULT 0 CHECK (connection_generation >= 0)
                    )
                    """
                )
                version = 1
            if version == 1:
                self._connection.execute("ALTER TABLE endpoints ADD COLUMN media_player TEXT")
            self._connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _select(self, endpoint_id: str) -> EndpointRecord | None:
        row = self._connection.execute(
            "SELECT * FROM endpoints WHERE endpoint_id = ?",
            (endpoint_id,),
        ).fetchone()
        return _record_from_row(row) if row is not None else None

    def _require(self, endpoint_id: str) -> EndpointRecord:
        record = self._select(endpoint_id)
        if record is None:
            raise RegistryError("unknown endpoint")
        return record

    def _transaction(self):
        return _Transaction(self._connection)


class _Transaction:
    def __init__(self, connection: sqlite3.Connection):
        self._connection = connection

    def __enter__(self):
        self._connection.execute("BEGIN IMMEDIATE")
        return self

    def __exit__(self, exc_type, _exc, _tb) -> bool:
        if exc_type is None:
            self._connection.execute("COMMIT")
        else:
            self._connection.execute("ROLLBACK")
        return False


def _record_from_row(row: sqlite3.Row) -> EndpointRecord:
    firmware = _json_object(row["firmware_json"])
    health = _json_scalar_object(row["health_json"])
    capabilities_value = json.loads(row["capabilities_json"])
    if not isinstance(capabilities_value, list) or not all(isinstance(item, str) for item in capabilities_value):
        raise RegistryError("stored endpoint capabilities are invalid")
    return EndpointRecord(
        endpoint_id=row["endpoint_id"],
        hardware_id=row["hardware_id"],
        state=row["state"],
        credential_version=int(row["credential_version"]),
        ha_device_id=row["ha_device_id"],
        friendly_name=row["friendly_name"],
        area_id=row["area_id"],
        area_name=row["area_name"],
        protocol_version=int(row["protocol_version"]) if row["protocol_version"] is not None else None,
        firmware=firmware,
        capabilities=tuple(capabilities_value),
        health=health,
        enrollment_public_value=row["enrollment_public_value"],
        first_seen_at=float(row["first_seen_at"]),
        last_seen_at=float(row["last_seen_at"]),
        last_ip=row["last_ip"],
        last_disconnect_reason=row["last_disconnect_reason"],
        last_error_code=row["last_error_code"],
        connection_generation=int(row["connection_generation"]),
        media_player=row["media_player"],
    )


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _json_object(value: str) -> dict[str, str]:
    parsed = json.loads(value)
    if not isinstance(parsed, dict) or not all(
        isinstance(key, str) and isinstance(item, str)
        for key, item in parsed.items()
    ):
        raise RegistryError("stored endpoint firmware is invalid")
    return parsed


def _json_scalar_object(value: str) -> dict[str, str | int | float | bool | None]:
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise RegistryError("stored endpoint health is invalid")
    if not all(
        isinstance(key, str)
        and (item is None or isinstance(item, (str, int, float, bool)))
        for key, item in parsed.items()
    ):
        raise RegistryError("stored endpoint health is invalid")
    return parsed


def _required_text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise RegistryError(f"{label} must be a string")
    normalized = " ".join(value.split()).strip()
    if not normalized:
        raise RegistryError(f"{label} must not be empty")
    if len(normalized) > maximum:
        raise RegistryError(f"{label} exceeds length limit")
    return normalized


def _nullable_text(value: Any, maximum: int) -> str | None:
    if value is None:
        return None
    return _required_text(value, "value", maximum)
