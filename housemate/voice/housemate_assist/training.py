"""Voice training on a speaker.

The page picks a person and an Assist satellite; the brain arms a session here for that satellite and
has HA announce the line ``start`` returns (intro and first sentence) on it. From then on that
satellite's turns are takes, not turns for the brain: each repeat of the sentence is kept (in memory
only) and answered "Good. Next sentence. <sentence>"; a repeat that is silent or not the sentence is
asked again. Every sentence starts with the wake word. The person repeats it after a beep, an audio file
the agent plays on the satellite once its reply has finished (``take_beep`` on idle: the satellite
then listens), so it works whatever TTS the house uses. After the last take: "Thank you. We are all
done now.", then the takes become the person's voice profile (``train`` replaces any older one) and
the audio is dropped. Nothing is kept from everyday use; nothing is written but the profile.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any, Callable

SENTENCES = (
    "{wake}, it is a very nice day today.",
    "{wake}, what's the weather doing this afternoon?",
    "{wake}, please turn the kitchen lights on.",
    "{wake}, remind me to call the plumber tomorrow morning.",
    "{wake}, how long until the washing machine is finished?",
    "{wake}, play something quiet in the lounge room.",
    "{wake}, add milk, bread and eggs to the shopping list.",
    "{wake}, is the back door locked?",
    "{wake}, set a timer for twelve minutes.",
    "{wake}, good night, see you in the morning.",
)
INTRO = ("Hello, this is voice training. You will hear me tell you a sentence, "
         "and then you repeat the sentence after each beep.")
NEXT = "Good. Next sentence."
AGAIN = "Sorry, I didn't catch that. Again."
DONE = "Thank you. We are all done now."
# A repeat must hold this share of the sentence's words (the wake word not counted) and this much voice.
MATCH_SHARE = 0.6
MIN_TAKE_SECONDS = 1.0
TAKE_BYTES_PER_SECOND = 16000 * 2
MAX_TRIES = 3
MIN_TAKES = 6
# The session ends when the speaker stops answering for this long.
SILENT_SECONDS = 90.0
WAKE_WORDS = {"hey", "hi", "ok", "okay"}


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower().replace("’", "'"))


class VoiceTraining:
    """One training session at a time, for one satellite and one person."""

    def __init__(self, *, train: Callable[[str, str, list[bytes], Callable[[float], None]], int],
                 log: Callable[[str], None] = print, clock: Callable[[], float] = time.monotonic,
                 background: Callable[[Callable[[], None]], None] | None = None,
                 trained: Callable[[], list[str]] | None = None):
        self._train = train
        self._trained = trained or (lambda: [])
        self._log = log
        self._clock = clock
        self._background = background or (lambda run: threading.Thread(target=run, name="voice-training", daemon=True).start())
        self._lock = threading.Lock()
        self._session: dict[str, Any] | None = None

    def start(self, client_id: str, person_id: str, name: str, wake_word: str) -> str:
        """Arms a session for this satellite; the line the satellite starts with (intro and first sentence)."""
        wake = " ".join(str(wake_word or "").split()) or "Hey Housemate"
        with self._lock:
            if self._session and self._session["state"] in ("recording", "training"):
                raise RuntimeError(f"voice training for {self._session['name']} is still running")
            self._session = {
                "client_id": client_id, "person_id": person_id, "name": name, "wake": wake,
                "sentences": [sentence.format(wake=wake) for sentence in SENTENCES],
                "index": 0, "tries": 0, "takes": [], "state": "recording", "progress": 0.0,
                "message": "", "heard": False, "last": self._clock(), "beep": True,
            }
            return f"{INTRO} {self._session['sentences'][0]}"

    def cancel(self) -> None:
        with self._lock:
            if self._session and self._session["state"] == "recording":
                self._finish("cancelled", "Stopped.")

    def status(self) -> dict:
        trained = sorted(set(self._trained()))
        with self._lock:
            session = self._session
            if session is None:
                return {"state": "idle", "trained": trained}
            if session["state"] == "recording" and self._clock() - session["last"] > SILENT_SECONDS:
                self._finish("failed", "The speaker stopped answering. Check its voice assistant is Housemate, then try again."
                             if not session["heard"] else "Nobody answered for a while, so training stopped.")
            return {
                "state": session["state"], "person_id": session["person_id"], "name": session["name"],
                "sentence": min(session["index"] + 1, len(session["sentences"])), "total": len(session["sentences"]),
                "takes": len(session["takes"]), "progress": round(session["progress"], 3), "message": session["message"],
                "trained": trained,
            }

    def active_for(self, client_id: str) -> bool:
        with self._lock:
            return bool(self._session and self._session["state"] == "recording" and self._session["client_id"] == client_id)

    def take_beep(self, client_id: str) -> bool:
        """Whether this satellite has just been told a sentence: once, as it goes idle after saying it."""
        with self._lock:
            session = self._session
            if not session or session["state"] != "recording" or session["client_id"] != client_id or not session["beep"]:
                return False
            session["beep"] = False
            return True

    def turn(self, client_id: str, text: str, audio: bytes) -> dict | None:
        """A turn from the training satellite: the reply ({reply_text, continue: another take follows the
        beep}); None for any other turn."""
        with self._lock:
            session = self._session
            if not session or session["state"] != "recording" or session["client_id"] != client_id:
                return None
            session["last"] = self._clock()
            session["heard"] = True
            sentence = session["sentences"][session["index"]]
            if self._matches(text, sentence) and len(audio or b"") >= MIN_TAKE_SECONDS * TAKE_BYTES_PER_SECOND:
                session["takes"].append(bytes(audio))
            else:
                session["tries"] += 1
                if session["tries"] < MAX_TRIES:
                    session["beep"] = True
                    return {"reply_text": f"{AGAIN} {sentence}", "continue": True}
                self._log(f"voice training: skipped sentence {session['index'] + 1} after {MAX_TRIES} tries")
            session["index"] += 1
            session["tries"] = 0
            if session["index"] < len(session["sentences"]):
                session["beep"] = True
                return {"reply_text": f"{NEXT} {session['sentences'][session['index']]}", "continue": True}
            if len(session["takes"]) < MIN_TAKES:
                self._finish("failed", f"Only {len(session['takes'])} sentences came through clearly. Try again somewhere quieter.")
                return {"reply_text": "Sorry, I didn't hear enough clearly. Let's try again later.", "continue": False}
            session["state"] = "training"
            takes, person_id, name = session["takes"], session["person_id"], session["name"]
        self._background(lambda: self._run_training(person_id, name, takes))
        return {"reply_text": DONE, "continue": False}

    def _matches(self, heard: str, sentence: str) -> bool:
        wake = set(_words(self._session["wake"])) | WAKE_WORDS if self._session else WAKE_WORDS
        expected = [word for word in _words(sentence) if word not in wake]
        said = set(_words(heard))
        return bool(expected) and sum(word in said for word in expected) / len(expected) >= MATCH_SHARE

    def _run_training(self, person_id: str, name: str, takes: list[bytes]) -> None:
        def progress(share: float) -> None:
            with self._lock:
                if self._session:
                    self._session["progress"] = max(0.0, min(1.0, float(share)))
        try:
            used = self._train(person_id, name, takes, progress)
            with self._lock:
                self._finish("complete", f"Trained on {used} sentences.")
                if self._session:
                    self._session["progress"] = 1.0
            self._log(f"voice training complete for {person_id}: {used} takes")
        except Exception as err:  # noqa: BLE001 - any failure is shown on the page
            with self._lock:
                self._finish("failed", f"Training failed: {err}")
            self._log(f"voice training failed for {person_id}: {err}")

    def _finish(self, state: str, message: str) -> None:
        """Ends the session (caller holds the lock); the audio goes with it."""
        if self._session:
            self._session["state"] = state
            self._session["message"] = message
            self._session["takes"] = []
