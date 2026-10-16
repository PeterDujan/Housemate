"""Fair, bounded scheduling for shared endpoint provider resources."""

from __future__ import annotations

import asyncio
import dataclasses
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from .protocol import canonical_uuid


class ResourceBusy(RuntimeError):
    """Raised when a provider queue cannot accept more work."""


class ResourceDeadlineExceeded(TimeoutError):
    """Raised when queued or running provider work misses its deadline."""


class ResourcePoolClosed(RuntimeError):
    """Raised when work is submitted to a closed provider pool."""


@dataclasses.dataclass(frozen=True, slots=True)
class ResourcePoolSnapshot:
    name: str
    capacity: int
    max_queued: int
    queued: int
    active: int
    peak_queued: int
    peak_active: int
    completed: int
    failed: int
    rejected: int
    expired: int
    cancelled: int


@dataclasses.dataclass(slots=True, eq=False)
class _WorkItem:
    endpoint_id: str
    operation: Callable[[], Awaitable[Any]]
    deadline: float
    future: asyncio.Future
    state: str = "queued"
    running_task: asyncio.Future | None = None


class FairResourcePool:
    """Provider pool with bounded waiting and round-robin endpoint fairness."""

    def __init__(
        self,
        name: str,
        *,
        capacity: int,
        max_queued: int,
        clock: Callable[[], float] = time.monotonic,
    ):
        normalized_name = " ".join(str(name or "").split()).strip()
        if not normalized_name or len(normalized_name) > 64:
            raise ValueError("resource pool name is missing or too long")
        if capacity < 1:
            raise ValueError("resource pool capacity must be positive")
        if max_queued < 1:
            raise ValueError("resource queue capacity must be positive")
        self.name = normalized_name
        self.capacity = int(capacity)
        self.max_queued = int(max_queued)
        self._clock = clock
        self._condition = asyncio.Condition()
        self._queues: dict[str, deque[_WorkItem]] = {}
        self._rotation: deque[str] = deque()
        self._queued = 0
        self._active = 0
        self._peak_queued = 0
        self._peak_active = 0
        self._completed = 0
        self._failed = 0
        self._rejected = 0
        self._expired = 0
        self._cancelled = 0
        self._workers: list[asyncio.Task] = []
        self._closed = False

    async def start(self) -> None:
        async with self._condition:
            if self._closed:
                raise ResourcePoolClosed(f"resource pool {self.name} is closed")
            if self._workers:
                return
            self._workers = [
                asyncio.create_task(
                    self._worker(),
                    name=f"housemate-resource-{self.name}-{index}",
                )
                for index in range(self.capacity)
            ]

    async def submit(
        self,
        endpoint_id: str,
        operation: Callable[[], Awaitable[Any]],
        *,
        timeout_seconds: float,
    ) -> Any:
        normalized_endpoint = canonical_uuid(endpoint_id, "endpoint_id")
        if not callable(operation):
            raise TypeError("resource operation must be callable")
        if timeout_seconds <= 0:
            raise ResourceDeadlineExceeded("resource deadline must be positive")
        await self.start()
        loop = asyncio.get_running_loop()
        item = _WorkItem(
            endpoint_id=normalized_endpoint,
            operation=operation,
            deadline=float(self._clock()) + float(timeout_seconds),
            future=loop.create_future(),
        )
        async with self._condition:
            if self._closed:
                raise ResourcePoolClosed(f"resource pool {self.name} is closed")
            if self._queued >= self.max_queued:
                self._rejected += 1
                raise ResourceBusy(f"resource pool {self.name} queue is full")
            endpoint_queue = self._queues.get(normalized_endpoint)
            if endpoint_queue is None:
                endpoint_queue = deque()
                self._queues[normalized_endpoint] = endpoint_queue
                self._rotation.append(normalized_endpoint)
            endpoint_queue.append(item)
            self._queued += 1
            self._peak_queued = max(self._peak_queued, self._queued)
            self._condition.notify(1)
        try:
            return await asyncio.shield(item.future)
        except asyncio.CancelledError:
            await self._cancel_item(item)
            raise

    async def snapshot(self) -> ResourcePoolSnapshot:
        async with self._condition:
            return ResourcePoolSnapshot(
                name=self.name,
                capacity=self.capacity,
                max_queued=self.max_queued,
                queued=self._queued,
                active=self._active,
                peak_queued=self._peak_queued,
                peak_active=self._peak_active,
                completed=self._completed,
                failed=self._failed,
                rejected=self._rejected,
                expired=self._expired,
                cancelled=self._cancelled,
            )

    async def close(self) -> None:
        async with self._condition:
            if self._closed:
                workers = list(self._workers)
            else:
                self._closed = True
                for endpoint_queue in self._queues.values():
                    while endpoint_queue:
                        item = endpoint_queue.popleft()
                        item.state = "cancelled"
                        if not item.future.done():
                            item.future.set_exception(
                                ResourcePoolClosed(f"resource pool {self.name} closed")
                            )
                        self._cancelled += 1
                self._queues.clear()
                self._rotation.clear()
                self._queued = 0
                workers = list(self._workers)
                self._condition.notify_all()
        for worker in workers:
            if not worker.done():
                worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)

    async def _cancel_item(self, item: _WorkItem) -> None:
        running_task = None
        async with self._condition:
            if item.state == "queued":
                endpoint_queue = self._queues.get(item.endpoint_id)
                if endpoint_queue is not None:
                    try:
                        endpoint_queue.remove(item)
                    except ValueError:
                        pass
                    else:
                        self._queued -= 1
                    if not endpoint_queue:
                        self._queues.pop(item.endpoint_id, None)
                        try:
                            self._rotation.remove(item.endpoint_id)
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

    async def _take_next(self) -> _WorkItem | None:
        async with self._condition:
            while True:
                while self._rotation:
                    endpoint_id = self._rotation.popleft()
                    endpoint_queue = self._queues.get(endpoint_id)
                    if not endpoint_queue:
                        self._queues.pop(endpoint_id, None)
                        continue
                    item = endpoint_queue.popleft()
                    self._queued -= 1
                    if endpoint_queue:
                        self._rotation.append(endpoint_id)
                    else:
                        self._queues.pop(endpoint_id, None)
                    if item.state != "queued" or item.future.cancelled():
                        continue
                    item.state = "running"
                    self._active += 1
                    self._peak_active = max(self._peak_active, self._active)
                    return item
                if self._closed:
                    return None
                await self._condition.wait()

    async def _worker(self) -> None:
        while True:
            item = await self._take_next()
            if item is None:
                return
            now = float(self._clock())
            if now >= item.deadline:
                await self._finish_expired(item)
                continue
            try:
                operation_task = asyncio.ensure_future(item.operation())
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

    async def _finish_completed(self, item: _WorkItem, result: Any) -> None:
        async with self._condition:
            self._active -= 1
            if item.state == "running":
                item.state = "done"
                self._completed += 1
                if not item.future.done():
                    item.future.set_result(result)

    async def _finish_failed(self, item: _WorkItem, error: Exception) -> None:
        async with self._condition:
            self._active -= 1
            if item.state == "running":
                item.state = "done"
                self._failed += 1
                if not item.future.done():
                    item.future.set_exception(error)

    async def _finish_expired(self, item: _WorkItem) -> None:
        async with self._condition:
            self._active -= 1
            if item.state == "running":
                item.state = "done"
                self._expired += 1
                if not item.future.done():
                    item.future.set_exception(
                        ResourceDeadlineExceeded(
                            f"resource pool {self.name} deadline exceeded"
                        )
                    )

    async def _finish_cancelled(self, item: _WorkItem) -> None:
        async with self._condition:
            self._active -= 1
            if item.state == "running":
                item.state = "cancelled"
                self._cancelled += 1
                if not item.future.done():
                    if self._closed:
                        item.future.set_exception(
                            ResourcePoolClosed(f"resource pool {self.name} closed")
                        )
                    else:
                        item.future.cancel()
