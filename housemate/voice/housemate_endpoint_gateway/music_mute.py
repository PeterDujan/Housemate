"""Music paused while an endpoint listens and while the assistant answers.

The voice host pauses the endpoint's Music Assistant player once a wake is confirmed,
keeps it paused through the request, the assistant's reply and any follow-up, and plays
it again when the conversation is over. A command that leaves the music as it
wants it (pause, stop, a new song) tells the gateway to forget the hold instead.
It is only Music Assistant's own pause on the endpoint's player, so it works the
same on every endpoint (a speaker now, ESP32 speaker later) and needs nothing
from the endpoint itself.

It replaced a mute (same day): Music Assistant's mute is the endpoint's whole
speaker, so it could not cover the reply, and HA's mute flag stayed "muted" while
a speaker played aloud.

Failsafes, because music left paused is a song that never comes back: play it
again when the turn ends for any reason other than a hold, after `max_mute_s`
whatever happens, and at start-up for anything a crash left paused
(`state_path`).
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Callable, Protocol

# HA's state may still say paused this long after we play the music again; the assistant may be asked inside it.
RECENT_UNMUTE_S = 5.0


class HomeAssistantPlayers(Protocol):
    def read_state(self, entity_id: str) -> dict[str, Any] | None: ...

    def call_service(self, domain: str, service: str, data: dict[str, Any]) -> bool: ...


class MusicMute:
    def __init__(
        self,
        ha: HomeAssistantPlayers,
        player_for: Callable[[str], str | None],
        *,
        state_path: str,
        log_event: Callable[..., None] = lambda name, **fields: None,
        max_mute_s: float = 90.0,
    ):
        self._ha = ha
        self._player_for = player_for
        self._state_path = state_path
        self._log_event = log_event
        self._max_mute_s = max_mute_s
        self._lock = threading.Lock()
        # endpoint id -> (player we paused, failsafe timer)
        self._muted: dict[str, tuple[str, threading.Timer]] = {}
        self._busy: dict[str, threading.Lock] = {}
        self._save_lock = threading.Lock()
        # Endpoints whose microphone is open: a mute still on its way checks this before acting.
        self._wanted: set[str] = set()
        # endpoint id -> when we last played it again at the end of a request (monotonic seconds).
        self._unmuted_at: dict[str, float] = {}

    def recover(self) -> None:
        """Play again what a crash or restart left paused by us."""
        for entity_id in self._load():
            self._set_paused(entity_id, False)
            self._log_event("endpoint_music_resumed", player=entity_id, reason="recovered")
        self._save()

    def listening(self, endpoint_id: str) -> None:
        """A confirmed wake or a follow-up opened the microphone: pause the music, off the caller's thread."""
        with self._lock:
            self._wanted.add(endpoint_id)
        threading.Thread(target=self._pause, args=(endpoint_id,), name="endpoint-music-pause", daemon=True).start()

    def release(self, endpoint_id: str, then: Callable[[], None] | None = None) -> None:
        """The conversation is over: the music plays again, then."""
        with self._lock:
            muted = endpoint_id in self._muted
            # A pause still on its way sees this and undoes itself (`_pause`), so nothing waits on it.
            self._wanted.discard(endpoint_id)
        if not muted:
            if then is not None:
                then()
            return

        def run() -> None:
            self._resume(endpoint_id, "turn_over")
            if then is not None:
                then()

        threading.Thread(target=run, name="endpoint-music-resume", daemon=True).start()

    def forget(self, endpoint_id: str, reason: str) -> None:
        """The command left the music as it wants it (pause, stop, a new song): drop the hold, play nothing."""
        with self._lock:
            self._wanted.discard(endpoint_id)
            busy = self._endpoint_lock(endpoint_id)
        with busy:
            with self._lock:
                entry = self._muted.pop(endpoint_id, None)
            if entry is None:
                return
            entry[1].cancel()
            self._save()
        self._log_event("endpoint_music_left", endpoint_id=endpoint_id, player=entry[0], reason=reason)

    def muted_for_turn(self, endpoint_id: str) -> bool:
        """True while this endpoint's music is paused by us for the request, or was until a moment ago:
        to the assistant it is still on. HA's state can lag the pause or the play by a moment."""
        with self._lock:
            recent = time.monotonic() - self._unmuted_at.get(endpoint_id, -RECENT_UNMUTE_S) < RECENT_UNMUTE_S
            return endpoint_id in self._muted or recent

    def _endpoint_lock(self, endpoint_id: str) -> threading.Lock:
        lock = self._busy.get(endpoint_id)
        if lock is None:
            lock = self._busy[endpoint_id] = threading.Lock()
        return lock

    def _pause(self, endpoint_id: str) -> None:
        with self._lock:
            busy = self._endpoint_lock(endpoint_id)
        with busy:
            with self._lock:
                if endpoint_id in self._muted or endpoint_id not in self._wanted:
                    return
            player = self._player_for(endpoint_id)
            if not player:
                return
            state = self._ha.read_state(player) or {}
            attributes = state.get("attributes") if isinstance(state.get("attributes"), dict) else {}
            # Only music that is actually playing (HA's mute flag is not trusted: it stuck on while a speaker played).
            if state.get("state") != "playing":
                return
            if not self._set_paused(player, True):
                return
            timer = threading.Timer(self._max_mute_s, self._resume, args=(endpoint_id, "failsafe"))
            timer.daemon = True
            with self._lock:
                released = endpoint_id not in self._wanted
                if not released:
                    self._muted[endpoint_id] = (player, timer)
            if released:
                # The request ended while the pause was on its way: play it straight away.
                self._set_paused(player, False) or self._set_paused(player, False)
                self._log_event("endpoint_music_resumed", endpoint_id=endpoint_id, player=player, reason="late_pause")
                return
            timer.start()
            self._save()
            self._log_event("endpoint_music_paused", endpoint_id=endpoint_id, player=player)

    def _resume(self, endpoint_id: str, reason: str) -> None:
        with self._lock:
            busy = self._endpoint_lock(endpoint_id)
        with busy:
            with self._lock:
                entry = self._muted.pop(endpoint_id, None)
            if entry is None:
                return
            player, timer = entry
            timer.cancel()
            with self._lock:
                self._unmuted_at[endpoint_id] = time.monotonic()
            ok = self._set_paused(player, False)
            if not ok:
                # One retry: music left paused never comes back by itself.
                ok = self._set_paused(player, False)
            self._save()
            self._log_event("endpoint_music_resumed", endpoint_id=endpoint_id, player=player, reason=reason, ok=ok)

    def _set_paused(self, player: str, paused: bool) -> bool:
        try:
            return bool(self._ha.call_service("media_player", "media_pause" if paused else "media_play", {"entity_id": player}))
        except Exception:  # an HA hiccup must not break the turn
            return False

    def _load(self) -> list[str]:
        try:
            with open(self._state_path, "r", encoding="utf-8") as handle:
                players = json.load(handle).get("muted", [])
        except (OSError, ValueError, AttributeError):
            return []
        return [str(player) for player in players if str(player).startswith("media_player.")]

    def _save(self) -> None:
        with self._lock:
            players = sorted({player for player, _ in self._muted.values()})
        try:
            os.makedirs(os.path.dirname(self._state_path) or ".", exist_ok=True)
            with self._save_lock, open(self._state_path, "w", encoding="utf-8") as handle:
                json.dump({"muted": players}, handle)
        except OSError:
            pass
