"""Network-independent gateway control-plane coordinator."""

from __future__ import annotations

from .connection import AuthChallenge, ChallengeStore, ConnectionLease, ConnectionManager
from .credentials import CredentialAuthority
from .enrollment import EnrollmentGrant, EnrollmentService
from .ha_bridge import build_ha_fleet_snapshot
from .protocol import (
    SUPPORTED_PROTOCOL_VERSIONS,
    ProtocolError,
    canonical_uuid,
    decode_control_frame,
    negotiate_protocol,
    parse_authenticate,
    parse_endpoint_hello,
    parse_heartbeat,
)
from .registry import EndpointRecord, FleetRegistry, RegistryError


class GatewayControlPlane:
    """Coordinates fleet lifecycle without touching the live voice/audio loop."""

    def __init__(
        self,
        registry: FleetRegistry,
        master_key: bytes,
        *,
        challenge_ttl_seconds: float = 15.0,
        max_outstanding_challenges: int = 1024,
        challenge_clock=None,
    ):
        self.registry = registry
        self.credentials = CredentialAuthority(master_key)
        self.enrollment = EnrollmentService(registry, self.credentials)
        self.connections = ConnectionManager(registry)
        challenge_options = {
            "ttl_seconds": challenge_ttl_seconds,
            "max_outstanding": max_outstanding_challenges,
        }
        if challenge_clock is not None:
            challenge_options["clock"] = challenge_clock
        self.challenges = ChallengeStore(registry, self.credentials, **challenge_options)

    def handle_hello(self, raw_frame, *, peer_ip: str | None = None) -> dict:
        message = decode_control_frame(raw_frame)
        hello = parse_endpoint_hello(message)
        protocol_version = negotiate_protocol(hello.protocol_versions, SUPPORTED_PROTOCOL_VERSIONS)
        record = self.registry.observe_endpoint(
            hello,
            protocol_version=protocol_version,
            peer_ip=peer_ip,
        )
        if record.state == "pending":
            return {
                "type": "enrollment_pending",
                "endpoint_id": record.endpoint_id,
                "protocol_version": protocol_version,
                "state": record.state,
            }
        if record.state == "approved":
            return {
                "type": "authentication_required",
                "endpoint_id": record.endpoint_id,
                "protocol_version": protocol_version,
                "credential_version": record.credential_version,
                "state": record.state,
            }
        raise RegistryError(f"endpoint connection refused because it is {record.state}")

    def approve_pending(
        self,
        endpoint_id: str,
        *,
        friendly_name: str,
        area_id: str,
        area_name: str | None = None,
        ha_device_id: str | None = None,
        physical_pairing_confirmed: bool,
    ) -> EnrollmentGrant:
        return self.enrollment.approve(
            endpoint_id,
            friendly_name=friendly_name,
            area_id=area_id,
            area_name=area_name,
            ha_device_id=ha_device_id,
            physical_pairing_confirmed=physical_pairing_confirmed,
        )

    def rotate_credential(self, endpoint_id: str, *, physical_pairing_confirmed: bool) -> EnrollmentGrant:
        self.connections.evict(endpoint_id, reason="credential_rotated")
        return self.enrollment.rotate(
            endpoint_id,
            physical_pairing_confirmed=physical_pairing_confirmed,
        )

    def revoke(self, endpoint_id: str, *, reason: str = "operator_revoked") -> EndpointRecord:
        self.connections.evict(endpoint_id, reason=reason)
        return self.enrollment.revoke(endpoint_id, reason=reason)

    def replace(
        self,
        old_endpoint_id: str,
        new_endpoint_id: str,
        *,
        physical_pairing_confirmed: bool,
    ) -> EnrollmentGrant:
        self.connections.evict(old_endpoint_id, reason="replaced")
        return self.enrollment.replace(
            old_endpoint_id,
            new_endpoint_id,
            physical_pairing_confirmed=physical_pairing_confirmed,
        )

    def begin_authentication(self, endpoint_id: str, connection_id: str) -> AuthChallenge:
        normalized_endpoint_id = canonical_uuid(endpoint_id, "endpoint_id")
        normalized_connection_id = canonical_uuid(connection_id, "connection_id")
        return self.challenges.issue(normalized_endpoint_id, normalized_connection_id)

    def authenticate(self, raw_frame) -> ConnectionLease:
        message = decode_control_frame(raw_frame)
        request = parse_authenticate(message)
        self.challenges.verify(request)
        return self.connections.activate(request.endpoint_id, request.connection_id)

    def disconnect(self, endpoint_id: str, connection_id: str, *, reason: str = "client_closed") -> bool:
        return self.connections.disconnect(endpoint_id, connection_id, reason=reason)

    def handle_heartbeat(self, raw_frame) -> dict:
        message = decode_control_frame(raw_frame)
        heartbeat = parse_heartbeat(message)
        self.connections.record_heartbeat(
            heartbeat.endpoint_id,
            heartbeat.connection_id,
            heartbeat.sequence,
            heartbeat.health,
        )
        return {
            "type": "heartbeat_ack",
            "endpoint_id": heartbeat.endpoint_id,
            "connection_id": heartbeat.connection_id,
            "sequence": heartbeat.sequence,
        }

    def ha_snapshot(self) -> dict:
        return build_ha_fleet_snapshot(self.registry, self.connections)


__all__ = [
    "GatewayControlPlane",
    "ProtocolError",
    "RegistryError",
]
