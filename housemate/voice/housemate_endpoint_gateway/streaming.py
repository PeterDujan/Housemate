"""Hermetic streaming turn pipeline for endpoint audio."""

from __future__ import annotations

import dataclasses
import time
import uuid
from collections.abc import Iterable, Iterator
from typing import Protocol

from .audio import (
    FLAG_END,
    FLAG_START,
    FORMAT_PCM_S16LE_24K_MONO,
    KIND_MICROPHONE,
    KIND_REPLY,
    MAX_AUDIO_PAYLOAD_BYTES,
    AudioBackpressure,
    AudioBufferEmpty,
    AudioFrame,
    AudioProtocolError,
    AudioStreamValidator,
    BoundedAudioBuffer,
    format_for_id,
)


class StreamingPipelineError(RuntimeError):
    """Raised after a turn pipeline cancels and releases its resources."""


class StreamingSttSession(Protocol):
    def feed_audio(self, pcm: bytes, *, timestamp_us: int, format_id: int) -> None: ...

    def finish(self) -> str: ...

    def cancel(self, reason: str) -> None: ...


class ProgressiveBrainSession(Protocol):
    def stream_segments(self, transcript: str, *, room: str, session_id: str) -> Iterable[str]: ...

    def cancel(self, reason: str) -> None: ...


class StreamingTtsSession(Protocol):
    def stream_pcm(self, text: str, *, format_id: int) -> Iterable[bytes]: ...

    def cancel(self, reason: str) -> None: ...


@dataclasses.dataclass(slots=True)
class StreamingTurnMetrics:
    microphone_frames_received: int = 0
    microphone_frames_processed: int = 0
    microphone_payload_bytes: int = 0
    stt_chunks_forwarded: int = 0
    reply_frames_produced: int = 0
    reply_payload_bytes: int = 0
    gateway_processing_ns: int = 0
    cancel_reason: str = ""


class StreamingTurnPipeline:
    """One bounded voice turn with no whole-turn audio accumulation."""

    def __init__(
        self,
        *,
        endpoint_id: str,
        room: str,
        session_id: str,
        stt: StreamingSttSession,
        brain: ProgressiveBrainSession,
        tts: StreamingTtsSession,
        input_max_frames: int = 64,
        input_max_bytes: int = 256 * 1024,
        output_max_frames: int = 64,
        output_max_bytes: int = 512 * 1024,
        reply_format_id: int = FORMAT_PCM_S16LE_24K_MONO,
        reply_stream_id: str | None = None,
        reply_timestamp_us: int = 0,
    ):
        self.endpoint_id = endpoint_id
        self.room = " ".join(str(room or "").split()).strip()
        self.session_id = session_id
        self._stt = stt
        self._brain = brain
        self._tts = tts
        self.input_buffer = BoundedAudioBuffer(
            max_frames=input_max_frames,
            max_bytes=input_max_bytes,
        )
        self.output_buffer = BoundedAudioBuffer(
            max_frames=output_max_frames,
            max_bytes=output_max_bytes,
        )
        self._input_validator = AudioStreamValidator(KIND_MICROPHONE)
        self._reply_format_id = reply_format_id
        format_for_id(reply_format_id)
        self._reply_stream_id = reply_stream_id or str(uuid.uuid4())
        try:
            uuid.UUID(self._reply_stream_id)
        except (ValueError, AttributeError) as err:
            raise ValueError("reply_stream_id must be a UUID") from err
        self._reply_timestamp_us = int(reply_timestamp_us)
        if self._reply_timestamp_us < 0:
            raise ValueError("reply_timestamp_us must not be negative")
        self._reply_frames: Iterator[AudioFrame] | None = None
        self._state = "receiving"
        self._transcript: str | None = None
        self.metrics = StreamingTurnMetrics()

    @property
    def state(self) -> str:
        return self._state

    @property
    def transcript(self) -> str | None:
        return self._transcript

    def receive_microphone_frame(self, raw_frame: bytes) -> None:
        if self._state != "receiving":
            raise StreamingPipelineError(f"turn is not receiving audio: {self._state}")
        started = time.perf_counter_ns()
        try:
            frame = AudioFrame.decode(raw_frame)
            if frame.kind != KIND_MICROPHONE:
                raise AudioProtocolError("turn input requires microphone frames")
            self.input_buffer.put(frame)
            self.metrics.microphone_frames_received += 1
        except Exception as err:
            self.cancel(_stable_reason("microphone_receive_failed", err))
            raise
        finally:
            self.metrics.gateway_processing_ns += time.perf_counter_ns() - started

    def process_microphone(self, *, max_frames: int | None = None) -> int:
        if self._state != "receiving":
            return 0
        processed = 0
        try:
            while max_frames is None or processed < max_frames:
                started = time.perf_counter_ns()
                try:
                    frame = self.input_buffer.get()
                except AudioBufferEmpty:
                    break
                self._input_validator.accept(frame)
                self.metrics.microphone_frames_processed += 1
                self.metrics.microphone_payload_bytes += len(frame.payload)
                self.metrics.gateway_processing_ns += time.perf_counter_ns() - started
                if frame.payload:
                    self._stt.feed_audio(
                        frame.payload,
                        timestamp_us=frame.timestamp_us,
                        format_id=frame.format_id,
                    )
                    self.metrics.stt_chunks_forwarded += 1
                processed += 1
                if frame.flags & FLAG_END:
                    if self.input_buffer.buffered_frames:
                        raise AudioProtocolError("microphone frames arrived after stream end")
                    self._finish_microphone()
                    break
        except Exception as err:
            self.cancel(_stable_reason("microphone_process_failed", err))
            if isinstance(err, (AudioProtocolError, AudioBackpressure, StreamingPipelineError)):
                raise
            raise StreamingPipelineError("microphone stream failed") from err
        return processed

    def pump_reply(self, *, max_frames: int = 1) -> int:
        if max_frames < 1:
            raise ValueError("max_frames must be positive")
        if self._state == "complete":
            return 0
        if self._state not in {"reply_ready", "replying"} or self._reply_frames is None:
            raise StreamingPipelineError(f"turn reply is not ready: {self._state}")
        produced = 0
        self._state = "replying"
        try:
            while produced < max_frames:
                try:
                    frame = next(self._reply_frames)
                except StopIteration:
                    self._state = "complete"
                    self.output_buffer.close()
                    break
                started = time.perf_counter_ns()
                self.output_buffer.put(frame)
                self.metrics.reply_frames_produced += 1
                self.metrics.reply_payload_bytes += len(frame.payload)
                self.metrics.gateway_processing_ns += time.perf_counter_ns() - started
                produced += 1
                if frame.flags & FLAG_END:
                    self._state = "complete"
                    self.output_buffer.close()
                    break
        except Exception as err:
            self.cancel(_stable_reason("reply_stream_failed", err))
            if isinstance(err, (AudioBackpressure, AudioProtocolError, StreamingPipelineError)):
                raise
            raise StreamingPipelineError("progressive reply stream failed") from err
        return produced

    def read_reply_frame(self) -> AudioFrame:
        return self.output_buffer.get()

    def cancel(self, reason: str) -> None:
        if self._state == "cancelled":
            return
        normalized_reason = " ".join(str(reason or "cancelled").split()).strip() or "cancelled"
        self._state = "cancelled"
        self.metrics.cancel_reason = normalized_reason
        self._input_validator.cancel()
        self.input_buffer.cancel(normalized_reason)
        self.output_buffer.cancel(normalized_reason)
        reply_frames = self._reply_frames
        self._reply_frames = None
        close = getattr(reply_frames, "close", None)
        if callable(close):
            close()
        for participant in (self._stt, self._brain, self._tts):
            cancel = getattr(participant, "cancel", None)
            if callable(cancel):
                try:
                    cancel(normalized_reason)
                except Exception:
                    continue

    def _finish_microphone(self) -> None:
        transcript = " ".join(str(self._stt.finish() or "").split()).strip()
        self._transcript = transcript
        self.input_buffer.close()
        self._reply_frames = self._iter_reply_frames(transcript)
        self._state = "reply_ready"

    def _iter_reply_frames(self, transcript: str) -> Iterator[AudioFrame]:
        sequence = 0
        timestamp_us = self._reply_timestamp_us
        first = True
        for segment in self._brain.stream_segments(
            transcript,
            room=self.room,
            session_id=self.session_id,
        ):
            normalized_segment = " ".join(str(segment or "").split()).strip()
            if not normalized_segment:
                continue
            for payload in self._tts.stream_pcm(
                normalized_segment,
                format_id=self._reply_format_id,
            ):
                for aligned_payload in _split_pcm_payload(payload, self._reply_format_id):
                    frame = AudioFrame(
                        kind=KIND_REPLY,
                        flags=FLAG_START if first else 0,
                        stream_id=self._reply_stream_id,
                        sequence=sequence,
                        timestamp_us=timestamp_us,
                        format_id=self._reply_format_id,
                        payload=aligned_payload,
                    )
                    yield frame
                    first = False
                    sequence += 1
                    timestamp_us += frame.duration_us
        yield AudioFrame(
            kind=KIND_REPLY,
            flags=(FLAG_START if first else 0) | FLAG_END,
            stream_id=self._reply_stream_id,
            sequence=sequence,
            timestamp_us=timestamp_us,
            format_id=self._reply_format_id,
            payload=b"",
        )


def _split_pcm_payload(payload: bytes, format_id: int) -> Iterator[bytes]:
    if not isinstance(payload, bytes):
        raise AudioProtocolError("TTS PCM chunk must be immutable bytes")
    if not payload:
        return
    audio_format = format_for_id(format_id)
    alignment = audio_format.frame_alignment
    if len(payload) % alignment != 0:
        raise AudioProtocolError("TTS PCM chunk is not sample-aligned")
    chunk_limit = MAX_AUDIO_PAYLOAD_BYTES - (MAX_AUDIO_PAYLOAD_BYTES % alignment)
    for offset in range(0, len(payload), chunk_limit):
        yield payload[offset:offset + chunk_limit]


def _stable_reason(prefix: str, error: Exception) -> str:
    detail = " ".join(str(error or "").split()).strip()
    return f"{prefix}: {detail}" if detail else prefix
