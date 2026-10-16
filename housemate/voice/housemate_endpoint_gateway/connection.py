"""Bounded authentication challenges and active connection leases."""

from __future__ import annotations

import dataclasses
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable

from .credentials import CredentialAuthority
from .protocol import AuthenticateRequest
from .registry import FleetRegistry, RegistryError


class AuthenticationError(RuntimeError):
    """Raised when an endpoint authentication attempt fails closed."""


@dataclasses.dataclass(frozen=True, slots=True)
class AuthChallenge:
    challenge_id: str
    endpoint_id: str
    credential_version: int
    connection_id: str
    nonce: str
    expires_in_ms: int


@dataclasses.dataclass(frozen=True, slots=True)
class ConnectionLease:
    endpoint_id: str
    connection_id: str
    generation: int
    superseded_connection_id: str | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class _StoredChallenge:
    challenge: AuthChallenge
    expires_at: float


class ChallengeStore:
    def __init__(
        self,
        registry: FleetRegistry,
        credentials: CredentialAuthority,
        *,
        ttl_seconds: float = 15.0,
        max_outstanding: int = 1024,
        clock: Callable[[], float] = time.monotonic,
    ):
        if ttl_seconds <= 0:
            raise ValueError("challenge TTL must be positive")
        if max_outstanding < 1:
            raise ValueError("challenge capacity must be positive")
        self._registry = registry
        self._credentials = credentials
        self._ttl_seconds = float(ttl_seconds)
        self._max_outstanding = int(max_outstanding)
        self._clock = clock
        self._lock = threading.Lock()
        self._challenges: OrderedDict[str, _StoredChallenge] = OrderedDict()
        self._by_endpoint: dict[str, str] = {}

    @property
    def outstanding_count(self) -> int:
        with self._lock:
            self._prune_locked()
            return len(self._challenges)

    def issue(self, endpoint_id: str, connection_id: str) -> AuthChallenge:
        record = self._registry.require(endpoint_id)
        if record.state != "approved":
            raise AuthenticationError("endpoint is not approved")
        now = float(self._clock())
        challenge = AuthChallenge(
            challenge_id=str(uuid.uuid4()),
            endpoint_id=endpoint_id,
            credential_version=record.credential_version,
            connection_id=connection_id,
            nonce=secrets.token_urlsafe(32),
            expires_in_ms=int(round(self._ttl_seconds * 1000)),
        )
        with self._lock:
            self._prune_locked(now)
            previous_id = self._by_endpoint.pop(endpoint_id, None)
            if previous_id is not None:
                self._challenges.pop(previous_id, None)
            while len(self._challenges) >= self._max_outstanding:
                oldest_id, oldest = self._challenges.popitem(last=False)
                self._by_endpoint.pop(oldest.challenge.endpoint_id, None)
                if oldest_id == challenge.challenge_id:
                    break
            self._challenges[challenge.challenge_id] = _StoredChallenge(
                challenge=challenge,
                expires_at=now + self._ttl_seconds,
            )
            self._by_endpoint[endpoint_id] = challenge.challenge_id
        return challenge

    def verify(self, request: AuthenticateRequest) -> None:
        now = float(self._clock())
        with self._lock:
            self._prune_locked(now)
            stored = self._challenges.pop(request.challenge_id, None)
            if stored is not None:
                self._by_endpoint.pop(stored.challenge.endpoint_id, None)
        if stored is None:
            raise AuthenticationError("authentication challenge is unknown, expired, or already used")
        challenge = stored.challenge
        if now > stored.expires_at:
            raise AuthenticationError("authentication challenge expired")
        if (
            request.endpoint_id != challenge.endpoint_id
            or request.connection_id != challenge.connection_id
            or request.credential_version != challenge.credential_version
        ):
            raise AuthenticationError("authentication request does not match its challenge")
        record = self._registry.require(request.endpoint_id)
        if record.state != "approved" or record.credential_version != request.credential_version:
            raise AuthenticationError("endpoint credential is no longer valid")
        if not self._credentials.verify_proof(
            endpoint_id=request.endpoint_id,
            credential_version=request.credential_version,
            connection_id=request.connection_id,
            challenge_nonce=challenge.nonce,
            proof=request.proof,
        ):
            raise AuthenticationError("endpoint authentication proof is invalid")

    def _prune_locked(self, now: float | None = None) -> None:
        current = float(self._clock()) if now is None else now
        expired_ids = [
            challenge_id
            for challenge_id, stored in self._challenges.items()
            if stored.expires_at < current
        ]
        for challenge_id in expired_ids:
            stored = self._challenges.pop(challenge_id)
            self._by_endpoint.pop(stored.challenge.endpoint_id, None)


class ConnectionManager:
    def __init__(self, registry: FleetRegistry):
        self._registry = registry
        self._lock = threading.Lock()
        self._active: dict[str, ConnectionLease] = {}
        self._heartbeat_sequences: dict[str, int] = {}

    def activate(self, endpoint_id: str, connection_id: str) -> ConnectionLease:
        with self._lock:
            generation = self._registry.next_connection_generation(endpoint_id)
            previous = self._active.get(endpoint_id)
            lease = ConnectionLease(
                endpoint_id=endpoint_id,
                connection_id=connection_id,
                generation=generation,
                superseded_connection_id=previous.connection_id if previous is not None else None,
            )
            self._active[endpoint_id] = lease
            self._heartbeat_sequences[endpoint_id] = -1
            return lease

    def disconnect(self, endpoint_id: str, connection_id: str, *, reason: str) -> bool:
        with self._lock:
            active = self._active.get(endpoint_id)
            if active is None or active.connection_id != connection_id:
                return False
            self._active.pop(endpoint_id, None)
            self._heartbeat_sequences.pop(endpoint_id, None)
            self._registry.record_disconnect(endpoint_id, reason)
        return True

    def evict(self, endpoint_id: str, *, reason: str) -> ConnectionLease | None:
        with self._lock:
            active = self._active.pop(endpoint_id, None)
            self._heartbeat_sequences.pop(endpoint_id, None)
            if active is not None:
                self._registry.record_disconnect(endpoint_id, reason)
        return active

    def record_heartbeat(
        self,
        endpoint_id: str,
        connection_id: str,
        sequence: int,
        health: dict[str, str | int | float | bool | None],
    ) -> None:
        with self._lock:
            active = self._active.get(endpoint_id)
            if active is None or active.connection_id != connection_id:
                raise RegistryError("heartbeat does not belong to the active endpoint connection")
            previous = self._heartbeat_sequences.get(endpoint_id, -1)
            if sequence <= previous:
                raise RegistryError("heartbeat sequence is stale or duplicated")
            self._heartbeat_sequences[endpoint_id] = sequence
            self._registry.update_health(endpoint_id, health)

    def active_for(self, endpoint_id: str) -> ConnectionLease | None:
        with self._lock:
            return self._active.get(endpoint_id)

    def snapshot(self) -> dict[str, ConnectionLease]:
        with self._lock:
            return dict(self._active)
