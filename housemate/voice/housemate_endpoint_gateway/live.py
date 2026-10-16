"""Live transport: one authenticated WebSocket per endpoint, voice turns over endpoint audio.

The endpoint sends text control frames (``endpoint_hello``, ``authenticate``, ``heartbeat``,
``turn_start``, ``turn_cancel``) and binary microphone frames. The gateway answers with text
status frames and binary reply frames. A turn's audio is handed to ``turn_handler`` - the Voice
Loop's live-stream turn - exactly as the browser bridge hands it over, and that handler's events are
translated back onto the socket. Nothing here transcribes, identifies a speaker, thinks or speaks.

Endpoint identity is transport identity only: the turn runs under ``endpoint:<endpoint_id>`` as its
client id, and speaker recognition still comes from the audio. No HA, the assistant, Fish or STT secret is
ever sent to the endpoint.
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import socket
import struct
import queue
import threading
import time
import uuid
import wave
from array import array
from typing import Any, Callable

from websockets.exceptions import ConnectionClosed
from websockets.sync.server import ServerConnection, serve

from .audio import (
    FLAG_END,
    FLAG_START,
    FORMAT_PCM_S16LE_16K_MONO,
    FORMAT_PCM_S16LE_24K_MONO,
    KIND_MICROPHONE,
    KIND_REPLY,
    AudioFrame,
    AudioProtocolError,
    AudioStreamValidator,
)
from .connection import AuthenticationError
from .protocol import ProtocolError, decode_control_frame, parse_turn_cancel, parse_turn_start
from .registry import RegistryError
from .service import GatewayControlPlane

REPLY_RATE = 24_000
REPLY_FRAME_SAMPLES = REPLY_RATE // 50  # 20 ms
MAX_MESSAGE_BYTES = 64 * 1024
HELLO_TIMEOUT_S = 10.0
AUTH_TIMEOUT_S = 15.0
# The input queue holds at most this much microphone audio; a slower STT than that is a stuck turn.
MAX_QUEUED_INPUT_FRAMES = 250  # 5 s of 20 ms frames
# A turn's microphone stream may not run longer than this, whatever the endpoint does.
MAX_TURN_INPUT_S = 30.0
MAX_TURN_INPUT_BYTES = int(MAX_TURN_INPUT_S * 16_000 * 2)

# The wake policy every endpoint is sent on connecting, so a speaker and the speaker are tuned in one
# place. Possible wakes (a score from candidate_floor up that never reached cutoff) are streamed
# silently and only answered once STT here confirms the phrase: "Hey Housemate what day is it" in one
# breath scores low on the stock model.
DEFAULT_WAKE_POLICY = {
    "candidate_enabled": True,
    "candidate_floor": 0.12,
    "cutoff": 0.70,
    "preroll_ms": 2000,
    "candidate_preroll_ms": 2500,
    "candidate_confirm_ms": 300,
    "candidate_max_ms": 8000,
    # Conversation, as the terminal has it: a turn may run 30 s, and after an answer the endpoint
    # listens on (no wake word) until the session ends or nobody speaks for follow_up_idle_ms.
    "max_turn_ms": 30000,
    "follow_up_idle_ms": 12000,
    # A bare "Hey Housemate": no greeting, the microphone stays open. Quiet this long
    # after the wake phrase ends the turn and the assistant acknowledges ("Mm-hm?"), then the follow-up he
    # opens listens this long before it lets go.
    "wake_pause_ms": 4000,
    "wake_ack_idle_ms": 8000,
    # The voice host's own backstop: words stopped arriving this long ago and STT has not ended the turn.
    "silence_backstop_ms": 8000,
    # The terminal's turn-boundary beep, played when listening starts again after an answer.
    "listen_cue_hz": 880,
    "listen_cue_ms": 100,
    "listen_cue_level": 0.12,
    # Its pair, lower: played when the voice host ends the speaker's turn, so they stop while the assistant answers.
    "end_cue_hz": 660,
    "end_cue_ms": 90,
    "end_cue_level": 0.12,
}
# Too many possible wakes turned down in a row means something in the room sounds like the phrase:
# stop streaming them from that endpoint for a while.
CANDIDATE_MAX_REJECTIONS = 5
CANDIDATE_REJECTION_WINDOW_S = 120.0
CANDIDATE_PAUSE_S = 120.0
# How long an endpoint-ended stream waits for STT's own end of turn before the voice host beeps it over.
INPUT_END_CUE_GRACE_S = 0.5
# The endpoint's playback runs a little behind what was sent (its buffer and the speaker's own).
PLAYBACK_TAIL_S = 0.3
# Statuses after which the session goes on, as the terminal's: listen again unless it ended.
_CONTINUES = frozenset({"wake_greeting", "wake_ack", "final_reply", "failure_fallback", "confirm_beep"})
# Meta statuses that mean the phrase was not confirmed.
_NOT_CONFIRMED = frozenset({"not_wake", "wake_only", "no_input"})
# Commands a turn's answer may send its endpoint once the turn is over.
_ENDPOINT_COMMANDS = frozenset({"calibrate"})
# "Hey Housemate, play calibration": the endpoint ends a session with a speechless turn
# under this wake word; its raw takes wait on CALIBRATION_PORT.
CALIBRATION_DONE_WORD = "calibration done"
CALIBRATION_CAPABILITY = "voice.calibration"
CALIBRATION_PORT = 6057
CALIBRATION_TEXT = "Calibration done."

TurnHandler = Callable[..., None]
_END = object()


class TurnCancelled(ConnectionAbortedError):
    """The endpoint cancelled the turn, disconnected, or broke the stream.

    A ConnectionAbortedError so the Voice Loop treats it as a client that went away: the turn stops
    and nothing is replayed through the legacy fallback.
    """


class LinearResampler:
    """Streaming mono s16le resampler (linear interpolation), stateful across chunks."""

    def __init__(self, source_rate: int, target_rate: int):
        if source_rate <= 0 or target_rate <= 0:
            raise ValueError("sample rates must be positive")
        self._step = source_rate / float(target_rate)
        self._pos = 0.0
        self._prev: int | None = None
        self._identity = source_rate == target_rate

    def feed(self, pcm: bytes) -> bytes:
        samples = array("h")
        samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
        if self._identity or not samples:
            return samples.tobytes()
        # Index 0 of `src` is the last sample of the previous chunk, so interpolation spans chunks.
        src = samples if self._prev is None else array("h", [self._prev]) + samples
        out = array("h")
        pos = self._pos
        last = len(src) - 1
        while pos < last:
            i = int(pos)
            frac = pos - i
            out.append(int(round(src[i] + (src[i + 1] - src[i]) * frac)))
            pos += self._step
        self._pos = pos - last
        self._prev = src[last]
        return out.tobytes()


def _clip_pcm(clip: dict[str, Any]) -> tuple[bytes, int, int]:
    """A prepared clip's s16le PCM, rate and channels, from its base64 WAV."""
    if str(clip.get("mime_type") or "") != "audio/wav":
        raise ValueError("clip is not audio/wav")
    with wave.open(io.BytesIO(base64.b64decode(str(clip.get("audio_base64") or ""), validate=True))) as w:
        if w.getsampwidth() != 2:
            raise ValueError("clip is not 16-bit")
        return w.readframes(w.getnframes()), w.getframerate(), w.getnchannels()


class _ReplyStream:
    """One reply's audio frames: 24 kHz mono, 20 ms each, START on the first and an empty END last."""

    def __init__(self, send_binary: Callable[[bytes], None], source_rate: int, channels: int):
        self.stream_id = str(uuid.uuid4())
        self._send = send_binary
        self._channels = max(1, int(channels or 1))
        self._bytes_per_ms = 2 * self._channels * max(1, int(source_rate)) / 1000.0
        self._resampler = LinearResampler(int(source_rate), REPLY_RATE)
        self._pending = bytearray()
        self._sequence = 0
        self._timestamp_us = 0
        self.frames = 0

    def duration_ms(self, pcm: bytes) -> float:
        return len(pcm) / self._bytes_per_ms

    def _mono(self, pcm: bytes) -> bytes:
        if self._channels == 1:
            return pcm
        samples = array("h")
        samples.frombytes(pcm[: len(pcm) - (len(pcm) % (2 * self._channels))])
        mono = array("h", (
            int(sum(samples[i:i + self._channels]) / self._channels)
            for i in range(0, len(samples), self._channels)
        ))
        return mono.tobytes()

    def _emit(self, payload: bytes, *, end: bool = False) -> None:
        flags = (FLAG_START if self._sequence == 0 else 0) | (FLAG_END if end else 0)
        frame = AudioFrame(
            kind=KIND_REPLY,
            flags=flags,
            stream_id=self.stream_id,
            sequence=self._sequence,
            timestamp_us=self._timestamp_us,
            format_id=FORMAT_PCM_S16LE_24K_MONO,
            payload=bytes(payload),
        )
        self._send(frame.encode())
        self._sequence += 1
        self._timestamp_us += frame.duration_us
        self.frames += 1

    def feed(self, pcm: bytes) -> None:
        self._pending.extend(self._resampler.feed(self._mono(pcm)))
        size = REPLY_FRAME_SAMPLES * 2
        while len(self._pending) >= size:
            self._emit(self._pending[:size])
            del self._pending[:size]

    def close(self) -> None:
        if self._pending:
            self._emit(self._pending)
            self._pending.clear()
        self._emit(b"", end=True)


class _Turn:
    """One voice turn on one endpoint connection."""

    def __init__(self, conn: "_EndpointConnection", stream_id: str, wake_word: str, candidate: bool = False,
                 follow_up: bool = False, idle_ms: float = 12000):
        self.conn = conn
        self.stream_id = stream_id
        self.wake_word = wake_word
        self.candidate = candidate
        self.follow_up = follow_up
        self.idle_s = idle_ms / 1000.0
        self.speech_heard = threading.Event()
        self.last_progress = 0.0
        # When the words so far became only the wake phrase (0: they are not).
        self.wake_only_at = 0.0
        self.input_closed = threading.Event()
        self.input_closed_at = 0.0
        self.end_sent = False
        self.cue_sent = False
        self.listen_cue_sent = False
        self.music_hold = False
        self.continues = False
        self.endpoint_command: dict[str, Any] | None = None
        self.verdict = ""  # "confirmed" or "rejected" once a possible wake is decided
        self.validator = AudioStreamValidator(KIND_MICROPHONE)
        self.input: queue.Queue = queue.Queue(maxsize=MAX_QUEUED_INPUT_FRAMES + 1)
        self.cancelled = threading.Event()
        self.cancel_reason = ""
        self.input_bytes = 0
        self.reply: _ReplyStream | None = None
        self.reply_frames = 0
        self.started = time.monotonic()
        self.thread: threading.Thread | None = None

    # ---- microphone side (socket thread) ----
    def accept_frame(self, frame: AudioFrame) -> None:
        if frame.stream_id != self.stream_id:
            raise AudioProtocolError("microphone frame is not for the open turn")
        if frame.format_id != FORMAT_PCM_S16LE_16K_MONO:
            raise AudioProtocolError("microphone frames must be 16 kHz mono s16le")
        self.validator.accept(frame)
        if frame.payload:
            self.input_bytes += len(frame.payload)
            if self.input_bytes > MAX_TURN_INPUT_BYTES:
                self.input_end()
                return
            try:
                self.input.put_nowait(frame.payload)
            except queue.Full:
                self.cancel("input_backpressure")
                return
        if frame.flags & FLAG_END:
            self.input_end()

    def input_end(self) -> None:
        self.input_closed_at = self.input_closed_at or time.monotonic()
        self.input_closed.set()
        with contextlib.suppress(queue.Full):
            self.input.put_nowait(_END)

    def cancel(self, reason: str) -> None:
        if self.cancelled.is_set():
            return
        self.cancel_reason = reason
        self.cancelled.set()
        self.validator.cancel()
        with contextlib.suppress(queue.Full):
            self.input.put_nowait(_END)

    def audio_chunks(self):
        while True:
            if self.cancelled.is_set():
                raise TurnCancelled(self.cancel_reason or "cancelled")
            try:
                item = self.input.get(timeout=MAX_TURN_INPUT_S)
            except queue.Empty as err:
                raise TurnCancelled("input_timeout") from err
            if self.cancelled.is_set():
                raise TurnCancelled(self.cancel_reason or "cancelled")
            if item is _END:
                return
            yield item

    # ---- reply side (turn thread): the Voice Loop's stream events ----
    def _decide(self, confirmed: bool) -> None:
        """A possible wake's verdict, sent once, before anything that depends on it."""
        if not self.candidate or self.verdict:
            return
        self.verdict = "confirmed" if confirmed else "rejected"
        self.conn.send_json({"type": "wake_confirmed" if confirmed else "wake_rejected", "stream_id": self.stream_id})
        if not confirmed:
            self.conn.candidate_rejected()
        else:
            self._listen_cue()
            self.conn.music_listening()
            self._end_cue()

    def write_event(self, payload: dict[str, Any]) -> None:
        if self.cancelled.is_set():
            raise TurnCancelled(self.cancel_reason or "cancelled")
        event = str(payload.get("event") or "")
        if event == "speech_progress":
            self.last_progress = time.monotonic()
            self.speech_heard.set()
            if payload.get("wake_only"):
                self.wake_only_at = self.wake_only_at or self.last_progress
            else:
                self.wake_only_at = 0.0
            return
        if event in ("wake_heard", "audio_open"):
            # wake_heard: the Voice Loop's interim transcript already holds the wake phrase.
            self._decide(True)
        elif event == "meta":
            self._decide(str(payload.get("status") or "") not in _NOT_CONFIRMED)
        if event == "end_of_turn":
            self._end_turn()
        elif event == "end_of_turn_wake_only":
            # STT ended a turn holding only the wake phrase, so the speaker has paused after it. The
            # microphone stays open for the request; `_watch` ends the turn after wake_pause_ms of quiet.
            self.wake_only_at = self.wake_only_at or time.monotonic()
            self._listen_cue()
        elif event == "meta":
            status = str(payload.get("status") or "")
            if status == "wake_ack":
                self.conn._after_ack = True
            # The command left the music as it wants it (pause, stop, a new song): no playing it again.
            self.music_hold = bool(payload.get("music_hold"))
            command = payload.get("endpoint_command")
            if isinstance(command, dict) and command.get("type") in _ENDPOINT_COMMANDS:
                self.endpoint_command = dict(command)
            # The session goes on, and he asked something: the endpoint listens again (stock Echo behaviour).
            self.continues = (status in _CONTINUES and not bool(payload.get("end_session", False))
                              and bool(payload.get("listen_again", True)))
            self.conn.send_json({
                "type": "turn_result",
                "stream_id": self.stream_id,
                "status": status,
                "heard_text": payload.get("heard_text"),
                "reply_text": payload.get("reply_text"),
                "end_session": bool(payload.get("end_session", False)),
                "error_code": payload.get("error_code"),
                # The session goes on and he asked something: the endpoint listens again without the wake word.
                "continue": self.continues,
            })
        elif event == "audio_open":
            self._close_reply()
            self.reply = _ReplyStream(
                self.conn.send_binary,
                int(payload.get("sample_rate") or REPLY_RATE),
                int(payload.get("channels") or 1),
            )
            self.conn.send_json({
                "type": "reply_start",
                "stream_id": self.stream_id,
                "reply_stream_id": self.reply.stream_id,
                "phase": payload.get("phase"),
                "format": "pcm_s16le_24k_mono",
            })
        elif event == "audio_chunk":
            if self.reply is None:
                return
            self._feed_reply(base64.b64decode(str(payload.get("audio_base64") or ""), validate=True))
        elif event == "audio_close":
            self._close_reply()
        elif event == "audio_clip":
            # A whole prepared clip (a greeting): played as its own reply stream.
            clip = payload.get("clip") if isinstance(payload.get("clip"), dict) else {}
            try:
                pcm, rate, channels = _clip_pcm(clip)
            except (ValueError, wave.Error, EOFError) as err:
                self.conn.log_event("endpoint_reply_clip_skipped", stream_id=self.stream_id, detail=str(err)[:120])
                return
            self.write_event({"event": "audio_open", "sample_rate": rate, "channels": channels,
                              "phase": clip.get("phase")})
            self._feed_reply(pcm)
            self._close_reply()

    def _feed_reply(self, pcm: bytes) -> None:
        self.reply.feed(pcm)
        self.conn.reply_audio(self.reply.duration_ms(pcm))

    def _close_reply(self) -> None:
        if self.reply is not None:
            self.reply.close()
            self.reply_frames += self.reply.frames
            self.conn.send_json({
                "type": "reply_end",
                "stream_id": self.stream_id,
                "reply_stream_id": self.reply.stream_id,
            })
            self.reply = None

    def _end_turn(self) -> None:
        """Tell the endpoint to stop sending: the request is over. Once."""
        if self.end_sent:
            return
        self.end_sent = True
        self.conn.send_json({"type": "end_of_turn", "stream_id": self.stream_id})
        self._end_cue()

    def _end_cue(self) -> None:
        """The speaker's turn is over: the voice host tells the endpoint to play its end cue, once a turn, so
        every endpoint beeps the same way at the same moment (a speaker missed some
        when it decided for itself). Every turn that listened to someone ends with it, a follow-up
        nobody spoke into too. A
        possible wake waits for its confirmation; a rejected one was never anybody's turn."""
        if self.cue_sent or not self.end_sent or (self.candidate and self.verdict != "confirmed"):
            return
        self.cue_sent = True
        # The music stays paused through the assistant's answer; `turn_finished` brings it back.
        self.conn.send_json({"type": "play_cue", "stream_id": self.stream_id, "cue": "end"})

    def _listen_cue(self) -> None:
        """The speaker's turn to talk, so the endpoint beeps.
        Every wake, as soon as the voice host has it: a confident one at once, a possible one when confirmed.
        A speaker's own wake chime stays off: it held the microphone back while it played and cut the first words; this
        beep holds nothing back. Once a turn (a bare wake's pause does not beep again)."""
        if self.listen_cue_sent or self.end_sent or (self.candidate and self.verdict != "confirmed"):
            return
        self.listen_cue_sent = True
        with contextlib.suppress(TurnCancelled, ConnectionError, OSError):
            self.conn.send_json({"type": "play_cue", "stream_id": self.stream_id, "cue": "listen"})

    def _watch(self) -> None:
        """The voice host's timing rules while the microphone is open, as the terminal keeps them locally."""
        policy = self.conn.server.wake_policy
        backstop_s = float(policy.get("silence_backstop_ms") or 8000) / 1000.0
        pause_s = float(policy.get("wake_pause_ms") or 4000) / 1000.0
        while not self.cancelled.wait(0.25):
            if self.end_sent:
                return
            now = time.monotonic()
            if self.input_closed.is_set():
                # The endpoint stopped sending before the voice host ended the turn (its own ceiling, or the
                # turn's size limit). STT usually ends it at once; if not, the speaker's turn is over all
                # the same, so it beeps.
                if now - self.input_closed_at >= INPUT_END_CUE_GRACE_S:
                    self.end_sent = True
                    with contextlib.suppress(TurnCancelled, ConnectionError, OSError):
                        self._end_cue()
                    return
                continue
            if self.follow_up and not self.speech_heard.is_set() and now - self.started >= self.idle_s:
                # Nobody took up the follow-up: let it go without an answer or an error, with the end beep.
                self.conn.log_event("endpoint_follow_up_silent", stream_id=self.stream_id)
                self.end_sent = True
                with contextlib.suppress(TurnCancelled, ConnectionError, OSError):
                    self._end_cue()
                self.cancel("no_speech")
                return
            if self.wake_only_at and now - max(self.wake_only_at, self.last_progress) >= pause_s:
                # "Hey Housemate" and then nothing: end the turn; the assistant acknowledges and listens on.
                self.conn.log_event("endpoint_wake_pause", stream_id=self.stream_id)
                with contextlib.suppress(TurnCancelled):
                    self._end_turn()
                return
            if self.speech_heard.is_set() and now - self.last_progress >= backstop_s:
                self.conn.log_event("endpoint_silence_backstop", stream_id=self.stream_id)
                with contextlib.suppress(TurnCancelled):
                    self._end_turn()
                return

    def run(self, handler: TurnHandler) -> None:
        error = None
        watcher = threading.Thread(target=self._watch, name=f"endpoint-watch-{self.stream_id[:8]}", daemon=True)
        watcher.start()
        try:
            if self.follow_up:
                # Asked for by the voice host (after a greeting): no wake word in this audio to confirm.
                handler(self.conn.client_id, False, self.audio_chunks(), self.write_event)
            else:
                # Every endpoint wake is checked against the transcript, but a confident one (the device's
                # own model was sure) keeps its words when the transcript misses the wake phrase: a
                # child's "Hey Housemate" comes back as "Hey, dad".
                handler(self.conn.client_id, True, self.audio_chunks(), self.write_event, wake_candidate=True,
                        **({} if self.candidate else {"wake_confident": True}))
            self._close_reply()
        except TurnCancelled as err:
            error = f"cancelled: {err}"
        except Exception as err:  # the handler's own failure, reported to the endpoint
            error = str(err) or err.__class__.__name__
        finally:
            self.cancelled.set()
            self.conn.turn_finished(self, error)

    def run_calibration_report(self) -> None:
        """The endpoint's calibration session is over: the assistant says so, then the takes come off it.

        No speech and no cues in this turn (it was nobody's turn to talk). The takes travel after the
        turn: ~3 MB over the dot's Wi-Fi takes most of a minute, too long to sit silent."""
        error = None
        try:
            self.input_closed.wait(2.0)
            say = self.conn.server.say
            if callable(say):
                say(self.conn.client_id, CALIBRATION_TEXT, self.write_event)
            self.write_event({"event": "meta", "status": "final_reply", "heard_text": "",
                              "reply_text": CALIBRATION_TEXT, "end_session": True, "listen_again": False})
            self._close_reply()
        except TurnCancelled as err:
            error = f"cancelled: {err}"
        except Exception as err:
            error = str(err) or err.__class__.__name__
        finally:
            self.cancelled.set()
            self.conn.turn_finished(self, error)
        threading.Thread(target=self.conn.fetch_calibration, name="endpoint-calibration", daemon=True).start()


def fetch_calibration_takes(host: str, calibration_dir: str, endpoint_id: str,
                            log_event: Callable[..., None]) -> int:
    """Pull a finished calibration session's takes off a speaker (TCP CALIBRATION_PORT) into
    <calibration_dir>/<endpoint id[:8]>/<UTC time>/takeNN.wav; returns how many were saved."""
    folder = os.path.join(os.path.expanduser(calibration_dir), endpoint_id[:8],
                          time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    started = time.monotonic()
    saved = 0
    try:
        with socket.create_connection((host, CALIBRATION_PORT), timeout=10) as sock:
            sock.settimeout(20)
            reader = sock.makefile("rb")
            while True:
                header = reader.read(16)
                if not header:
                    break
                if len(header) != 16 or header[:4] != b"LDCT":
                    raise ValueError("bad take header")
                take, slots, frames, rate = struct.unpack("<HHII", header[4:])
                if not 1 <= slots <= 8 or frames > rate * 10:
                    raise ValueError("implausible take")
                pcm = reader.read(frames * slots * 2)
                if len(pcm) != frames * slots * 2:
                    raise ValueError("take cut short")
                os.makedirs(folder, exist_ok=True)
                with wave.open(os.path.join(folder, f"take{take:02d}.wav"), "wb") as out:
                    out.setnchannels(slots)
                    out.setsampwidth(2)
                    out.setframerate(rate)
                    out.writeframes(pcm)
                saved += 1
        log_event("endpoint_calibration_saved", takes=saved, folder=folder,
                  seconds=round(time.monotonic() - started, 1))
    except (OSError, ValueError) as err:
        log_event("endpoint_calibration_fetch_failed", takes=saved, detail=str(err)[:200])
    return saved


class _EndpointConnection:
    def __init__(self, server: "EndpointLiveServer", ws: ServerConnection, endpoint_id: str, connection_id: str):
        self.server = server
        self.ws = ws
        self.endpoint_id = endpoint_id
        self.connection_id = connection_id
        self.client_id = f"endpoint:{endpoint_id}"
        self._send_lock = threading.Lock()
        self._turn_lock = threading.Lock()
        self.turn: _Turn | None = None
        # The assistant has just acknowledged a bare "Hey Housemate": the follow-up he asked for is the short one.
        self._after_ack = False
        self._rejections: list[float] = []
        self._candidates_paused_until = 0.0
        self._play_lock = threading.Lock()
        self._play_until = 0.0
        self._playback_id = ""
        self._play_timer: threading.Timer | None = None

    def send_json(self, message: dict[str, Any]) -> None:
        self._send(json.dumps(message, separators=(",", ":")))

    def send_binary(self, data: bytes) -> None:
        self._send(data)

    def _send(self, data: str | bytes) -> None:
        try:
            with self._send_lock:
                self.ws.send(data)
        except (ConnectionClosed, OSError) as err:
            raise TurnCancelled("endpoint disconnected") from err

    def log_event(self, name: str, **fields: Any) -> None:
        self.server.log_event(name, endpoint_id=self.endpoint_id, **fields)

    def start_turn(self, stream_id: str, wake_word: str, *, candidate: bool = False, wake_score: float | None = None,
                   follow_up: bool = False) -> None:
        with self._turn_lock:
            previous = self.turn
            if previous is not None:
                previous.cancel("superseded")
            policy = self.server.wake_policy
            # The follow-up after an acknowledged bare wake listens for less than one after an answer.
            idle_ms = policy.get("wake_ack_idle_ms" if follow_up and self._after_ack else "follow_up_idle_ms")
            self._after_ack = False
            turn = _Turn(self, stream_id, wake_word, candidate, follow_up, float(idle_ms or 12000))
            self.turn = turn
        self.log_event("endpoint_turn_started", stream_id=stream_id, wake_word=wake_word,
                       candidate=candidate or None, wake_score=wake_score, follow_up=follow_up or None)
        if wake_word == CALIBRATION_DONE_WORD and not candidate and not follow_up:
            turn.end_sent = turn.cue_sent = turn.listen_cue_sent = True
            turn.thread = threading.Thread(target=turn.run_calibration_report,
                                           name=f"endpoint-calibration-{stream_id[:8]}", daemon=True)
            turn.thread.start()
            return
        if not candidate:
            # A possible wake waits for its confirmation (`_Turn._decide`): a rejected one leaves the music alone.
            self.music_listening()
            if not follow_up:
                # The endpoint beeps a follow-up itself; a wake is beeped from here, straight away.
                with contextlib.suppress(TurnCancelled, ConnectionError, OSError):
                    turn._listen_cue()
        turn.thread = threading.Thread(
            target=turn.run, args=(self.server.turn_handler,), name=f"endpoint-turn-{stream_id[:8]}", daemon=True
        )
        turn.thread.start()

    # The endpoint plays reply audio in real time as it arrives, so the voice host knows when it is really
    # speaking: from its first audio until everything sent has been played. Reported the way the
    # terminal reports its own playback, so HA's "endpoint speaking" covers the whole reply.
    def reply_audio(self, ms: float) -> None:
        now = time.monotonic()
        with self._play_lock:
            started = not self._playback_id
            if started:
                self._playback_id = uuid.uuid4().hex
            self._play_until = max(self._play_until, now) + ms / 1000.0
            playback_id = self._playback_id
            if self._play_timer is None:
                self._arm_play_timer_locked(now)
        if started:
            self.server.report_playback(self.client_id, "started", playback_id)

    def _arm_play_timer_locked(self, now: float) -> None:
        self._play_timer = threading.Timer(max(0.05, self._play_until + PLAYBACK_TAIL_S - now), self._play_check)
        self._play_timer.daemon = True
        self._play_timer.start()

    def _play_check(self, force: bool = False) -> None:
        now = time.monotonic()
        with self._play_lock:
            self._play_timer = None
            if not self._playback_id:
                return
            if not force and now < self._play_until + PLAYBACK_TAIL_S:
                self._arm_play_timer_locked(now)
                return
            playback_id, self._playback_id = self._playback_id, ""
        self.server.report_playback(self.client_id, "finished", playback_id)

    def send_policy(self) -> None:
        policy = dict(self.server.wake_policy)
        if time.monotonic() < self._candidates_paused_until:
            policy["candidate_enabled"] = False
        self.send_json({"type": "wake_policy", **policy})

    def candidate_rejected(self) -> None:
        now = time.monotonic()
        self._rejections = [t for t in self._rejections if now - t < CANDIDATE_REJECTION_WINDOW_S] + [now]
        if len(self._rejections) < CANDIDATE_MAX_REJECTIONS or now < self._candidates_paused_until:
            return
        self._candidates_paused_until = now + CANDIDATE_PAUSE_S
        self._rejections = []
        self.log_event("endpoint_candidates_paused", seconds=int(CANDIDATE_PAUSE_S))
        self.send_policy()
        timer = threading.Timer(CANDIDATE_PAUSE_S + 0.5, self._resume_candidates)
        timer.daemon = True
        timer.start()

    def _resume_candidates(self) -> None:
        with contextlib.suppress(TurnCancelled):
            self.send_policy()

    def music_listening(self) -> None:
        mute = self.server.music_mute
        if mute is not None:
            with contextlib.suppress(Exception):
                mute.listening(self.endpoint_id)

    def music_after_turn(self, turn: _Turn, error: str | None) -> None:
        """The music paused for this conversation: left as a command left it, kept through a follow-up
        that is coming, or played again once the assistant's answer has been heard."""
        mute = self.server.music_mute
        if mute is None:
            return
        if turn.music_hold and not error:
            with contextlib.suppress(Exception):
                mute.forget(self.endpoint_id, "command")
            return
        if turn.continues and not error:
            return
        with self._play_lock:
            wait = max(0.0, self._play_until + PLAYBACK_TAIL_S - time.monotonic())

        def again() -> None:
            # A turn opened meanwhile (a follow-up, a new wake) keeps the music paused.
            if self.turn is None:
                self.music_released()

        if wait <= 0:
            again()
            return
        timer = threading.Timer(wait, again)
        timer.daemon = True
        timer.start()

    def music_released(self, then: Callable[[], None] | None = None) -> None:
        mute = self.server.music_mute
        if mute is None:
            if then is not None:
                then()
            return

        def guarded() -> None:
            if then is not None:
                with contextlib.suppress(TurnCancelled, ConnectionError, OSError):
                    then()

        try:
            mute.release(self.endpoint_id, guarded)
        except Exception:
            guarded()

    def turn_finished(self, turn: _Turn, error: str | None) -> None:
        with self._turn_lock:
            if self.turn is turn:
                self.turn = None
        self.music_after_turn(turn, error)
        self.log_event(
            "endpoint_turn_finished",
            stream_id=turn.stream_id,
            error=error,
            input_ms=int(turn.input_bytes * 1000 / 32_000),
            reply_frames=turn.reply_frames,
            elapsed_ms=int((time.monotonic() - turn.started) * 1000),
        )
        if error and turn.cancel_reason == "no_speech":
            # The conversation is over on the endpoint; end it on the voice host too, or the assistant stays
            # "listening" until the session times out (and the endpoint's possible-wake checks keep
            # refreshing it).
            self.server.end_session(self.client_id, "follow_up_silent")
        with contextlib.suppress(TurnCancelled):
            if error and turn.cancel_reason == "no_speech":
                # A follow-up nobody spoke into ends quietly, as the terminal's session does.
                self.send_json({"type": "turn_done", "stream_id": turn.stream_id})
            elif error:
                self.send_json({"type": "turn_error", "stream_id": turn.stream_id, "detail": error[:200]})
            else:
                self.send_json({"type": "turn_done", "stream_id": turn.stream_id})
                if turn.endpoint_command is not None:
                    # The endpoint starts it once the answer has played.
                    self.send_json(turn.endpoint_command)
                    self.log_event("endpoint_command_sent", command=turn.endpoint_command.get("type"))

    def fetch_calibration(self) -> None:
        """Pull the finished session's takes off the endpoint into the calibration folder."""
        peer = str((self.ws.remote_address or ("", 0))[0])
        fetch_calibration_takes(peer, self.server.calibration_dir, self.endpoint_id, self.log_event)

    def on_text(self, raw: str) -> None:
        message = decode_control_frame(raw)
        kind = message["type"]
        if message.get("endpoint_id") != self.endpoint_id or message.get("connection_id") != self.connection_id:
            raise ProtocolError("message is not for this authenticated connection")
        if kind == "heartbeat":
            self.send_json(self.server.control.handle_heartbeat(raw))
        elif kind == "turn_start":
            start = parse_turn_start(message)
            if start.candidate and time.monotonic() < self._candidates_paused_until:
                self.send_json({"type": "wake_rejected", "stream_id": start.stream_id})
                self.send_json({"type": "turn_done", "stream_id": start.stream_id})
                return
            self.start_turn(start.stream_id, start.wake_word, candidate=start.candidate, wake_score=start.wake_score,
                            follow_up=start.follow_up)
        elif kind == "turn_cancel":
            cancel = parse_turn_cancel(message)
            with self._turn_lock:
                turn = self.turn
            if turn is not None and turn.stream_id == cancel.stream_id:
                turn.cancel(cancel.reason)
        else:
            raise ProtocolError(f"{kind} is not valid after authentication")

    def on_binary(self, data: bytes) -> None:
        frame = AudioFrame.decode(data)
        if frame.kind != KIND_MICROPHONE:
            raise AudioProtocolError("endpoints send microphone frames only")
        with self._turn_lock:
            turn = self.turn
        if turn is None or turn.cancelled.is_set():
            return  # the tail of a turn that has already ended
        try:
            turn.accept_frame(frame)
        except AudioProtocolError:
            turn.cancel("bad_audio")
            raise

    def close(self, reason: str) -> None:
        with self._turn_lock:
            turn = self.turn
        if turn is not None:
            turn.cancel(reason)
        self._play_check(force=True)
        self.server.control.disconnect(self.endpoint_id, self.connection_id, reason=reason)


class EndpointLiveServer:
    """The WebSocket listener. One thread per endpoint connection, one per active turn."""

    def __init__(
        self,
        control: GatewayControlPlane,
        turn_handler: TurnHandler,
        *,
        host: str,
        port: int,
        log: Callable[[str], None] = print,
        event_logger: Callable[..., None] | None = None,
        wake_policy: dict[str, Any] | None = None,
        playback: Callable[[str, str, str], None] | None = None,
        session_end: Callable[[str, str], None] | None = None,
        music_mute: Any = None,
        say: Callable[[str, str, Callable[[dict[str, Any]], None]], None] | None = None,
        calibration_dir: str = "~/.local/share/housemate-voice/calibration",
    ):
        self.control = control
        # Speaks a fixed line into a turn: (client_id, text, write_event).
        self.say = say
        self.calibration_dir = os.path.expanduser(calibration_dir)
        # The endpoint's music is muted while it listens (`music_mute.MusicMute`), or None.
        self.music_mute = music_mute
        self.wake_policy = {**DEFAULT_WAKE_POLICY, **(wake_policy or {})}
        self.turn_handler = turn_handler
        self._playback = playback
        self._session_end = session_end
        self.host = host
        self.port = int(port)
        self._log = log
        self._event_logger = event_logger
        self._server = None
        self._thread: threading.Thread | None = None

    def log_event(self, name: str, **fields: Any) -> None:
        if callable(self._event_logger):
            with contextlib.suppress(Exception):
                self._event_logger(name, **fields)

    def report_playback(self, client_id: str, event: str, playback_id: str) -> None:
        """An endpoint started or finished playing a reply: `event` is "started" or "finished"."""
        if callable(self._playback):
            with contextlib.suppress(Exception):
                self._playback(client_id, event, playback_id)

    def supports(self, client_id: str, capability: str) -> bool:
        """Whether the endpoint behind a client id declared `capability` in its hello."""
        endpoint_id = client_id[len("endpoint:"):] if client_id.startswith("endpoint:") else client_id
        try:
            return capability in self.control.registry.require(endpoint_id).capabilities
        except Exception:
            return False

    def end_session(self, client_id: str, reason: str) -> None:
        if callable(self._session_end):
            with contextlib.suppress(Exception):
                self._session_end(client_id, reason)

    def start(self) -> None:
        self._server = serve(
            self._handle,
            self.host,
            self.port,
            max_size=MAX_MESSAGE_BYTES,
            compression=None,
        )
        self.port = self._server.socket.getsockname()[1]
        self._thread = threading.Thread(target=self._server.serve_forever, name="endpoint-gateway", daemon=True)
        self._thread.start()
        self._log(f"endpoint gateway listening on {self.host}:{self.port}")

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server = None

    def _refuse(self, ws: ServerConnection, detail: str) -> None:
        with contextlib.suppress(ConnectionClosed, OSError):
            ws.send(json.dumps({"type": "refused", "detail": detail[:200]}))
            ws.close(code=1008, reason="refused")

    def _handle(self, ws: ServerConnection) -> None:
        peer_ip = str((ws.remote_address or ("", 0))[0])
        try:
            hello = ws.recv(timeout=HELLO_TIMEOUT_S)
            if not isinstance(hello, str):
                return self._refuse(ws, "expected endpoint_hello")
            reply = self.control.handle_hello(hello, peer_ip=peer_ip)
            ws.send(json.dumps(reply))
            if reply.get("type") != "authentication_required":
                self.log_event("endpoint_pending", endpoint_id=reply.get("endpoint_id"), peer_ip=peer_ip)
                ws.close(code=1000, reason="enrollment pending")
                return
            endpoint_id = reply["endpoint_id"]
            challenge = self.control.begin_authentication(endpoint_id, str(uuid.uuid4()))
            ws.send(json.dumps({
                "type": "auth_challenge",
                "endpoint_id": endpoint_id,
                "connection_id": challenge.connection_id,
                "challenge_id": challenge.challenge_id,
                "credential_version": challenge.credential_version,
                "nonce": challenge.nonce,
                "expires_in_ms": challenge.expires_in_ms,
            }))
            auth = ws.recv(timeout=AUTH_TIMEOUT_S)
            if not isinstance(auth, str):
                return self._refuse(ws, "expected authenticate")
            lease = self.control.authenticate(auth)
        except (ProtocolError, RegistryError, AuthenticationError, TimeoutError) as err:
            self.log_event("endpoint_refused", peer_ip=peer_ip, detail=str(err)[:200])
            return self._refuse(ws, str(err) or "refused")
        except ConnectionClosed:
            return

        conn = _EndpointConnection(self, ws, lease.endpoint_id, lease.connection_id)
        conn.send_json({
            "type": "authenticated",
            "endpoint_id": lease.endpoint_id,
            "connection_id": lease.connection_id,
            "generation": lease.generation,
        })
        conn.send_policy()
        self.log_event("endpoint_connected", endpoint_id=lease.endpoint_id, peer_ip=peer_ip, generation=lease.generation)
        reason = "client_closed"
        try:
            for message in ws:
                if isinstance(message, str):
                    conn.on_text(message)
                else:
                    conn.on_binary(message)
        except (ProtocolError, AudioProtocolError, RegistryError) as err:
            reason = "protocol_error"
            self.log_event("endpoint_protocol_error", endpoint_id=lease.endpoint_id, detail=str(err)[:200])
            self._refuse(ws, str(err))
        except ConnectionClosed:
            pass
        finally:
            conn.close(reason)
            self.log_event("endpoint_disconnected", endpoint_id=lease.endpoint_id, reason=reason)
