"""The assistant's brain behind HA Assist, through the Voice Loop's own turn.

HA's Assist pipeline calls three voice host services in order: Wyoming STT, then the ``housemate_assist``
conversation agent (which calls this turn API), then Wyoming TTS. Only the Voice Loop knows voices,
sessions and the assistant, so a turn here is the same ``_handle_browser_voice_turn`` every endpoint runs:

1. The STT server ends a turn and hands HA the transcript. It keeps the audio, and the speaker check
   it started while the words were still arriving (``HeardTurns``).
2. The agent posts the transcript here. The held audio is matched by its text (newest first,
   ``HEARD_KEEP_SECONDS``) and the Voice Loop runs the turn: speaker ID, session, goodbye, ears test,
   the assistant, Fish. Its reply audio is collected at 24 kHz (``AssistReply``). The agent is told the first
   words as soon as they have audio, and the result (the whole reply text, whether to listen again)
   at the end.
3. HA's TTS request starts with those first words; the TTS server claims the turn by them
   (``AssistReplies``) and streams the turn's own audio instead of synthesising the text again.

A transcript with no held audio (text typed into HA) is not a voice turn and gets no voice turn.

Music: the agent also reports each satellite's state (``POST /assist/music``). Listening
pauses that dot's Music Assistant player through the gateway's own ``MusicMute`` (same rules, hold
and failsafes as an endpoint); idle plays it again after ``MUSIC_IDLE_GRACE_SECONDS``, which a
follow-up's listening cancels (HA shows the satellite idle between a reply and its follow-up). A
turn whose command left the music as it wants it (``music_hold``) drops the hold instead.

Calibration: "play calibration" ends with ``endpoint_command`` (calibrate, takes, timeout)
in ``done``; the agent starts it on the dot once the reply has played. When the dot's session is over
the agent posts ``/assist/calibration`` (device, the dot's address, takes); the takes come off the
dot here and the answer is the line the agent announces on the satellite.

Voice training: ``/assist/training/start`` arms a session for one satellite (the brain then
announces the line it returns on it); that satellite's turns are takes for ``VoiceTraining`` until it
is done, never turns for the brain. Each prompt ends without listening; when the satellite goes idle
after it, the music hook answers ``{"beep_then_listen": true}`` and the agent starts a conversation
with the beep file, so the satellite beeps and listens whatever TTS it speaks with.
``/assist/training/status`` and ``/assist/training/cancel`` serve the page.

A speaker tells HA what started each run (``esphome.localdot_turn_start``: its wake word, or the
button); the agent passes it on as ``start``/``wake_word``. A "Hey Housemate" turn carries the
wake in its pre-roll, so it is confirmed from the words and the phrase stripped, as an endpoint's
confident wake is. Anything else (the button, another wake word, a follow-up) is taken as said.
"""

from __future__ import annotations

import base64
import collections
import contextlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from housemate_endpoint_gateway.live import _CONTINUES, REPLY_RATE, LinearResampler, _clip_pcm

CLIENT_PREFIX = "endpoint:assist-"
HEARD_KEEP_SECONDS = 30.0
REPLY_KEEP_SECONDS = 60.0
TURN_TIMEOUT_SECONDS = 180.0
# After a reply that listens again, a turn within its audio plus this long is the follow-up.
FOLLOW_UP_GRACE_SECONDS = 20.0
NO_AUDIO_LINE = "I only take that by voice."
MUSIC_IDLE_GRACE_SECONDS = 2.0
MUSIC_STATES = frozenset({"listening", "idle"})


def _norm(text: str) -> str:
    return " ".join(str(text or "").split()).casefold()


class HeardTranscript:
    """A finished live-STT session, for the turn: the transcript HA already has."""

    def __init__(self, text: str):
        self._text = text

    def finish(self) -> str:
        return self._text

    def close(self) -> None:
        pass


class HeardTurns:
    """Transcripts the STT server gave HA, with their audio and speaker check, until the agent asks."""

    def __init__(self, keep_seconds: float = HEARD_KEEP_SECONDS):
        self._keep = float(keep_seconds)
        self._lock = threading.Lock()
        self._items: collections.deque = collections.deque()

    def add(self, text: str, audio: bytes, speaker_future=None) -> None:
        with self._lock:
            self._prune()
            self._items.append((time.monotonic(), _norm(text), bytes(audio), speaker_future))

    def claim(self, text: str) -> tuple[bytes, Any] | None:
        key = _norm(text)
        with self._lock:
            self._prune()
            for item in reversed(self._items):
                if item[1] == key:
                    self._items.remove(item)
                    return item[2], item[3]
        return None

    def _prune(self) -> None:
        cutoff = time.monotonic() - self._keep
        while self._items and self._items[0][0] < cutoff:
            self._items.popleft()


class AssistReply:
    """One turn's Voice Loop events: its first words and result for the agent, 24 kHz PCM for TTS."""

    rate = REPLY_RATE

    def __init__(self, log: Callable[[str], None] = print):
        self._log = log
        self._cond = threading.Condition()
        self._chunks: collections.deque = collections.deque()
        self._resampler: LinearResampler | None = None
        self.created_at = time.monotonic()
        self.first_text = ""
        self.result: dict | None = None
        self.error = ""
        self.done = False
        self.audio_bytes = 0

    # The Voice Loop's stream_writer.
    def write(self, payload: dict) -> None:
        event = str(payload.get("event") or "")
        if event == "audio_open":
            self._open(int(payload.get("sample_rate") or REPLY_RATE), str(payload.get("text") or ""))
        elif event == "audio_chunk" and self._resampler is not None:
            self._add(self._resampler.feed(base64.b64decode(str(payload.get("audio_base64") or ""))))
        elif event == "audio_close":
            self._resampler = None
        elif event == "audio_clip":
            clip = payload.get("clip") if isinstance(payload.get("clip"), dict) else {}
            try:
                pcm, rate, channels = _clip_pcm(clip)
            except Exception as err:
                self._log(f"assist reply clip skipped: {err}")
                return
            if channels != 1:
                self._log(f"assist reply clip skipped: {channels} channels")
                return
            self._open(rate, str(clip.get("text") or ""))
            self._add(self._resampler.feed(pcm))
            self._resampler = None
        elif event == "meta":
            with self._cond:
                self.result = dict(payload)
                self._cond.notify_all()

    def close(self, error: str = "") -> None:
        with self._cond:
            self.error = error
            self.done = True
            self._cond.notify_all()

    @property
    def continues(self) -> bool:
        """The endpoint rule: the session goes on and he asked something, so listen again."""
        result = self.result or {}
        return (str(result.get("status") or "") in _CONTINUES and not bool(result.get("end_session"))
                and bool(result.get("listen_again", True)))

    @property
    def audio_seconds(self) -> float:
        return self.audio_bytes / float(REPLY_RATE * 2)

    def wait_first_text(self, timeout: float) -> str:
        with self._cond:
            self._cond.wait_for(lambda: self.first_text or self.done, timeout)
            return self.first_text

    def wait_done(self, timeout: float) -> bool:
        with self._cond:
            return self._cond.wait_for(lambda: self.done, timeout)

    def audio(self, timeout: float = TURN_TIMEOUT_SECONDS):
        """The reply's PCM as it is made, until the turn is over."""
        deadline = time.monotonic() + timeout
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._chunks or self.done, max(0.0, deadline - time.monotonic()))
                if self._chunks:
                    chunk = self._chunks.popleft()
                elif self.done or time.monotonic() >= deadline:
                    return
                else:
                    continue
            yield chunk

    def _open(self, rate: int, text: str) -> None:
        self._resampler = LinearResampler(rate, REPLY_RATE)
        with self._cond:
            if not self.first_text:
                self.first_text = " ".join(text.split())
                self._cond.notify_all()

    def _add(self, pcm: bytes) -> None:
        if not pcm:
            return
        with self._cond:
            self._chunks.append(pcm)
            self.audio_bytes += len(pcm)
            self._cond.notify_all()


class AssistReplies:
    """Replies whose audio HA has not fetched yet, claimed by the TTS server by their first words."""

    def __init__(self, keep_seconds: float = REPLY_KEEP_SECONDS):
        self._keep = float(keep_seconds)
        self._lock = threading.Lock()
        self._items: list[AssistReply] = []

    def add(self, reply: AssistReply) -> None:
        with self._lock:
            self._prune()
            self._items.append(reply)

    def claim(self, text: str) -> AssistReply | None:
        key = _norm(text)
        if not key:
            return None
        with self._lock:
            self._prune()
            for reply in reversed(self._items):
                if reply.first_text and _norm(reply.first_text) == key:
                    self._items.remove(reply)
                    return reply
        return None

    def _prune(self) -> None:
        cutoff = time.monotonic() - self._keep
        self._items = [reply for reply in self._items if reply.created_at >= cutoff]


class AssistTurnServer:
    """``POST /assist/turn``: the agent's transcript in, NDJSON out."""

    def __init__(self, *, heard: HeardTurns, replies: AssistReplies,
                 run_turn: Callable[[str, str, bytes, Any, Callable[[dict], None], bool], None],
                 has_session: Callable[[str], bool], drop_session: Callable[[str, str], None],
                 host: str, port: int, log: Callable[[str], None] = print,
                 event: Callable[..., None] | None = None,
                 is_wake_phrase: Callable[[str], bool] = lambda _phrase: True,
                 music_listening: Callable[[str], None] | None = None,
                 music_release: Callable[[str], None] | None = None,
                 music_forget: Callable[[str], None] | None = None,
                 calibration_done: Callable[[str, str, int], str] | None = None,
                 training=None):
        self.heard = heard
        self.training = training
        self.is_wake_phrase = is_wake_phrase
        self.music_listening = music_listening
        self.music_release = music_release
        self.music_forget = music_forget
        self.calibration_done = calibration_done
        # client_id > the release waiting out MUSIC_IDLE_GRACE_SECONDS.
        self._music_timers: dict[str, threading.Timer] = {}
        self.replies = replies
        self.run_turn = run_turn
        self.has_session = has_session
        self.drop_session = drop_session
        self.host = host
        self.port = int(port)
        self.log = log
        self.event = event or (lambda *_args, **_kwargs: None)
        # client_id > (reply finished at, its audio seconds) when that reply listens again.
        self._follow_up: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None

    @property
    def address(self) -> tuple[str, int]:
        return self._server.server_address[:2] if self._server else (self.host, self.port)

    def start(self) -> None:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_POST(self) -> None:
                owner._handle_post(self)

            def log_message(self, *_args) -> None:
                pass

        self._server = ThreadingHTTPServer((self.host, self.port), Handler)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, name="assist-turn-api", daemon=True).start()
        host, port = self.address
        self.log(f"assist turn api listening on {host}:{port}")

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def client_id(self, body: dict) -> str:
        device = "".join(ch for ch in str(body.get("device_id") or body.get("satellite_id") or "")
                         if ch.isalnum() or ch in "-_.")[:64]
        return CLIENT_PREFIX + (device or "unknown")

    def _handle_post(self, request: BaseHTTPRequestHandler) -> None:
        if request.path == "/assist/music":
            self._handle_music(request)
            return
        if request.path == "/assist/calibration":
            self._handle_calibration(request)
            return
        if request.path.startswith("/assist/training/"):
            self._handle_training(request)
            return
        if request.path != "/assist/turn":
            request.send_error(404)
            return
        try:
            length = int(request.headers.get("Content-Length") or 0)
            body = json.loads(request.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
        except (ValueError, json.JSONDecodeError) as err:
            request.send_error(400, str(err))
            return
        request.send_response(200)
        request.send_header("Content-Type", "application/x-ndjson")
        request.send_header("Cache-Control", "no-store")
        request.end_headers()

        def send(payload: dict) -> None:
            request.wfile.write(json.dumps(payload).encode() + b"\n")
            request.wfile.flush()

        try:
            self._turn(body, send)
        except OSError as err:
            self.log(f"assist turn client went away: {err}")

    def _handle_music(self, request: BaseHTTPRequestHandler) -> None:
        try:
            length = int(request.headers.get("Content-Length") or 0)
            body = json.loads(request.rfile.read(length) or b"{}")
            state = str(body.get("state") or "") if isinstance(body, dict) else ""
            if state not in MUSIC_STATES:
                raise ValueError("state must be listening or idle")
        except (ValueError, json.JSONDecodeError) as err:
            request.send_error(400, str(err))
            return
        client_id = self.client_id(body)
        self.music(client_id, state)
        if state == "idle" and self.training is not None and self.training.take_beep(client_id):
            # A training sentence has just been said: the agent plays the beep and the satellite listens.
            data = b'{"beep_then_listen": true}'
            request.send_response(200)
            request.send_header("Content-Type", "application/json")
            request.send_header("Content-Length", str(len(data)))
            request.end_headers()
            request.wfile.write(data)
            return
        request.send_response(204)
        request.end_headers()

    def _handle_calibration(self, request: BaseHTTPRequestHandler) -> None:
        try:
            length = int(request.headers.get("Content-Length") or 0)
            body = json.loads(request.rfile.read(length) or b"{}")
            if not isinstance(body, dict) or not str(body.get("host") or "").strip():
                raise ValueError("host required")
            takes = max(0, int(body.get("takes") or 0))
        except (ValueError, TypeError, json.JSONDecodeError) as err:
            request.send_error(400, str(err))
            return
        say = ""
        if self.calibration_done is not None:
            say = self.calibration_done(self.client_id(body), str(body["host"]).strip(), takes)
        payload = json.dumps({"say": say}).encode()
        request.send_response(200)
        request.send_header("Content-Type", "application/json")
        request.send_header("Content-Length", str(len(payload)))
        request.end_headers()
        request.wfile.write(payload)

    def _handle_training(self, request: BaseHTTPRequestHandler) -> None:
        status, payload = 200, {}
        try:
            length = int(request.headers.get("Content-Length") or 0)
            body = json.loads(request.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
            if self.training is None:
                status, payload = 409, {"error": "voice training needs speaker identification"}
            elif request.path == "/assist/training/start":
                person_id = str(body.get("person_id") or "").strip().lower()
                name = " ".join(str(body.get("name") or "").split())
                if not person_id or not name or not str(body.get("device_id") or "").strip():
                    raise ValueError("device_id, person_id and name are required")
                payload = {"say": self.training.start(self.client_id(body), person_id, name, str(body.get("wake_word") or ""))}
            elif request.path == "/assist/training/status":
                payload = self.training.status()
            elif request.path == "/assist/training/cancel":
                self.training.cancel()
                payload = self.training.status()
            else:
                status, payload = 404, {"error": "not found"}
        except (ValueError, json.JSONDecodeError) as err:
            status, payload = 400, {"error": str(err)}
        except RuntimeError as err:
            status, payload = 409, {"error": str(err)}
        data = json.dumps(payload).encode()
        request.send_response(status)
        request.send_header("Content-Type", "application/json")
        request.send_header("Content-Length", str(len(data)))
        request.end_headers()
        request.wfile.write(data)

    def _training_turn(self, client_id: str, text: str, audio: bytes, send: Callable[[dict], None]) -> bool:
        """A take from the training satellite, answered here; False when it is an ordinary turn."""
        if self.training is None or not self.training.active_for(client_id):
            return False
        answer = self.training.turn(client_id, text, audio)
        if answer is None:
            return False
        continues = bool(answer.get("continue"))
        with self._lock:
            if continues:
                # The reply is spoken by HA's TTS request; allow for its length before the next take.
                self._follow_up[client_id] = (time.monotonic(), len(answer["reply_text"]) / 12.0)
            else:
                self._follow_up.pop(client_id, None)
        # Never listens straight after: the next take starts with the beep once the satellite is idle.
        send({"event": "done", "status": "voice_training", "reply_text": answer["reply_text"],
              "spoken": False, "continue": False})
        self.event("assist_voice_training_take", client_id=client_id, continues=continues)
        return True

    def music(self, client_id: str, state: str) -> None:
        """A satellite started listening (pause its music) or went idle (play it again, after the grace)."""
        with self._lock:
            timer = self._music_timers.pop(client_id, None)
        if timer is not None:
            timer.cancel()
        if state == "listening":
            if self.music_listening is not None:
                self.music_listening(client_id)
            return
        if self.music_release is None:
            return
        timer = threading.Timer(MUSIC_IDLE_GRACE_SECONDS, self._music_idle, args=(client_id,))
        timer.daemon = True
        with self._lock:
            self._music_timers[client_id] = timer
        timer.start()

    def _music_idle(self, client_id: str) -> None:
        with self._lock:
            self._music_timers.pop(client_id, None)
        self.music_release(client_id)

    def _turn(self, body: dict, send: Callable[[dict], None]) -> None:
        text = " ".join(str(body.get("text") or "").split())
        client_id = self.client_id(body)
        held = self.heard.claim(text) if text else None
        if self._training_turn(client_id, text, held[0] if held else b"", send):
            return
        if held is None:
            self.event("assist_turn_no_audio", client_id=client_id)
            send({"event": "done", "status": "no_audio", "reply_text": NO_AUDIO_LINE, "continue": False})
            return
        audio, speaker_future = held
        wake = str(body.get("start") or "") == "wake" and self.is_wake_phrase(str(body.get("wake_word") or ""))
        self._end_stale_session(client_id)
        reply = AssistReply(log=self.log)
        self.replies.add(reply)
        started = time.monotonic()
        # Only a new session needs the speaker check the STT server started; a follow-up has its own.
        future = None if self.has_session(client_id) else speaker_future

        def run() -> None:
            error = ""
            try:
                self.run_turn(client_id, text, audio, future, reply.write, wake)
            except Exception as err:
                error = str(err) or type(err).__name__
                self.log(f"assist turn failed: {error}")
            finally:
                reply.close(error)

        threading.Thread(target=run, name="assist-turn", daemon=True).start()
        first = reply.wait_first_text(TURN_TIMEOUT_SECONDS)
        first_text_ms = int(round((time.monotonic() - started) * 1000)) if first else None
        if first:
            send({"event": "speech", "text": first})
        reply.wait_done(TURN_TIMEOUT_SECONDS)
        result = reply.result or {}
        continues = reply.continues and not reply.error
        if result.get("music_hold") and not reply.error and self.music_forget is not None:
            self.music_forget(client_id)  # paused, stopped or a new song: leave it as the command left it
        with self._lock:
            if continues:
                self._follow_up[client_id] = (time.monotonic(), reply.audio_seconds)
            else:
                self._follow_up.pop(client_id, None)
        if not continues and not result.get("end_session"):
            # The dot goes idle: the session is over, as when an endpoint ends one.
            self.drop_session(client_id, "assist_turn_end")
        send({
            "event": "done",
            "status": str(result.get("status") or ("error" if reply.error else "")),
            "heard_text": result.get("heard_text"),
            "reply_text": str(result.get("reply_text") or ""),
            "spoken": bool(first),
            "continue": continues,
            **({"endpoint_command": result["endpoint_command"]} if isinstance(result.get("endpoint_command"), dict) else {}),
        })
        self.event("assist_turn_finished", client_id=client_id, status=result.get("status"),
                   wake=wake, continues=continues, first_text_ms=first_text_ms,
                   audio_ms=int(reply.audio_seconds * 1000), error=reply.error or None)

    def expects_follow_up(self) -> bool:
        """Whether a turn now would answer a reply that listened again, on any satellite: the STT
        server does not know which satellite it hears, and a follow-up needs no new speaker check."""
        return self.follow_up_client() is not None

    def follow_up_client(self) -> str | None:
        """The satellite whose reply listened again most recently, while its follow-up can come."""
        now = time.monotonic()
        with self._lock:
            waiting = [(at, client_id) for client_id, (at, seconds) in self._follow_up.items()
                       if now - at <= seconds + FOLLOW_UP_GRACE_SECONDS]
        return max(waiting)[1] if waiting else None

    def _end_stale_session(self, client_id: str) -> None:
        """A wake after a reply that listened again, but later than its follow-up could come, is new."""
        with self._lock:
            follow_up = self._follow_up.pop(client_id, None)
        if follow_up is None:
            return
        finished_at, audio_seconds = follow_up
        if time.monotonic() - finished_at > audio_seconds + FOLLOW_UP_GRACE_SECONDS:
            self.drop_session(client_id, "assist_new_wake")
