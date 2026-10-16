"""Bounded duplicate-wake arbitration for nearby dynamic endpoints."""

from __future__ import annotations

import dataclasses
import math
import uuid
from collections.abc import Callable, Iterable, Mapping

from .protocol import canonical_uuid


class WakeClaimError(ValueError):
    """Raised when a wake claim cannot safely enter arbitration."""


class ArbitrationBatchFull(RuntimeError):
    """Raised when a bounded arbitration batch is over capacity."""


@dataclasses.dataclass(frozen=True, slots=True)
class WakeClaim:
    endpoint_id: str
    room: str
    observed_at_us: int
    confidence: float
    snr_db: float
    fingerprint: bytes

    def __post_init__(self) -> None:
        object.__setattr__(self, "endpoint_id", canonical_uuid(self.endpoint_id, "endpoint_id"))
        normalized_room = " ".join(str(self.room or "").split()).strip()
        if not normalized_room or len(normalized_room) > 128:
            raise WakeClaimError("wake room is missing or too long")
        object.__setattr__(self, "room", normalized_room)
        if (
            not isinstance(self.observed_at_us, int)
            or isinstance(self.observed_at_us, bool)
            or self.observed_at_us < 0
            or self.observed_at_us > 0xFFFFFFFFFFFFFFFF
        ):
            raise WakeClaimError("wake timestamp is outside uint64 range")
        if (
            not isinstance(self.confidence, (int, float))
            or isinstance(self.confidence, bool)
            or not math.isfinite(self.confidence)
            or not 0.0 <= self.confidence <= 1.0
        ):
            raise WakeClaimError("wake confidence must be between zero and one")
        if (
            not isinstance(self.snr_db, (int, float))
            or isinstance(self.snr_db, bool)
            or not math.isfinite(self.snr_db)
            or not -120.0 <= self.snr_db <= 120.0
        ):
            raise WakeClaimError("wake SNR is outside supported range")
        if not isinstance(self.fingerprint, bytes):
            raise WakeClaimError("wake fingerprint must be immutable bytes")
        if not 4 <= len(self.fingerprint) <= 64:
            raise WakeClaimError("wake fingerprint length is outside bounds")


@dataclasses.dataclass(frozen=True, slots=True)
class WakeDecision:
    endpoint_id: str
    accepted: bool
    reason: str
    winner_endpoint_id: str
    session_id: str
    group_size: int


@dataclasses.dataclass(frozen=True, slots=True)
class ArbitrationResult:
    decisions: tuple[WakeDecision, ...]
    winners: int
    suppressed: int


class WakeArbitrator:
    """Groups nearby matching wakes and selects one deterministic winner."""

    def __init__(
        self,
        *,
        arbitration_window_ms: float,
        fingerprint_similarity: float,
        max_batch_claims: int,
        adjacency: Mapping[str, Iterable[str]] | None = None,
        session_id_factory: Callable[[], str] | None = None,
    ):
        if arbitration_window_ms <= 0:
            raise ValueError("arbitration window must be positive")
        if not 0.0 <= fingerprint_similarity <= 1.0:
            raise ValueError("fingerprint similarity must be between zero and one")
        if max_batch_claims < 1:
            raise ValueError("arbitration batch capacity must be positive")
        self.window_us = int(round(arbitration_window_ms * 1000))
        self.similarity_threshold = float(fingerprint_similarity)
        self.max_batch_claims = int(max_batch_claims)
        self._session_id_factory = session_id_factory or (lambda: str(uuid.uuid4()))
        self._adjacent_pairs: frozenset[frozenset[str]] = frozenset()
        self.replace_adjacency(adjacency or {})

    def replace_adjacency(self, adjacency: Mapping[str, Iterable[str]]) -> None:
        pairs: set[frozenset[str]] = set()
        for raw_room, raw_neighbours in adjacency.items():
            room = _normalize_room(raw_room)
            if isinstance(raw_neighbours, (str, bytes)):
                raise WakeClaimError("adjacency neighbours must be a room collection")
            for raw_neighbour in raw_neighbours:
                neighbour = _normalize_room(raw_neighbour)
                if neighbour != room:
                    pairs.add(frozenset((room, neighbour)))
        self._adjacent_pairs = frozenset(pairs)

    def resolve(self, claims: Iterable[WakeClaim]) -> ArbitrationResult:
        batch = tuple(claims)
        if len(batch) > self.max_batch_claims:
            raise ArbitrationBatchFull("wake arbitration batch is full")
        endpoint_ids = [claim.endpoint_id for claim in batch]
        if len(set(endpoint_ids)) != len(endpoint_ids):
            raise WakeClaimError("endpoint submitted more than one claim in a batch")
        if not batch:
            return ArbitrationResult(decisions=(), winners=0, suppressed=0)

        parents = list(range(len(batch)))

        def find(index: int) -> int:
            while parents[index] != index:
                parents[index] = parents[parents[index]]
                index = parents[index]
            return index

        def union(left: int, right: int) -> None:
            left_root = find(left)
            right_root = find(right)
            if left_root != right_root:
                parents[right_root] = left_root

        for left in range(len(batch)):
            for right in range(left + 1, len(batch)):
                if self._claims_match(batch[left], batch[right]):
                    union(left, right)

        groups: dict[int, list[int]] = {}
        for index in range(len(batch)):
            groups.setdefault(find(index), []).append(index)

        decisions_by_index: dict[int, WakeDecision] = {}
        for indexes in groups.values():
            winner_index = min(indexes, key=lambda index: _winner_sort_key(batch[index]))
            winner = batch[winner_index]
            session_id = canonical_uuid(self._session_id_factory(), "session_id")
            group_size = len(indexes)
            for index in indexes:
                claim = batch[index]
                accepted = index == winner_index
                reason = "accepted_independent" if group_size == 1 else (
                    "accepted_duplicate_winner" if accepted else "suppressed_duplicate"
                )
                decisions_by_index[index] = WakeDecision(
                    endpoint_id=claim.endpoint_id,
                    accepted=accepted,
                    reason=reason,
                    winner_endpoint_id=winner.endpoint_id,
                    session_id=session_id,
                    group_size=group_size,
                )

        decisions = tuple(decisions_by_index[index] for index in range(len(batch)))
        winner_count = sum(1 for decision in decisions if decision.accepted)
        return ArbitrationResult(
            decisions=decisions,
            winners=winner_count,
            suppressed=len(decisions) - winner_count,
        )

    def _claims_match(self, left: WakeClaim, right: WakeClaim) -> bool:
        if abs(left.observed_at_us - right.observed_at_us) > self.window_us:
            return False
        if not self._rooms_nearby(left.room, right.room):
            return False
        return fingerprint_similarity(left.fingerprint, right.fingerprint) >= self.similarity_threshold

    def _rooms_nearby(self, left: str, right: str) -> bool:
        return left == right or frozenset((left, right)) in self._adjacent_pairs


def fingerprint_similarity(left: bytes, right: bytes) -> float:
    if not left or len(left) != len(right):
        return 0.0
    differing_bits = sum((left_byte ^ right_byte).bit_count() for left_byte, right_byte in zip(left, right))
    return 1.0 - (differing_bits / (len(left) * 8))


def _winner_sort_key(claim: WakeClaim) -> tuple[float, float, int, str]:
    return (-claim.confidence, -claim.snr_db, claim.observed_at_us, claim.endpoint_id)


def _normalize_room(room: str) -> str:
    normalized = " ".join(str(room or "").split()).strip()
    if not normalized or len(normalized) > 128:
        raise WakeClaimError("adjacency room is missing or too long")
    return normalized
