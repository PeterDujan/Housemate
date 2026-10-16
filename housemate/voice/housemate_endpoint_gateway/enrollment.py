"""Operator-approved endpoint enrolment lifecycle."""

from __future__ import annotations

import dataclasses

from .credentials import CredentialAuthority
from .registry import EndpointRecord, FleetRegistry, RegistryError


@dataclasses.dataclass(frozen=True, slots=True)
class EnrollmentGrant:
    endpoint_id: str
    credential_version: int
    device_secret: str


class EnrollmentService:
    def __init__(self, registry: FleetRegistry, credentials: CredentialAuthority):
        self._registry = registry
        self._credentials = credentials

    def approve(
        self,
        endpoint_id: str,
        *,
        friendly_name: str,
        area_id: str,
        area_name: str | None = None,
        ha_device_id: str | None = None,
        physical_pairing_confirmed: bool,
    ) -> EnrollmentGrant:
        if physical_pairing_confirmed is not True:
            raise RegistryError("physical pairing confirmation is required")
        record = self._registry.approve(
            endpoint_id,
            friendly_name=friendly_name,
            area_id=area_id,
            area_name=area_name,
            ha_device_id=ha_device_id,
        )
        return self._grant(record)

    def rotate(self, endpoint_id: str, *, physical_pairing_confirmed: bool) -> EnrollmentGrant:
        if physical_pairing_confirmed is not True:
            raise RegistryError("physical pairing confirmation is required")
        return self._grant(self._registry.rotate_credential(endpoint_id))

    def replace(
        self,
        old_endpoint_id: str,
        new_endpoint_id: str,
        *,
        physical_pairing_confirmed: bool,
    ) -> EnrollmentGrant:
        if physical_pairing_confirmed is not True:
            raise RegistryError("physical pairing confirmation is required")
        return self._grant(self._registry.replace(old_endpoint_id, new_endpoint_id))

    def revoke(self, endpoint_id: str, *, reason: str = "operator_revoked") -> EndpointRecord:
        return self._registry.revoke(endpoint_id, reason=reason)

    def _grant(self, record: EndpointRecord) -> EnrollmentGrant:
        if record.state != "approved" or record.credential_version < 1:
            raise RegistryError("credential grant requires an approved endpoint")
        return EnrollmentGrant(
            endpoint_id=record.endpoint_id,
            credential_version=record.credential_version,
            device_secret=self._credentials.issue_secret(record.endpoint_id, record.credential_version),
        )
