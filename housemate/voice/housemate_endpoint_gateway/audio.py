"""Binary PCM framing and bounded in-memory buffers for fleet audio."""

from __future__ import annotations

import dataclasses
import struct
import threading
import uuid
from collections import deque


AUDIO_MAGIC = b"JVA2"
AUDIO_PROTOCOL_VERSION = 2
AUDIO_HEADER = struct.Struct(">4sBBH16sIQB3xI")
AUDIO_HEADER_BYTES = AUDIO_HEADER.size
MAX_AUDIO_PAYLOAD_BYTES = 32 * 1024

KIND_MICROPHONE = 1
KIND_REPLY = 2
VALID_KINDS = frozenset({KIND_MICROPHONE, KIND_REPLY})

FLAG_START = 1 << 0
FLAG_END = 1 << 1
VALID_FLAGS = FLAG_START | FLAG_END

FORMAT_PCM_S16LE_16K_MONO = 1
FORMAT_PCM_S16LE_24K_MONO = 2


class AudioProtocolError(ValueError):
    """Raised when an audio frame or stream violates the wire contract."""


class AudioBackpressure(RuntimeError):
    """Raised before a bounded audio buffer would exceed its limits."""


class AudioBufferEmpty(LookupError):
    """Raised when a non-blocking buffer read has no frame available."""


class AudioBufferClosed(RuntimeError):
    """Raised when a producer writes after close or cancellation."""


@dataclasses.dataclass(frozen=True, slots=True)
class AudioFormat:
    format_id: int
    label: str
    sample_rate: int
    channels: int
    sample_width: int

    @property
    def bytes_per_second(self) -> int:
        return self.sample_rate * self.channels * self.sample_width

    @property
    def frame_alignment(self) -> int:
        return self.channels * self.sample_width


AUDIO_FORMATS = {
    FORMAT_PCM_S16LE_16K_MONO: AudioFormat(
        format_id=FORMAT_PCM_S16LE_16K_MONO,
        label="pcm_s16le_16k_mono",
        sample_rate=16_000,
        channels=1,
        sample_width=2,
    ),
    FORMAT_PCM_S16LE_24K_MONO: AudioFormat(
        format_id=FORMAT_PCM_S16LE_24K_MONO,
        label="pcm_s16le_24k_mono",
        sample_rate=24_000,
        channels=1,
        sample_width=2,
    ),
}


@dataclasses.dataclass(frozen=True, slots=True)
class AudioFrame:
    kind: int
    flags: int
    stream_id: str
    sequence: int
    timestamp_us: int
    format_id: int
    payload: bytes

    def __post_init__(self) -> None:
        if self.kind not in VALID_KINDS:
            raise AudioProtocolError("audio frame kind is unsupported")
        if self.flags < 0 or self.flags & ~VALID_FLAGS:
            raise AudioProtocolError("audio frame flags are unsupported")
        try:
            parsed_stream_id = uuid.UUID(self.stream_id)
        except (ValueError, AttributeError) as err:
            raise AudioProtocolError("audio stream_id must be a UUID") from err
        if str(parsed_stream_id) != self.stream_id:
            raise AudioProtocolError("audio stream_id must use canonical UUID form")
        if self.sequence < 0 or self.sequence > 0xFFFFFFFF:
            raise AudioProtocolError("audio sequence is outside uint32 range")
        if self.timestamp_us < 0 or self.timestamp_us > 0xFFFFFFFFFFFFFFFF:
            raise AudioProtocolError("audio timestamp is outside uint64 range")
        audio_format = format_for_id(self.format_id)
        if not isinstance(self.payload, bytes):
            raise AudioProtocolError("audio payload must be immutable bytes")
        if not self.payload and not self.flags & FLAG_END:
            raise AudioProtocolError("empty audio payload is allowed only for END")
        if len(self.payload) > MAX_AUDIO_PAYLOAD_BYTES:
            raise AudioProtocolError("audio payload exceeds byte limit")
        if len(self.payload) % audio_format.frame_alignment != 0:
            raise AudioProtocolError("audio payload is not sample-aligned")

    @property
    def audio_format(self) -> AudioFormat:
        return format_for_id(self.format_id)

    @property
    def sample_count(self) -> int:
        return len(self.payload) // self.audio_format.frame_alignment

    @property
    def duration_us(self) -> int:
        return (self.sample_count * 1_000_000) // self.audio_format.sample_rate

    @property
    def wire_size(self) -> int:
        return AUDIO_HEADER_BYTES + len(self.payload)

    def encode(self) -> bytes:
        header = AUDIO_HEADER.pack(
            AUDIO_MAGIC,
            AUDIO_PROTOCOL_VERSION,
            self.kind,
            self.flags,
            uuid.UUID(self.stream_id).bytes,
            self.sequence,
            self.timestamp_us,
            self.format_id,
            len(self.payload),
        )
        return header + self.payload

    @classmethod
    def decode(cls, raw: bytes | bytearray | memoryview) -> "AudioFrame":
        if not isinstance(raw, (bytes, bytearray, memoryview)):
            raise AudioProtocolError("audio frame must be bytes")
        encoded = bytes(raw)
        if len(encoded) < AUDIO_HEADER_BYTES:
            raise AudioProtocolError("audio frame is shorter than its header")
        if len(encoded) > AUDIO_HEADER_BYTES + MAX_AUDIO_PAYLOAD_BYTES:
            raise AudioProtocolError("audio frame exceeds byte limit")
        (
            magic,
            version,
            kind,
            flags,
            stream_bytes,
            sequence,
            timestamp_us,
            format_id,
            payload_length,
        ) = AUDIO_HEADER.unpack(encoded[:AUDIO_HEADER_BYTES])
        if magic != AUDIO_MAGIC:
            raise AudioProtocolError("audio frame magic is invalid")
        if version != AUDIO_PROTOCOL_VERSION:
            raise AudioProtocolError("audio protocol version is unsupported")
        if payload_length > MAX_AUDIO_PAYLOAD_BYTES:
            raise AudioProtocolError("audio payload exceeds byte limit")
        if len(encoded) != AUDIO_HEADER_BYTES + payload_length:
            raise AudioProtocolError("audio payload length does not match header")
        return cls(
            kind=kind,
            flags=flags,
            stream_id=str(uuid.UUID(bytes=stream_bytes)),
            sequence=sequence,
            timestamp_us=timestamp_us,
            format_id=format_id,
            payload=encoded[AUDIO_HEADER_BYTES:],
        )


class AudioStreamValidator:
    """Validates one ordered stream without retaining its audio payloads."""

    def __init__(self, expected_kind: int):
        if expected_kind not in VALID_KINDS:
            raise ValueError("expected audio kind is unsupported")
        self._expected_kind = expected_kind
        self._stream_id: str | None = None
        self._format_id: int | None = None
        self._next_sequence = 0
        self._minimum_timestamp_us = 0
        self._finished = False
        self._cancelled = False
        self._frames_seen = 0
        self._payload_bytes_seen = 0

    @property
    def stream_id(self) -> str | None:
        return self._stream_id

    @property
    def format_id(self) -> int | None:
        return self._format_id

    @property
    def finished(self) -> bool:
        return self._finished

    @property
    def frames_seen(self) -> int:
        return self._frames_seen

    @property
    def payload_bytes_seen(self) -> int:
        return self._payload_bytes_seen

    def accept(self, frame: AudioFrame) -> None:
        if self._cancelled:
            raise AudioProtocolError("audio stream is cancelled")
        if self._finished:
            raise AudioProtocolError("audio frame arrived after stream end")
        if frame.kind != self._expected_kind:
            raise AudioProtocolError("audio frame kind changed within stream")
        if self._stream_id is None:
            if not frame.flags & FLAG_START:
                raise AudioProtocolError("first audio frame must carry START")
            if frame.sequence != 0:
                raise AudioProtocolError("first audio frame sequence must be zero")
            self._stream_id = frame.stream_id
            self._format_id = frame.format_id
            self._minimum_timestamp_us = frame.timestamp_us
        else:
            if frame.flags & FLAG_START:
                raise AudioProtocolError("START appeared after first audio frame")
            if frame.stream_id != self._stream_id:
                raise AudioProtocolError("audio stream_id changed within stream")
            if frame.format_id != self._format_id:
                raise AudioProtocolError("audio format changed within stream")
        if frame.sequence != self._next_sequence:
            raise AudioProtocolError(
                f"audio sequence gap: expected {self._next_sequence}, got {frame.sequence}"
            )
        if frame.timestamp_us < self._minimum_timestamp_us:
            raise AudioProtocolError("audio timestamp moved backwards or overlapped")
        self._next_sequence = frame.sequence + 1
        self._minimum_timestamp_us = frame.timestamp_us + frame.duration_us
        self._frames_seen += 1
        self._payload_bytes_seen += len(frame.payload)
        if frame.flags & FLAG_END:
            self._finished = True

    def cancel(self) -> None:
        self._cancelled = True


class BoundedAudioBuffer:
    """Non-blocking frame buffer with both count and byte ceilings."""

    def __init__(self, *, max_frames: int, max_bytes: int):
        if max_frames < 1:
            raise ValueError("max_frames must be positive")
        if max_bytes < AUDIO_HEADER_BYTES:
            raise ValueError("max_bytes is too small for one audio frame")
        self._max_frames = int(max_frames)
        self._max_bytes = int(max_bytes)
        self._frames: deque[AudioFrame] = deque()
        self._buffered_bytes = 0
        self._peak_frames = 0
        self._peak_bytes = 0
        self._closed = False
        self._cancelled = False
        self._cancel_reason = ""
        self._lock = threading.Lock()

    @property
    def max_frames(self) -> int:
        return self._max_frames

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    @property
    def buffered_frames(self) -> int:
        with self._lock:
            return len(self._frames)

    @property
    def buffered_bytes(self) -> int:
        with self._lock:
            return self._buffered_bytes

    @property
    def peak_frames(self) -> int:
        with self._lock:
            return self._peak_frames

    @property
    def peak_bytes(self) -> int:
        with self._lock:
            return self._peak_bytes

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    @property
    def cancel_reason(self) -> str:
        with self._lock:
            return self._cancel_reason

    def put(self, frame: AudioFrame) -> None:
        with self._lock:
            if self._closed or self._cancelled:
                raise AudioBufferClosed("audio buffer is closed")
            candidate_bytes = self._buffered_bytes + frame.wire_size
            if len(self._frames) >= self._max_frames or candidate_bytes > self._max_bytes:
                raise AudioBackpressure("audio buffer capacity exceeded")
            self._frames.append(frame)
            self._buffered_bytes = candidate_bytes
            self._peak_frames = max(self._peak_frames, len(self._frames))
            self._peak_bytes = max(self._peak_bytes, self._buffered_bytes)

    def get(self) -> AudioFrame:
        with self._lock:
            if not self._frames:
                raise AudioBufferEmpty("audio buffer is empty")
            frame = self._frames.popleft()
            self._buffered_bytes -= frame.wire_size
            return frame

    def close(self) -> None:
        with self._lock:
            self._closed = True

    def cancel(self, reason: str) -> None:
        with self._lock:
            self._frames.clear()
            self._buffered_bytes = 0
            self._cancelled = True
            self._closed = True
            self._cancel_reason = " ".join(str(reason or "cancelled").split()).strip() or "cancelled"


def format_for_id(format_id: int) -> AudioFormat:
    audio_format = AUDIO_FORMATS.get(format_id)
    if audio_format is None:
        raise AudioProtocolError("audio format is unsupported")
    return audio_format
