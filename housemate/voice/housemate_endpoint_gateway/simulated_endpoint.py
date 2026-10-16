"""Hermetic endpoint used to prove the fleet control contract."""

from __future__ import annotations

import uuid

from .connection import AuthChallenge
from .credentials import build_auth_proof
from .enrollment import EnrollmentGrant
from .protocol import PROTOCOL_VERSION, encode_control_frame


class SimulatedEndpoint:
    def __init__(
        self,
        *,
        endpoint_id: str | None = None,
        hardware_id: str | None = None,
        protocol_versions: tuple[int, ...] = (PROTOCOL_VERSION,),
        firmware: dict[str, str] | None = None,
        capabilities: tuple[str, ...] = ("local_wake", "pcm_s16le_16k_mono"),
    ):
        self.endpoint_id = endpoint_id or str(uuid.uuid4())
        self.hardware_id = hardware_id or f"sim-{uuid.uuid4()}"
        self.protocol_versions = protocol_versions
        self.firmware = dict(firmware or {"simulator": "1.0.0"})
        self.capabilities = capabilities
        self.credential_version = 0
        self.device_secret = ""

    def hello_frame(self, **optional_fields) -> bytes:
        return encode_control_frame(
            {
                "type": "endpoint_hello",
                "endpoint_id": self.endpoint_id,
                "hardware_id": self.hardware_id,
                "protocol_versions": list(self.protocol_versions),
                "firmware": self.firmware,
                "capabilities": list(self.capabilities),
                "enrollment_public_value": f"sim-pair-{self.endpoint_id}",
                **optional_fields,
            }
        )

    def accept_enrollment(self, grant: EnrollmentGrant) -> None:
        if grant.endpoint_id != self.endpoint_id:
            raise ValueError("enrollment grant belongs to another endpoint")
        self.credential_version = grant.credential_version
        self.device_secret = grant.device_secret

    def new_connection_id(self) -> str:
        return str(uuid.uuid4())

    def authentication_frame(self, challenge: AuthChallenge) -> bytes:
        if challenge.endpoint_id != self.endpoint_id:
            raise ValueError("challenge belongs to another endpoint")
        if not self.device_secret or self.credential_version < 1:
            raise ValueError("endpoint has not accepted an enrollment grant")
        proof = build_auth_proof(
            secret=self.device_secret,
            endpoint_id=self.endpoint_id,
            credential_version=self.credential_version,
            connection_id=challenge.connection_id,
            challenge_nonce=challenge.nonce,
        )
        return encode_control_frame(
            {
                "type": "authenticate",
                "endpoint_id": self.endpoint_id,
                "credential_version": self.credential_version,
                "connection_id": challenge.connection_id,
                "challenge_id": challenge.challenge_id,
                "proof": proof,
            }
        )

    def heartbeat_frame(
        self,
        connection_id: str,
        *,
        sequence: int,
        health: dict | None = None,
    ) -> bytes:
        return encode_control_frame(
            {
                "type": "heartbeat",
                "endpoint_id": self.endpoint_id,
                "connection_id": connection_id,
                "sequence": sequence,
                "health": dict(health or {}),
            }
        )
