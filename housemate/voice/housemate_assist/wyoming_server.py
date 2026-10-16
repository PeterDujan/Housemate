"""The Voice Loop's Deepgram hearing and Fish voice as one Wyoming server for HA Assist.

HA's Wyoming integration connects once per request. An STT request streams 16 kHz mic audio in and
reads one transcript back; Flux decides the end of turn, so HA needs no VAD of its own. A TTS request
streams reply text in (``synthesize-start``/``-chunk``/``-stop``) and reads PCM back while the text is
still arriving: one Fish WebSocket per reply, through the Voice Loop's own ``ProgressiveTtsSession``.

Nothing here decides who spoke, what the assistant says or which room it was; that is the turn API's job. The
engines are the Voice Loop's own, passed in, so the gateway and this server share one Deepgram warm
socket and one Fish worker.
"""

from __future__ import annotations

import contextlib
import re
import socket
import socketserver
import threading
import time
from typing import Any, Callable

from wyoming.asr import Transcribe, Transcript
from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.error import Error
from wyoming.event import Event, read_event, write_event
from wyoming.info import AsrModel, AsrProgram, Attribution, Describe, Info, TtsProgram, TtsVoice
from wyoming.tts import Synthesize, SynthesizeChunk, SynthesizeStart, SynthesizeStop, SynthesizeStopped

STT_SAMPLE_RATE = 16000
STT_SAMPLE_WIDTH = 2
STT_CHANNELS = 1
# Who is speaking is checked on 1.0-3.5 s of the stream, as the gateway checks an endpoint's: the end
# of the dot's 2 s pre-roll, which holds "Hey Housemate", and the start of the request.
SPEAKER_CHECK_FROM = STT_SAMPLE_RATE * STT_SAMPLE_WIDTH
SPEAKER_CHECK_BYTES = int(STT_SAMPLE_RATE * STT_SAMPLE_WIDTH * 3.5)
# "Hey Housemate" and nothing yet: Flux's end of turn waits, and after this long without new words the
# wake phrase alone goes to HA, which the turn answers "Mm-hm?" (the gateway's wake_pause_ms).
WAKE_PAUSE_SECONDS = 4.0
LANGUAGES = ["en"]
ATTRIBUTION = Attribution(name="Housemate Voice", url="")
# Reply text arrives in model-sized deltas; Fish gets whole sentences, or a long run cut at a space.
SENTENCE_END_RE = re.compile(r"[.!?…][\"')\]]*\s+")
LONG_RUN_CHARS = 200
TTS_FINISH_TIMEOUT_SECONDS = 120.0


def split_ready_text(buffer: str) -> tuple[str, str]:
    """Return (text ready for Fish, text still waiting for its sentence to end)."""
    last = None
    for last in SENTENCE_END_RE.finditer(buffer):
        pass
    if last is not None:
        return " ".join(buffer[: last.end()].split()), buffer[last.end():]
    if len(buffer) > LONG_RUN_CHARS:
        cut = buffer.rfind(" ")
        if cut > 0:
            return " ".join(buffer[:cut].split()), buffer[cut:]
    return "", buffer


class _EventWriter:
    """Serialised writes: the STT end of turn and the Fish player write from their own threads."""

    def __init__(self, sock: socket.socket):
        self._file = sock.makefile("wb")
        self._lock = threading.Lock()

    def send(self, event: Event) -> None:
        with self._lock:
            write_event(event, self._file)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._file.close()


class SttTurn:
    """One HA STT request: mic audio into a live Flux session, one transcript out.

    The audio and a speaker check started on its opening words go to ``on_heard`` with the
    transcript, for the turn API (``housemate_assist.turns``). A transcript that is only the wake phrase
    (``wake_only``) does not end the turn until ``WAKE_PAUSE_SECONDS`` pass without new words."""

    def __init__(self, stt, out: _EventWriter, *, no_speech_seconds: float, max_turn_seconds: float,
                 log: Callable[[str], None], event: Callable[..., None],
                 on_heard: Callable[[str, bytes, Any], None] | None = None,
                 identify: Callable[[bytes], Any] | None = None,
                 wake_only: Callable[[str], bool] | None = None,
                 eot_threshold: float | None = None):
        self._out = out
        self._on_heard = on_heard
        self._identify = identify
        self._wake_only = wake_only
        self._wake_only_at: float | None = None
        self._progress_at: float | None = None
        self._last_interim = ""
        self._speaker_future = None
        self._speaker_checked = False
        self._audio = bytearray()
        self._log = log
        self._event = event
        self._no_speech_seconds = max(1.0, float(no_speech_seconds))
        self._max_turn_seconds = max(self._no_speech_seconds, float(max_turn_seconds))
        self._lock = threading.Lock()
        self._sent = threading.Event()
        # Deepgram rejects audio after CloseStream, and HA streams until it has the transcript.
        self._finishing = threading.Event()
        self._heard_at: float | None = None
        self._audio_bytes = 0
        self._started_at = time.monotonic()
        self._session = stt.start_live_session(
            end_of_turn_callback=self._end_of_turn,
            interim_callback=self._interim,
            **({"eot_threshold": eot_threshold} if eot_threshold is not None else {}),
        )
        if self._session is None:
            raise RuntimeError("live STT is unavailable")
        threading.Thread(target=self._watch, name="assist-stt-watch", daemon=True).start()

    def feed(self, audio: bytes) -> None:
        with self._lock:
            if self._sent.is_set() or self._finishing.is_set():
                return
            self._audio_bytes += len(audio)
            if self._on_heard is not None:
                self._audio.extend(audio)
                if not self._speaker_checked and len(self._audio) >= SPEAKER_CHECK_BYTES:
                    self._check_speaker()
        self._session.feed_audio(audio)

    def finish(self, reason: str) -> None:
        if self._sent.is_set():
            return
        with self._lock:
            self._finishing.set()
        try:
            text = self._session.finish()
        except Exception as err:
            self._log(f"assist stt finish failed reason={reason}: {err}")
            text = ""
        # The words heard so far stand in when Flux has nothing more (a bare "Hey Housemate" pause).
        self._send(text or self._last_interim, reason)

    def close(self) -> None:
        self._sent.set()
        with contextlib.suppress(Exception):
            self._session.close()

    def _interim(self, text: str) -> None:
        now = time.monotonic()
        if self._heard_at is None:
            self._heard_at = now
        text = " ".join(str(text or "").split())
        if text != self._last_interim:
            self._last_interim = text
            self._progress_at = now

    def _end_of_turn(self, transcript: str) -> bool:
        if self._wake_only is not None and self._wake_only(transcript):
            # "Hey Housemate" then a pause: the request may still come.
            if self._wake_only_at is None:
                self._wake_only_at = time.monotonic()
            return False
        return self._send(transcript, "end_of_turn")

    def _watch(self) -> None:
        while not self._sent.wait(0.1):
            now = time.monotonic()
            elapsed = now - self._started_at
            if self._heard_at is None and elapsed >= self._no_speech_seconds:
                self.finish("no_speech")
            elif self._wake_only_at is not None and now - max(self._wake_only_at, self._progress_at or 0.0) >= WAKE_PAUSE_SECONDS:
                self.finish("wake_pause")
            elif elapsed >= self._max_turn_seconds:
                self.finish("max_turn")

    def _check_speaker(self) -> None:
        self._speaker_checked = True
        if self._identify is not None and len(self._audio) > SPEAKER_CHECK_FROM:
            try:
                self._speaker_future = self._identify(bytes(self._audio[SPEAKER_CHECK_FROM:SPEAKER_CHECK_BYTES]))
            except Exception as err:
                self._log(f"assist stt speaker check failed to start: {err}")

    def _send(self, text: str, reason: str) -> bool:
        text = " ".join(str(text or "").split())
        with self._lock:
            if self._sent.is_set():
                return False
            self._sent.set()
            if text and self._on_heard is not None:
                if not self._speaker_checked and self._audio:
                    self._check_speaker()  # A short turn: check what there is.
                self._on_heard(text, bytes(self._audio), self._speaker_future)
        # Deepgram bills streamed audio; HA keeps sending until it has read the transcript.
        with contextlib.suppress(Exception):
            self._session.close()
        try:
            self._out.send(Transcript(text=text).event())
        except OSError as err:
            self._log(f"assist stt transcript not delivered reason={reason}: {err}")
            return False
        now = time.monotonic()
        audio_ms = int(self._audio_bytes * 1000 / (STT_SAMPLE_RATE * STT_SAMPLE_WIDTH * STT_CHANNELS))
        turn_ms = int(round((now - self._started_at) * 1000))
        speech_ms = int(round((self._heard_at - self._started_at) * 1000)) if self._heard_at else None
        self._log(f"assist stt {reason} turn_ms={turn_ms} audio_ms={audio_ms} first_words_ms={speech_ms} text={text}")
        self._event("assist_stt_turn", reason=reason, turn_ms=turn_ms, audio_ms=audio_ms,
                    first_words_ms=speech_ms, transcript=text)
        return True


class TtsReply:
    """One HA TTS request: reply text in, Fish PCM out on one progressive session.

    When the first words are the voice turn's own (``claim_turn``), that turn already made the audio:
    it is streamed as it comes and HA's text is not spoken again."""

    def __init__(self, open_session: Callable[..., Any] | None, out: _EventWriter, *,
                 log: Callable[[str], None], event: Callable[..., None],
                 claim_turn: Callable[[str], Any] | None = None):
        self._open_session = open_session
        self._claim_turn = claim_turn
        self._turn = None
        self._turn_thread: threading.Thread | None = None
        self._out = out
        self._log = log
        self._event = event
        self._pending = ""
        self._session = None
        self._text: list[str] = []
        self._audio_started = False
        self._first_audio_ms: int | None = None
        self._audio_bytes = 0
        self._format = (STT_SAMPLE_RATE, 2, 1)
        self._started_at = time.monotonic()

    def add(self, text: str) -> None:
        if self._turn is not None:
            return  # The turn's own words: its audio is already on the way.
        if self._claim_turn is not None and not self._pending and self._session is None and not self._text:
            self._turn = self._claim_turn(text)
            if self._turn is not None:
                self._text.append(" ".join(str(text).split()))
                self._turn_thread = threading.Thread(target=self._play_turn, name="assist-tts-turn", daemon=True)
                self._turn_thread.start()
                return
        if self._open_session is None:
            raise RuntimeError("Fish voice is not available")
        self._pending += str(text or "")
        ready, self._pending = split_ready_text(self._pending)
        if ready:
            self._speak(ready)

    def finish(self) -> None:
        if self._turn_thread is not None:
            self._turn_thread.join(TTS_FINISH_TIMEOUT_SECONDS)
        tail = " ".join(self._pending.split())
        self._pending = ""
        if tail:
            self._speak(tail)
        if self._session is not None:
            self._session.finish(timeout_seconds=TTS_FINISH_TIMEOUT_SECONDS)
            self._session = None
        if not self._audio_started:
            # HA builds its WAV header from audio-start; an empty reply still needs one.
            self._out.send(AudioStart(rate=STT_SAMPLE_RATE, width=2, channels=1).event())
        self._out.send(AudioStop().event())
        total_ms = int(round((time.monotonic() - self._started_at) * 1000))
        spoken = " ".join(self._text)
        self._log(f"assist tts done first_audio_ms={self._first_audio_ms} total_ms={total_ms} "
                  f"bytes={self._audio_bytes} chars={len(spoken)}")
        self._event("assist_tts_reply", first_audio_ms=self._first_audio_ms, total_ms=total_ms,
                    audio_bytes=self._audio_bytes, utterance=spoken)

    def abort(self) -> None:
        session, self._session = self._session, None
        if session is not None:
            with contextlib.suppress(Exception):
                session.abort()

    def _speak(self, text: str) -> None:
        # Opened with the first words, not at synthesize-start: an unused session's abort restarts the Fish worker.
        if self._session is None:
            self._session = self._open_session(
                turn_complete_at=self._started_at,
                output_start_callback=self._audio_start,
                output_chunk_callback=self._audio_chunk,
            )
        self._session.append(text)
        self._text.append(text)

    def _audio_start(self, info: dict) -> None:
        if self._audio_started:
            return
        self._audio_started = True
        self._first_audio_ms = int(round((time.monotonic() - self._started_at) * 1000))
        self._format = (int(info.get("sample_rate") or STT_SAMPLE_RATE), int(info.get("sample_width") or 2),
                        int(info.get("channels") or 1))
        rate, width, channels = self._format
        self._out.send(AudioStart(rate=rate, width=width, channels=channels).event())

    def _play_turn(self) -> None:
        try:
            for chunk in self._turn.audio():
                if not self._audio_started:
                    self._audio_start({"sample_rate": self._turn.rate, "sample_width": 2, "channels": 1})
                self._audio_chunk(chunk)
        except OSError as err:
            self._log(f"assist tts turn audio not delivered: {err}")

    def _audio_chunk(self, chunk: bytes) -> None:
        self._audio_bytes += len(chunk)
        rate, width, channels = self._format
        self._out.send(AudioChunk(rate=rate, width=width, channels=channels, audio=chunk).event())


class AssistWyomingServer:
    """Threaded TCP Wyoming server: ``asr`` from the STT engine, ``tts`` from Fish when it is ready."""

    def __init__(self, *, stt, open_tts_session: Callable[..., Any] | None, host: str, port: int,
                 no_speech_seconds: float, max_turn_seconds: float, version: str = "",
                 log: Callable[[str], None] = print, event: Callable[..., None] | None = None,
                 on_heard: Callable[[str, bytes, Any], None] | None = None,
                 identify: Callable[[bytes], Any] | None = None,
                 claim_turn: Callable[[str], Any] | None = None,
                 wake_only: Callable[[str], bool] | None = None,
                 eot_threshold: Callable[[], float | None] | None = None,
                 assistant_name: str = "Housemate"):
        self.stt = stt
        # HA names the services after the assistant ("Housemate Hearing" makes stt.housemate_hearing).
        self.assistant_name = str(assistant_name or "Housemate")
        self.open_tts_session = open_tts_session
        self.on_heard = on_heard
        self.identify = identify
        self.claim_turn = claim_turn
        self.wake_only = wake_only
        # The speaker's own Flux end of turn when the turn answers a follow-up.
        self.eot_threshold = eot_threshold or (lambda: None)
        self.host = host
        self.port = int(port)
        self.no_speech_seconds = float(no_speech_seconds)
        self.max_turn_seconds = float(max_turn_seconds)
        self.version = version
        self.log = log
        self.event = event or (lambda *_args, **_kwargs: None)
        self._server: socketserver.ThreadingTCPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def address(self) -> tuple[str, int]:
        return self._server.server_address[:2] if self._server else (self.host, self.port)

    def info(self) -> Info:
        asr = [AsrProgram(
            name=f"{self.assistant_name} Hearing",
            description=f"{self.assistant_name} hearing",
            attribution=ATTRIBUTION,
            installed=True,
            version=self.version or None,
            models=[AsrModel(name="deepgram-flux", description="Deepgram Flux", attribution=ATTRIBUTION,
                             installed=True, version=None, languages=LANGUAGES)],
            # Flux ends the turn itself; without it HA's own VAD has to.
            requires_external_vad=not bool(getattr(self.stt, "live_end_of_turn", False)),
            prefers_auto_gain_enabled=False,
            prefers_noise_reduction_enabled=False,
        )]
        tts = []
        if self.open_tts_session is not None:
            tts = [TtsProgram(
                name=f"{self.assistant_name} Voice",
                description=f"{self.assistant_name} voice",
                attribution=ATTRIBUTION,
                installed=True,
                version=self.version or None,
                voices=[TtsVoice(name=self.assistant_name.lower(), description=self.assistant_name, attribution=ATTRIBUTION,
                                 installed=True, version=None, languages=LANGUAGES)],
                supports_synthesize_streaming=True,
            )]
        return Info(asr=asr, tts=tts)

    def start(self) -> None:
        server_ref = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                server_ref._handle(self.request)

        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self._server = socketserver.ThreadingTCPServer((self.host, self.port), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, name="assist-wyoming", daemon=True)
        self._thread.start()
        host, port = self.address
        self.log(f"assist wyoming server listening on {host}:{port}")

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def _handle(self, sock: socket.socket) -> None:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        reader = sock.makefile("rb")
        out = _EventWriter(sock)
        stt_turn: SttTurn | None = None
        reply: TtsReply | None = None
        try:
            while (event := read_event(reader)) is not None:
                if Describe.is_type(event.type):
                    out.send(self.info().event())
                elif Transcribe.is_type(event.type):
                    pass  # Language only; Deepgram's comes from the Voice Loop config.
                elif AudioStart.is_type(event.type):
                    start = AudioStart.from_event(event)
                    if (start.rate, start.width, start.channels) != (STT_SAMPLE_RATE, STT_SAMPLE_WIDTH, STT_CHANNELS):
                        out.send(Error(text=f"need 16 kHz 16-bit mono, got {start.rate}/{start.width}/{start.channels}",
                                       code="audio-format").event())
                        return
                    stt_turn = SttTurn(self.stt, out, no_speech_seconds=self.no_speech_seconds,
                                       max_turn_seconds=self.max_turn_seconds, log=self.log, event=self.event,
                                       on_heard=self.on_heard, identify=self.identify,
                                       wake_only=self.wake_only, eot_threshold=self.eot_threshold())
                elif AudioChunk.is_type(event.type):
                    if stt_turn is not None:
                        stt_turn.feed(AudioChunk.from_event(event).audio)
                elif AudioStop.is_type(event.type):
                    if stt_turn is not None:
                        stt_turn.finish("audio_stop")
                elif SynthesizeStart.is_type(event.type):
                    reply = self._new_reply(out)
                elif SynthesizeChunk.is_type(event.type):
                    if reply is not None:
                        reply.add(SynthesizeChunk.from_event(event).text)
                elif Synthesize.is_type(event.type):
                    if reply is None:  # Inside a stream this is the whole text again, for old servers.
                        single = self._new_reply(out)
                        single.add(Synthesize.from_event(event).text)
                        single.finish()
                elif SynthesizeStop.is_type(event.type):
                    if reply is not None:
                        current, reply = reply, None
                        current.finish()
                        out.send(SynthesizeStopped().event())
        except (OSError, ValueError) as err:
            self.log(f"assist wyoming connection ended: {err}")
        except Exception as err:
            self.log(f"assist wyoming request failed: {err}")
            with contextlib.suppress(Exception):
                out.send(Error(text=str(err), code="housemate").event())
        finally:
            if stt_turn is not None:
                stt_turn.close()
            if reply is not None:
                reply.abort()
            out.close()
            with contextlib.suppress(Exception):
                reader.close()

    def _new_reply(self, out: _EventWriter) -> TtsReply:
        return TtsReply(self.open_tts_session, out, log=self.log, event=self.event, claim_turn=self.claim_turn)
