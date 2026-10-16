"""Per-endpoint credential derivation and replay-resistant proof helpers."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac


_DERIVATION_CONTEXT = b"jarvis-endpoint-secret-v2\x00"
_AUTH_CONTEXT = b"jarvis-endpoint-auth-v2\x00"


class CredentialError(ValueError):
    """Raised for invalid credential material."""


class CredentialAuthority:
    """Derives unique device secrets from a root kept outside the fleet DB."""

    def __init__(self, master_key: bytes):
        if not isinstance(master_key, bytes) or len(master_key) < 32:
            raise CredentialError("gateway master key must contain at least 32 bytes")
        self._master_key = bytes(master_key)

    def issue_secret(self, endpoint_id: str, credential_version: int) -> str:
        if credential_version < 1:
            raise CredentialError("credential version must be positive")
        payload = _DERIVATION_CONTEXT + endpoint_id.encode("ascii") + b"\x00" + str(credential_version).encode("ascii")
        derived = hmac.new(self._master_key, payload, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(derived).decode("ascii").rstrip("=")

    def verify_proof(
        self,
        *,
        endpoint_id: str,
        credential_version: int,
        connection_id: str,
        challenge_nonce: str,
        proof: str,
    ) -> bool:
        secret = self.issue_secret(endpoint_id, credential_version)
        expected = build_auth_proof(
            secret=secret,
            endpoint_id=endpoint_id,
            credential_version=credential_version,
            connection_id=connection_id,
            challenge_nonce=challenge_nonce,
        )
        return hmac.compare_digest(expected, str(proof or "").lower())


def build_auth_proof(
    *,
    secret: str,
    endpoint_id: str,
    credential_version: int,
    connection_id: str,
    challenge_nonce: str,
) -> str:
    key = _decode_secret(secret)
    payload = b"\x00".join(
        (
            _AUTH_CONTEXT.rstrip(b"\x00"),
            endpoint_id.encode("ascii"),
            str(credential_version).encode("ascii"),
            connection_id.encode("ascii"),
            challenge_nonce.encode("ascii"),
        )
    )
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def _decode_secret(secret: str) -> bytes:
    if not isinstance(secret, str) or not secret.strip():
        raise CredentialError("device secret must not be empty")
    normalized = secret.strip()
    padding = "=" * (-len(normalized) % 4)
    try:
        decoded = base64.b64decode(normalized + padding, altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as err:
        raise CredentialError("device secret is not valid base64url") from err
    if len(decoded) != 32:
        raise CredentialError("device secret has invalid length")
    return decoded
