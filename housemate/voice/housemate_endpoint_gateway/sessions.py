"""Independent bounded actors for dynamic endpoint turn sessions."""

from __future__ import annotations

import asyncio
import dataclasses
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from .protocol import canonical_uuid


class EndpointActorBusy(RuntimeError):
    """Raised when one endpoint's bounded mailbox is full."""


class EndpointActorClosed(RuntimeError):
    """Raised when an endpoint actor has disconnected or shut down."""


class TurnDeadlineExceeded(TimeoutError):
    """Raised when an endpoint turn misses its queue/execution deadline."""


@dataclasses.dataclass(frozen=True, slots=True)
class TurnContext:
    endpoint_id: str
    turn_id: str
    room: str


@dataclasses.dataclass(frozen=True, slots=True)
class EndpointActorSnapshot:
    endpoint_id: str
    room: str
    mailbox_capacity: int
    queued: int
    active: bool
    peak_queued: int
    completed: int
    failed: int
    rejected: int
    expired: int
    cancelled: int
    closed: bool


@dataclasses.dataclass(frozen=True, slots=True)
class FleetActorSnapshot:
    actor_count: int
    queued_turns: int
    active_turns: int
    mailbox_capacity_total: int


@dataclasses.dataclass(slots=True, eq=False)
class _TurnItem:
    context: TurnContext
    handler: Callable[[TurnContext], Awaitable[Any]]
    deadline: float
    future: asyncio.Future
    state: str = "queued"
    running_task: asyncio.Future | None = None


class EndpointActor:
    """Serialises one endpoint while remaining independent of every other one."""

    def __init__(
        self,
        endpoint_id: str,
        room: str,
        *,
        mailbox_capacity: int,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.endpoint_id = canonical_uuid(endpoint_id, "endpoint_id")
        self._room = _normalize_room(room)
        if mailbox_capacity < 1:
            raise ValueError("endpoint mailbox capacity must be positive")
        self.mailbox_capacity = int(mailbox_capacity)
        self._clock = clock
        self._condition = asyncio.Condition()
        self._pending: deque[_TurnItem] = deque()
        self._active: _TurnItem | None = None
        self._runner: asyncio.Task | None = None
        self._closed = False
        self._close_reason = ""
        self._peak_queued = 0
        self._completed = 0
        self._failed = 0
        self._rejected = 0
        self._expired = 0
        self._cancelled = 0

    async def start(self) -> None:
        async with self._condition:
            if self._closed:
                raise EndpointActorClosed(self._closed_message())
            if self._runner is None:
                self._runner = asyncio.create_task(
                    self._run(),
                    name=f"housemate-endpoint-{self.endpoint_id}",
                )

    async def move_room(self, room: str) -> None:
        normalized_room = _normalize_room(room)
        async with self._condition:
            if self._closed:
                raise EndpointActorClosed(self._closed_message())
            self._room = normalized_room

    async def submit(
        self,
        turn_id: str,
        handler: Callable[[TurnContext], Awaitable[Any]],
        *,
        timeout_seconds: float,
    ) -> Any:
        normalized_turn_id = canonical_uuid(turn_id, "turn_id")
        if not callable(handler):
            raise TypeError("turn handler must be callable")
        if timeout_seconds <= 0:
            raise TurnDeadlineExceeded("turn deadline must be positive")
        await self.start()
        loop = asyncio.get_running_loop()
        async with self._condition:
            if self._closed:
                raise EndpointActorClosed(self._closed_message())
            if len(self._pending) >= self.mailbox_capacity:
                self._rejected += 1
                raise EndpointActorBusy("endpoint mailbox is full")
            item = _TurnItem(
                context=TurnContext(
                    endpoint_id=self.endpoint_id,
                    turn_id=normalized_turn_id,
                    room=self._room,
                ),
                handler=handler,
                deadline=float(self._clock()) + float(timeout_seconds),
                future=loop.create_future(),
            )
            self._pending.append(item)
            self._peak_queued = max(self._peak_queued, len(self._pending))
            self._condition.notify(1)
        try:
            return await asyncio.shield(item.future)
        except asyncio.CancelledError:
            await self._cancel_item(item)
            raise

    async def snapshot(self) -> EndpointActorSnapshot:
        async with self._condition:
            return EndpointActorSnapshot(
                endpoint_id=self.endpoint_id,
                room=self._room,
                mailbox_capacity=self.mailbox_capacity,
                queued=len(self._pending),
                active=self._active is not None,
                peak_queued=self._peak_queued,
                completed=self._completed,
                failed=self._failed,
                rejected=self._rejected,
                expired=self._expired,
                cancelled=self._cancelled,
                closed=self._closed,
            )

    async def close(self, reason: str = "endpoint_disconnected") -> None:
        normalized_reason = " ".join(str(reason or "").split()).strip() or "endpoint_disconnected"
        async with self._condition:
            if not self._closed:
                self._closed = True
                self._close_reason = normalized_reason
                while self._pending:
                    item = self._pending.popleft()
                    item.state = "cancelled"
                    self._cancelled += 1
                    if not item.future.done():
                        item.future.set_exception(EndpointActorClosed(self._closed_message()))
                if self._active is not None and self._active.running_task is not None:
                    self._active.running_task.cancel()
                self._condition.notify_all()
            runner = self._runner
        if runner is not None:
            await asyncio.gather(runner, return_exceptions=True)

    async def _cancel_item(self, item: _TurnItem) -> None:
        running_task = None
        async with self._condition:
            if item.state == "queued":
                try:
                    self._pending.remove(item)
                except ValueError:
                    pass
                item.state = "cancelled"
                self._cancelled += 1
            elif item.state == "running":
                item.state = "cancelled"
                running_task = item.running_task
                self._cancelled += 1
            if not item.future.done():
                item.future.cancel()
            self._condition.notify_all()
        if running_task is not None:
            running_task.cancel()

    async def _take_next(self) -> _TurnItem | None:
        async with self._condition:
            while True:
                while self._pending:
                    item = self._pending.popleft()
                    if item.state != "queued" or item.future.cancelled():
                        continue
                    item.state = "running"
                    self._active = item
                    return item
                if self._closed:
                    return None
                await self._condition.wait()

    async def _run(self) -> None:
        while True:
            item = await self._take_next()
            if item is None:
                return
            if float(self._clock()) >= item.deadline:
                await self._finish_expired(item)
                continue
            try:
                operation_task = asyncio.ensure_future(item.handler(item.context))
            except Exception as err:
                await self._finish_failed(item, err)
                continue
            item.running_task = operation_task
            try:
                result = await asyncio.wait_for(
                    operation_task,
                    timeout=max(0.0, item.deadline - float(self._clock())),
                )
            except TimeoutError:
                await self._finish_expired(item)
            except asyncio.CancelledError:
                await self._finish_cancelled(item)
            except Exception as err:
                await self._finish_failed(item, err)
            else:
                await self._finish_completed(item, result)

    async def _finish_completed(self, item: _TurnItem, result: Any) -> None:
        async with self._condition:
            self._active = None
            if item.state == "running":
                item.state = "done"
                self._completed += 1
                if not item.future.done():
                    item.future.set_result(result)

    async def _finish_failed(self, item: _TurnItem, error: Exception) -> None:
        async with self._condition:
            self._active = None
            if item.state == "running":
                item.state = "done"
                self._failed += 1
                if not item.future.done():
                    item.future.set_exception(error)

    async def _finish_expired(self, item: _TurnItem) -> None:
        async with self._condition:
            self._active = None
            if item.state == "running":
                item.state = "done"
                self._expired += 1
                if not item.future.done():
                    item.future.set_exception(TurnDeadlineExceeded("endpoint turn deadline exceeded"))

    async def _finish_cancelled(self, item: _TurnItem) -> None:
        async with self._condition:
            self._active = None
            if item.state == "running":
                item.state = "cancelled"
                self._cancelled += 1
                if not item.future.done():
                    if self._closed:
                        item.future.set_exception(EndpointActorClosed(self._closed_message()))
                    else:
                        item.future.cancel()

    def _closed_message(self) -> str:
        suffix = f": {self._close_reason}" if self._close_reason else ""
        return f"endpoint actor is closed{suffix}"


class DynamicEndpointActors:
    """Runtime-discovered actor set with no configured endpoint slots."""

    def __init__(self, *, mailbox_capacity: int):
        if mailbox_capacity < 1:
            raise ValueError("endpoint mailbox capacity must be positive")
        self.mailbox_capacity = int(mailbox_capacity)
        self._actors: dict[str, EndpointActor] = {}
        self._lock = asyncio.Lock()

    async def add_endpoint(self, endpoint_id: str, room: str) -> EndpointActor:
        normalized_endpoint = canonical_uuid(endpoint_id, "endpoint_id")
        async with self._lock:
            if normalized_endpoint in self._actors:
                raise ValueError("endpoint actor already exists")
            actor = EndpointActor(
                normalized_endpoint,
                room,
                mailbox_capacity=self.mailbox_capacity,
            )
            self._actors[normalized_endpoint] = actor
        await actor.start()
        return actor

    async def move_endpoint(self, endpoint_id: str, room: str) -> None:
        actor = await self._require(endpoint_id)
        await actor.move_room(room)

    async def remove_endpoint(self, endpoint_id: str, *, reason: str = "endpoint_disconnected") -> bool:
        normalized_endpoint = canonical_uuid(endpoint_id, "endpoint_id")
        async with self._lock:
            actor = self._actors.pop(normalized_endpoint, None)
        if actor is None:
            return False
        await actor.close(reason)
        return True

    async def submit(
        self,
        endpoint_id: str,
        turn_id: str,
        handler: Callable[[TurnContext], Awaitable[Any]],
        *,
        timeout_seconds: float,
    ) -> Any:
        actor = await self._require(endpoint_id)
        return await actor.submit(turn_id, handler, timeout_seconds=timeout_seconds)

    async def snapshot(self) -> FleetActorSnapshot:
        async with self._lock:
            actors = list(self._actors.values())
        snapshots = await asyncio.gather(*(actor.snapshot() for actor in actors))
        return FleetActorSnapshot(
            actor_count=len(snapshots),
            queued_turns=sum(snapshot.queued for snapshot in snapshots),
            active_turns=sum(1 for snapshot in snapshots if snapshot.active),
            mailbox_capacity_total=sum(snapshot.mailbox_capacity for snapshot in snapshots),
        )

    async def close(self) -> None:
        async with self._lock:
            actors = list(self._actors.values())
            self._actors.clear()
        await asyncio.gather(
            *(actor.close("fleet_shutdown") for actor in actors),
            return_exceptions=True,
        )

    async def _require(self, endpoint_id: str) -> EndpointActor:
        normalized_endpoint = canonical_uuid(endpoint_id, "endpoint_id")
        async with self._lock:
            actor = self._actors.get(normalized_endpoint)
        if actor is None:
            raise EndpointActorClosed("endpoint actor is not connected")
        return actor


def _normalize_room(room: str) -> str:
    normalized = " ".join(str(room or "").split()).strip()
    if not normalized:
        raise ValueError("endpoint room is required")
    if len(normalized) > 128:
        raise ValueError("endpoint room exceeds length limit")
    return normalized
