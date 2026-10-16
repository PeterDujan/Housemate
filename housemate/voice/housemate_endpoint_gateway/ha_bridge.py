"""Credential-free fleet snapshots for a future Home Assistant integration."""

from __future__ import annotations

from typing import Any

from .connection import ConnectionManager
from .registry import FleetRegistry


def build_ha_fleet_snapshot(
    registry: FleetRegistry,
    connections: ConnectionManager,
) -> dict[str, Any]:
    active = connections.snapshot()
    devices = []
    for record in registry.list():
        lease = active.get(record.endpoint_id)
        devices.append(
            {
                "endpoint_id": record.endpoint_id,
                "unique_id": f"jarvis_endpoint_{record.endpoint_id}",
                "hardware_id": record.hardware_id,
                "state": record.state,
                "online": lease is not None,
                "connection_generation": record.connection_generation,
                "friendly_name": record.friendly_name,
                "area_id": record.area_id,
                "area_name": record.area_name,
                "ha_device_id": record.ha_device_id,
                "protocol_version": record.protocol_version,
                "firmware": dict(record.firmware),
                "capabilities": list(record.capabilities),
                "health": dict(record.health),
                "first_seen_at": record.first_seen_at,
                "last_seen_at": record.last_seen_at,
                "last_ip": record.last_ip,
                "last_disconnect_reason": record.last_disconnect_reason,
                "last_error_code": record.last_error_code,
                "active_connection_id": lease.connection_id if lease is not None else None,
            }
        )
    return {
        "schema_version": 1,
        "endpoint_count": len(devices),
        "online_count": sum(1 for device in devices if device["online"]),
        "pending_count": sum(1 for device in devices if device["state"] == "pending"),
        "devices": devices,
    }
