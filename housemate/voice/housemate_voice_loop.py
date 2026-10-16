#!/usr/bin/env python3
import argparse
import array
import base64
import collections
import contextlib
import copy
import dataclasses
import io
import json
import math
import multiprocessing
import glob
import hashlib
import os
import random
import re
import shutil
import queue
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
import wave
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

warnings.filterwarnings("ignore", message="pkg_resources is deprecated as an API")

import webrtcvad
from faster_whisper import WhisperModel
from vosk import KaldiRecognizer, Model, SetLogLevel
try:
    import websocket
except ImportError:  # pragma: no cover - live runtime fallback
    websocket = None
try:
    from fishaudio import FishAudio
    from fishaudio.types import FlushEvent, Prosody, TTSConfig
except ImportError:  # pragma: no cover - live runtime fallback
    FishAudio = None
    FlushEvent = None
    Prosody = None
    TTSConfig = None
try:
    import numpy as np
except ImportError:  # pragma: no cover - live runtime fallback
    np = None
try:
    from pymicro_wakeword import MicroWakeWord, MicroWakeWordFeatures
    from pymicro_wakeword import Model as MicroWakeWordBuiltinModel
except ImportError:  # pragma: no cover - live runtime fallback
    MicroWakeWord = None
    MicroWakeWordFeatures = None
    MicroWakeWordBuiltinModel = None
try:
    import torch
    from speechbrain.inference.speaker import SpeakerRecognition
except ImportError:  # pragma: no cover - live runtime fallback
    torch = None
    SpeakerRecognition = None


FRAME_MS = 30
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
CHANNELS = 1
FRAME_BYTES = int(SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS * FRAME_MS / 1000)
SILENCE_FRAME = b"\x00" * FRAME_BYTES
OPENWAKEWORD_FRAME_SAMPLES = 1280
OPENWAKEWORD_FRAME_BYTES = OPENWAKEWORD_FRAME_SAMPLES * SAMPLE_WIDTH
MICROWAKEWORD_FRAME_MS = 10
MICROWAKEWORD_FRAME_SAMPLES = int(SAMPLE_RATE * MICROWAKEWORD_FRAME_MS / 1000)
MICROWAKEWORD_FRAME_BYTES = MICROWAKEWORD_FRAME_SAMPLES * SAMPLE_WIDTH
WAKE_HISTORY_MS = 2500
WAKE_CHUNK_FRAMES = 5
CONTROL_VERB_RE = r"(?:turn|switch|set|toggle|open|close|shut|raise|lift|lower|lock|unlock|stop|run|start|launch|activate|pause|play|resume|mute|unmute|clean|vacuum|mop|sweep|dock)"
DEVICE_NOUN_RE = r"(?:light|lights|lamp|lamps|switch|switches|plug|plugs|socket|sockets|outlet|outlets|fan|fans|door|doors|blind|blinds|shade|shades|curtain|curtains|cover|covers|lock|locks|garage|vacuum|robovac|climate|aircon|air\\s+con|air\\s+conditioner|ac|heater|thermostat|scene|scenes|script|scripts|speaker|speakers|echo|echoes|alexa|tv|media|stereo)"
BEEP_DURATION_MS = 100
BEEP_FREQUENCY_HZ = 880
BEEP_AMPLITUDE = 0.12
WAKE_GREETING_TICK_INTERVAL_SECONDS = 0.35
WAKE_GREETING_TICK_DURATION_MS = 25
WAKE_GREETING_TICK_FREQUENCY_HZ = 740
WAKE_GREETING_TICK_AMPLITUDE = 0.03
DEFAULT_GREETING_SPEAKER = "General"
# Endpoint speaker ID: the gateway sends the wake-word history first (its 2 s pre-roll), so identification starts on that alone; a later turn's own match is waited for
# this long at most.
# An endpoint's speaker check runs on 1.0-3.5 s of its stream: the end of the 2 s pre-roll, which
# holds "Hey Housemate", and the first of the request, without the room noise that starts the pre-roll.
# It names the speaker far more often than the first 2 s alone.
ENDPOINT_WAKE_SPEAKER_FROM = SAMPLE_RATE * SAMPLE_WIDTH
ENDPOINT_WAKE_SPEAKER_BYTES = int(SAMPLE_RATE * SAMPLE_WIDTH * 3.5)
ENDPOINT_TURN_SPEAKER_WAIT_S = 0.5
# The STT server's speaker check runs before HA says which satellite heard it.
ASSIST_CLIENT_LOG_ID = "endpoint:assist"
# An Assist satellite's endpoint id is this plus its HA device id (housemate_assist.turns.CLIENT_PREFIX).
ASSIST_ENDPOINT_PREFIX = "assist-"
# The calibration takes leave an Assist dot this long after "Calibration done." starts playing.
ASSIST_CALIBRATION_FETCH_DELAY_S = 3.0
# An Assist turn with no pre-roll (the dot's button) checks its opening words, which takes ~1.9 s on
# the voice host: a new session waits this long for it rather than start as a guest (a 3.9 s check
# missed a 0.5 s wait). A wake turn's pre-roll starts the check 1.5 s
# after the wake word; a short command's transcript is in ~0.8 s after it, so it waits up to
# ASSIST_WAKE_SPEAKER_WAIT_S.
ASSIST_SPEAKER_WAIT_S = 2.5
ASSIST_WAKE_SPEAKER_WAIT_S = 1.5
# A refused wake's words are logged only when this short: enough for the misheard-wake cases.
WAKE_REJECTED_LOG_WORDS = 4
# The assistant's own wake greetings: formal, measured, warm, never chirpy, and never
# a name (speaker ID lands after the greeting starts).
# Greetings are warm by the assistant's tone rules.
WAKE_GREETINGS = {
    "morning": (
        "Good morning.",
        "Good morning. Go ahead.",
        "Good morning. I am listening.",
        "Good morning. What requires my attention?",
        "Good morning. What shall we attend to?",
        "Good morning. You have my attention.",
        "Good morning. What is on your mind?",
        "Good morning. Please, continue.",
        "Good morning. Where shall we begin?",
        "Good morning. How has your morning begun?",
    ),
    "afternoon": (
        "Good afternoon.",
        "Good afternoon. Go ahead.",
        "Good afternoon. I am listening.",
        "Good afternoon. What requires my attention?",
        "Good afternoon. What shall we attend to?",
        "Good afternoon. You have my attention.",
        "Good afternoon. What is on your mind?",
        "Good afternoon. Please, continue.",
        "Good afternoon. Where shall we begin?",
        "Good afternoon. How is your day progressing?",
    ),
    "evening": (
        "Good evening.",
        "Good evening. Go ahead.",
        "Good evening. I am listening.",
        "Good evening. What requires my attention?",
        "Good evening. What shall we attend to?",
        "Good evening. You have my attention.",
        "Good evening. What is on your mind?",
        "Good evening. Please, continue.",
        "Good evening. Where shall we begin?",
        "Good evening. How was your day?",
    ),
}
WAKE_GREETING_SPEECH = {"tone": "warm"}
# A bare "Hey Housemate" on an endpoint is not greeted: the microphone stays open,
# and only after a few seconds of quiet does he say one of these and listen on.
WAKE_ACKS = ("Mm-hm?", "Uh-huh?", "Yes?")
# The house's own time zone: the Supervisor gives every add-on HA's as TZ.
LOCAL_GREETING_TIMEZONE = ZoneInfo(os.environ.get("TZ") or "UTC")
UNKNOWN_SPEAKER = "Unknown"
# A speaker match costs about a second of CPU per second of voice on the voice host; 8 s of voice is as
# sure as a whole long turn and is done while the assistant answers.
SPEAKER_ID_MAX_VOICED_SECONDS = 8.0


# The house is data. The brain's household.json names the people (speaker profiles use each
# person's short name) and the assistant's name comes from settings; configure_house sets both at
# start. The brain carries identity (context, memory, brief) only for a canonical person id in
# voice_id; a bare display name stays "recognized" and is treated as a guest.
_HOUSE = {"assistant": "Housemate", "heard_as": (), "speakers": {}, "ears_prompts": None}

def read_household_speakers(path: str) -> dict[str, str]:
    """{short name: person id} from the brain's household.json; {} when there is no file."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (FileNotFoundError, IsADirectoryError):
        return {}
    speakers = {}
    for person in raw.get("people") or []:
        person_id = str(person.get("id") or "").strip().lower()
        name = str(person.get("short_name") or person.get("name") or "").strip()
        if person_id and name:
            speakers[name] = person_id
    return speakers


def configure_house(
    assistant_name: str | None = None,
    household_file: str | None = None,
    ears_prompts: dict | None = None,
    heard_as: list | None = None,
) -> None:
    """Sets what is given and leaves the rest (a config without them keeps the house as it is).
    `heard_as` is how speech-to-text tends to write the name (the persona's mishearings)."""
    if assistant_name is not None:
        _HOUSE["assistant"] = str(assistant_name).strip() or "Housemate"
    if heard_as is not None:
        _HOUSE["heard_as"] = tuple(dict.fromkeys(normalize_text(str(word)) for word in heard_as if normalize_text(str(word))))
    if assistant_name is not None or heard_as is not None:
        configure_name_patterns()
    if household_file is not None:
        _HOUSE["speakers"] = read_household_speakers(household_file) if household_file else {}
    if ears_prompts is not None:
        _HOUSE["ears_prompts"] = dict(ears_prompts) or None


def assistant_name() -> str:
    return _HOUSE["assistant"]


def assistant_slug() -> str:
    """The name as Home Assistant ids use it ("Housemate" -> "housemate")."""
    return re.sub(r"[^a-z0-9]+", "_", assistant_name().lower()).strip("_") or "housemate"


def assistant_names() -> tuple[str, ...]:
    """Every spoken form of the name the voice listens for: the name and how it is misheard."""
    return tuple(dict.fromkeys((normalize_text(assistant_name()), *_HOUSE["heard_as"])))


def name_alternation() -> str:
    return "|".join(re.escape(name) for name in sorted(assistant_names(), key=len, reverse=True))


def known_wake_speakers() -> frozenset:
    return frozenset(_HOUSE["speakers"])


def speaker_person_ids() -> dict[str, str]:
    return dict(_HOUSE["speakers"])


def profile_speaker_name(record: dict) -> str:
    """The name a voice profile answers to now. A profile that carries its person's memory id
    (`person_id`) takes that person's current name, so renaming someone never means training their
    voice again; "@where" variants ("@show") keep their suffix. Without an id: the trained name."""
    name = str(record.get("name") or "").strip()
    person_id = str(record.get("person_id") or "").strip().lower()
    current = {pid: speaker for speaker, pid in speaker_person_ids().items()}.get(person_id) if person_id else None
    if not current:
        return name
    _, at, where = name.partition("@")
    return current + (at + where if at else "")


def replace_person_profile(path: str, person_id: str, name: str, record: dict) -> None:
    """Drops every profile of this person (by id, or by the name for an untagged one) and adds ``record``.
    Copy first (<file>.bak-<time>), written whole."""
    if not path:
        raise RuntimeError("no speaker profile file is configured")
    payload = {"created_at": int(time.time()), "sample_rate": SAMPLE_RATE, "speakers": []}
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict) and isinstance(loaded.get("speakers"), list):
            payload = loaded
        shutil.copy2(path, f"{path}.bak-{int(time.time())}")
    base = name.lower()
    payload["speakers"] = [
        speaker for speaker in payload["speakers"]
        if isinstance(speaker, dict)
        and str(speaker.get("person_id") or "").lower() != person_id
        and not (not speaker.get("person_id") and str(speaker.get("name") or "").split("@", 1)[0].strip().lower() == base)
    ] + [record]
    payload["created_at"] = int(time.time())
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temp = f"{path}.tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(temp, path)


def tag_profiles_with_person_ids(path: str) -> bool:
    """Profiles trained before they carried ids get their person's id from the name they were trained
    under, while that name still means them. Copy first (<file>.bak-<time>); True when it wrote."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return False
    speakers = payload.get("speakers") if isinstance(payload, dict) else None
    if not isinstance(speakers, list):
        return False
    ids = {speaker.lower(): pid for speaker, pid in speaker_person_ids().items()}
    changed = False
    for record in speakers:
        if not isinstance(record, dict) or record.get("person_id"):
            continue
        person_id = ids.get(str(record.get("name") or "").split("@", 1)[0].strip().lower())
        if person_id:
            record["person_id"] = person_id
            changed = True
    if not changed:
        return False
    shutil.copy2(path, f"{path}.bak-{int(time.time())}")
    temp = f"{path}.tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(temp, path)
    return True

WAKE_SPEAKER_GRACE_SECONDS = 0.2
WAKE_PROMPT_MIN_DELAY_SECONDS = 2.5
THINKING_CLIP_DELAY_SECONDS = 2.0
WAITING_CLIP_DELAY_SECONDS = 5.0
MAX_REPEATING_WAIT_CLIPS = 1
SILENT_REPLY_POLL_SECONDS = 0.5
POST_CLIP_REPLY_DELAY_SECONDS = 2.0
DEFAULT_MAX_TURN_SECONDS = 30.0
LEGACY_MAX_TURN_SECONDS = 12.0
# Past max_turn_seconds a turn ends at the speaker's next pause rather than
# mid-word; this is the absolute ceiling for an open mic.
DEFAULT_HARD_MAX_TURN_SECONDS = 120.0
# Past max_turn_seconds, a pause this long ends the turn (a breath, not a word gap).
SOFT_CAP_PAUSE_MS = 600
PERSONALITY_TAIL_MIN_POLL_TIMEOUT_SECONDS = 1.2
PERSONALITY_TAIL_MAX_POLL_TIMEOUT_SECONDS = 12.0
PERSONALITY_TAIL_READY_GRACE_SECONDS = 0.4
PERSONALITY_TAIL_PREP_READY_GRACE_SECONDS = 0.12
FISH_FIRST_AUDIO_TIMEOUT_SECONDS = 5.0
FISH_STREAM_IDLE_TIMEOUT_SECONDS = 15.0
FISH_WORKER_READY_TIMEOUT_SECONDS = 20.0
FISH_AUDIO_SAMPLE_RATE = 44100
PROGRESSIVE_PCM_STARTUP_MS = 300
PROGRESSIVE_PCM_TARGET_MS = 2000
PROGRESSIVE_PCM_MAX_MS = 8000
PROGRESSIVE_TEXT_COALESCE_SECONDS = 0.08
PROGRESSIVE_TEXT_COALESCE_MAX_WORDS = 36
PROGRESSIVE_EVENT_LINE_MAX_BYTES = 1024 * 1024
PROGRESSIVE_EVENT_TOTAL_MAX_BYTES = 2 * 1024 * 1024
PROGRESSIVE_EVENT_MAX_COUNT = 105
ELEVENLABS_STREAM_CHUNK_BYTES = FRAME_BYTES * 4
ELEVENLABS_STREAM_COMMIT_HOLD_BYTES = FRAME_BYTES
DEEPGRAM_STREAM_CHUNK_BYTES = FRAME_BYTES * 4
DEEPGRAM_WARM_KEEPALIVE_SECONDS = 4.0
DEEPGRAM_WARM_MAX_AGE_SECONDS = 120.0
DEEPGRAM_FLUX_CHUNK_BYTES = int(SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS * 80 / 1000)  # Flux wants ~80 ms chunks
DEEPGRAM_FLUX_CAUGHT_UP_SECONDS = 0.25
DEEPGRAM_END_OF_TURN_MODES = ("silence", "flux")
DEFAULT_DEEPGRAM_FLUX_MODEL = "flux-general-en"
DEFAULT_DEEPGRAM_FLUX_EOT_THRESHOLD = 0.7
DEFAULT_INWORLD_STT_URL = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional"
DEFAULT_INWORLD_STT_MODEL = "inworld/inworld-stt-1"
DEFAULT_INWORLD_EOT_THRESHOLD = 0.4
INWORLD_STREAM_CHUNK_BYTES = int(SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS * 100 / 1000)  # docs example: 100 ms
INWORLD_VOICE_PROFILE_MAX_TOP_N = 5
# Inworld answers pure silence with nothing at all after closeStream: no
# final, no usage, no close. When it has sent nothing
# for the whole turn and the turn itself was silent, end empty after this
# grace instead of the full timeout. Audible turns still time out and fall back.
INWORLD_SILENT_TURN_GRACE_SECONDS = 1.5
INWORLD_SILENT_TURN_MAX_RMS = 100
# Inworld's published vocabulary.
# Anything else is dropped: there is no sarcasm label, and an unknown label
# must never be read as one.
INWORLD_VOICE_PROFILE_LABELS = {
    "age": frozenset({"young", "adult", "kid", "old", "unclear"}),
    "emotion": frozenset({
        "tender", "sad", "calm", "neutral", "happy", "angry",
        "fearful", "surprised", "disgusted", "unclear",
    }),
    "pitch": frozenset({"low", "medium", "high"}),
    "vocalStyle": frozenset({
        "whispering", "normal", "singing", "mumbling", "crying",
        "laughing", "shouting", "monotone", "unclear",
    }),
    "accent": None,  # BCP-47 code, checked by pattern
}
INWORLD_ACCENT_PATTERN = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$")
DEFAULT_ARNNDN_MODEL_PATH = "~/models/ffmpeg-arnndn/std.rnnn"
DEFAULT_WAKE_ENGINE = "microwakeword"
DEFAULT_MICROWAKEWORD_MODEL = "hey_jarvis"
DEFAULT_SPEAKER_PROFILES_PATH = "~/.local/share/housemate-voice/training/profiles/speaker_profiles.json"
DEFAULT_WAKE_SPEAKER_PROFILES_PATH = "~/.local/share/housemate-voice/training/profiles/wake_speaker_profiles.json"
DEFAULT_SPEAKER_MODEL_CACHE_DIR = "~/.cache/speechbrain/spkrec-ecapa-voxceleb"
DEFAULT_SPEAKER_THRESHOLD = 0.62
DEFAULT_SPEAKER_MIN_SECONDS = 0.45
DEFAULT_VOICE_EVENT_LOG_DIR = "~/.local/share/housemate-voice/logs"
DEFAULT_HA_STATE_PUBLISH_CACHE_PATH = "~/.local/share/housemate-voice/state/ha-state-publisher.json"
DEFAULT_WAKE_SAMPLE_DIR = "~/.local/share/housemate-voice/wake-samples"
# Guided recording: "time to test" makes the assistant read one labelled line
# per turn and keeps the next turn's audio as that clip for the STT A/B
# (housemate_voice_stt_ab.py). Clips never reach the assistant brain.
DEFAULT_EARS_CLIP_DIR = "~/.local/share/housemate-voice/ears/clips"
EARS_DELIVERIES = ("literal", "sarcastic", "dry", "amused", "annoyed", "doubtful", "concerned", "neutral")
EARS_DELIVERY_CUES = {
    "literal": "Mean it",
    "sarcastic": "Sarcastic",
    "dry": "Dry",
    "amused": "Amused",
    "annoyed": "Annoyed",
    "doubtful": "Doubtful",
    "concerned": "Concerned",
    "neutral": "Flat and neutral",
}
EARS_SAME_SENTENCES = {
    "A": "Oh great, the dishwasher's finished.",
    "B": "Yeah, that's exactly what I wanted.",
    "C": "{name}, you're a genius.",
}
# The house lines of the test; a house sets its own as `ears_house_prompts`.
DEFAULT_EARS_HOUSE_PROMPTS = {
    "H1": "{name}, tell everyone dinner's ready in five minutes.",
    "H2": "{name}, is the back door locked?",
    "H3": "Turn the office lights off and set the bedroom fan to fifty percent.",
    "H4": "What's the weather doing tomorrow afternoon?",
    "H5": "Remind me to put the bins out on Thursday night.",
    "H6": "Play some music in the kitchen.",
}


def ears_start_re() -> re.Pattern:
    name = re.escape(normalize_text(assistant_name()))
    return re.compile(rf"^(?:(?:ok|okay|right|alright|{name})\s+)*(?:it'?s\s+)?time\s+(?:to|for)\s+(?:a\s+|the\s+)?test(?:ing)?(?:\s+{name})?$")
EARS_STOP_PHRASES = frozenset({
    "stop", "stop test", "stop testing", "stop the test", "end test", "end the test", "pause",
    "pause test", "that's enough", "enough", "finish", "finished", "done", "i'm done",
})
EARS_REDO_PHRASES = frozenset({"redo", "redo that", "again", "do that again", "do it again", "try again", "one more time"})
EARS_SKIP_PHRASES = frozenset({"skip", "skip that", "skip it", "skip this one", "next", "next one"})
EARS_REPEAT_PHRASES = frozenset({"repeat", "repeat that", "what was that", "pardon", "say that again", "what was the line"})


def ears_prompt_table() -> dict[str, dict]:
    prompts = {}
    name = assistant_name()
    for key, text in EARS_SAME_SENTENCES.items():
        for index, delivery in enumerate(EARS_DELIVERIES, start=1):
            prompts[f"{key}{index}"] = {"text": text.replace("{name}", name), "delivery": delivery, "group": key}
    for key, text in (_HOUSE["ears_prompts"] or DEFAULT_EARS_HOUSE_PROMPTS).items():
        prompts[key] = {"text": str(text).replace("{name}", name), "delivery": "neutral", "group": "H"}
    return prompts


def ears_prompt_line(prompt_id: str, prompts: dict[str, dict]) -> str:
    prompt = prompts[prompt_id]
    number = list(prompts).index(prompt_id) + 1
    cue = "Normal voice" if prompt["group"] == "H" else EARS_DELIVERY_CUES[prompt["delivery"]]
    return f"{number}. {cue}. {prompt['text']}"


def is_ears_start_command(text: str) -> bool:
    return bool(ears_start_re().match(normalize_text(text)))


# "Hey Housemate, play calibration": a speaker records its raw microphones for every
# "Hey Housemate" that follows, beeping each one, then says it is done (housemate_endpoint_gateway/live.py).
CALIBRATION_TAKES = 8
CALIBRATION_TIMEOUT_MS = 120_000
CALIBRATION_START_TEXT = "Calibration starting."  # then the endpoint beeps for the first take
CALIBRATION_UNSUPPORTED_TEXT = "This speaker can't record a calibration."


def is_calibration_start_command(text: str) -> bool:
    return bool(CALIBRATION_START_RE.match(normalize_text(text)))
# Fixed lines rendered once through Fish and replayed from disk.
DEFAULT_SPEECH_CACHE_DIR = "~/.local/share/housemate-voice/speech-cache"
SPEECH_CACHE_WARM_PAUSE_SECONDS = 0.5
WAKE_SAMPLE_KINDS = frozenset({"detected", "near_miss", "speech_miss"})
DEFAULT_PROMPT_TEXT_MANIFEST_PATH = "~/.config/housemate-voice/prompt-text.json"
DEFAULT_WAKE_ACK_CLIP_PATH = "~/.config/housemate-voice/loading.mp3"
DEFAULT_WAKE_ACK_CLIP_SPEED = 1.0
DEFAULT_WAKE_ACK_CLIP_VOLUME = 1.0
def ha_state_entity(domain: str, suffix: str) -> str:
    """The voice's own Home Assistant states, named after the assistant (sensor.housemate_voice_state)."""
    return f"{domain}.{assistant_slug()}_{suffix}"

HA_VOICE_STATES = ("idle", "listening", "thinking", "speaking_thinking", "speaking", "processing")
BROWSER_SESSION_REAP_SECONDS = 10.0
# The assistant picks one of these tones in code for every spoken segment. The loop only maps it to a Fish delivery tag; it never guesses.
SPEECH_TONES = ("neutral", "warm", "dry", "amused", "concerned", "sombre", "bright")
DEFAULT_FISH_TONE_TAGS = {
    "warm": "[warm]",
    "dry": "[dry]",
    "amused": "[amused]",
    "concerned": "[concerned]",
    "sombre": "[solemn]",
    "bright": "[cheerful]",
}
DEFAULT_FISH_TTS_NIGHT_START = "22:00"
DEFAULT_FISH_TTS_NIGHT_END = "07:00"
DEFAULT_FISH_TTS_NIGHT_VOLUME_DB = -6.0
DEFAULT_FISH_TTS_NIGHT_SPEED = 0.95
DEFAULT_V5_TEST_URL = os.environ.get("JARVIS_V5_TEST_URL", "http://127.0.0.1:3005/voice/brain")
DEFAULT_SELF_VOICE_REJECT_MAX_LAG_MS = 420
DEFAULT_SELF_VOICE_REJECT_MIN_SIMILARITY = 0.82
DEFAULT_SELF_VOICE_REJECT_MIN_PLAYBACK_RMS = 220
DEFAULT_SELF_VOICE_REJECT_MIN_MIC_RMS = 120
DEFAULT_SELF_VOICE_REJECT_MAX_GAIN = 1.35
DEFAULT_SELF_VOICE_REJECT_RESIDUAL_RATIO = 0.45
DEFAULT_KILL_OPENERS = (
    "bye",
    "by",
    "bye bye",
    "by by",
    "buy buy",
    "see you",
    "see ya",
    "say a",
    # "See you, Housemate" as STT has written it: "Say you", "So your".
    "say you",
    "say ya",
    "so your",
    "catch you later",
    # How STT writes "see you" said quickly: "CU Housemate", "C.U Housemate", "Cya Housemate".
    "cu",
    "c u",
    "cya",
    "c ya",
    "seeya",
    "see u",
    "goodbye",
    "good bye",
    "later",
    "laters",
    "catch ya later",
)
# Fish S2 inline delivery tags such as "[sighing]" or "[long-break]". The assistant's
# open chat sends them in fish_text; only Fish may perform them.
FISH_TAG_RE = re.compile(r"\[[a-z][a-z -]{1,40}\]", re.IGNORECASE)


def strip_fish_tags(text: str) -> str:
    """The words alone, for a voice that would read tags out loud."""
    words = " ".join(FISH_TAG_RE.sub(" ", str(text or "")).split())
    return re.sub(r"\s+([.,;:!?])", r"\1", words)
SHORT_POST_WAKE_GOODBYE_MAX_SECONDS = 0.8


def personality_tail_poll_timeout_for_text(text: str) -> float:
    words = re.findall(r"[A-Za-z0-9']+", str(text or ""))
    estimated_audio_seconds = 1.2 + (0.45 * len(words))
    return min(
        PERSONALITY_TAIL_MAX_POLL_TIMEOUT_SECONDS,
        max(PERSONALITY_TAIL_MIN_POLL_TIMEOUT_SECONDS, estimated_audio_seconds),
    )


class FishStartupTimeoutError(TimeoutError):
    pass


class TTSPlaybackError(RuntimeError):
    def __init__(self, message: str, partial_audio: bool = False, startup_timeout: bool = False):
        super().__init__(message)
        self.partial_audio = bool(partial_audio)
        self.startup_timeout = bool(startup_timeout)


class BrowserVoiceClientDisconnected(ConnectionError):
    pass


def is_browser_voice_client_disconnected(error: BaseException | None) -> bool:
    seen = set()
    current = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (
            BrowserVoiceClientDisconnected,
            BrokenPipeError,
            ConnectionResetError,
            ConnectionAbortedError,
        )):
            return True
        current = current.__cause__ or current.__context__
    return False


def split_fish_text_chunks(spoken: str, min_chars: int = 40, max_chars: int = 120) -> list[str]:
    normalized = " ".join(str(spoken or "").split()).strip()
    if not normalized:
        return []
    minimum = max(1, int(min_chars))
    maximum = max(minimum, int(max_chars))
    pieces = re.findall(r"[^,.;:!?]+[,.!?;:]?", normalized) or [normalized]
    grouped: list[str] = []
    pending = ""
    for raw_piece in pieces:
        piece = " ".join(str(raw_piece or "").split()).strip()
        if not piece:
            continue
        candidate = f"{pending} {piece}".strip() if pending else piece
        if pending and len(candidate) > maximum:
            grouped.append(pending)
            pending = piece
        else:
            pending = candidate
        if len(pending) >= minimum and re.search(r"[,.;:!?]$", piece):
            grouped.append(pending)
            pending = ""
    if pending:
        grouped.append(pending)

    bounded: list[str] = []
    for group in grouped:
        remaining = group
        while len(remaining) > maximum:
            split_at = remaining.rfind(" ", 0, maximum + 1)
            if split_at < minimum:
                split_at = maximum
            bounded.append(remaining[:split_at].strip())
            remaining = remaining[split_at:].strip()
        if remaining:
            bounded.append(remaining)
    return bounded


def build_fish_text_stream(spoken: str):
    if FlushEvent is None:
        raise RuntimeError("Fish Audio WebSocket streaming is unavailable")
    for chunk in split_fish_text_chunks(spoken):
        yield f"{chunk} "
        # Fish only guarantees immediate synthesis of buffered WebSocket text
        # after a flush. Flush every bounded phrase so long replies can start
        # playing before the complete response has been generated.
        yield FlushEvent()


def build_progressive_fish_text_stream(
    text_queue: "queue.Queue[object]",
    end_marker: object,
    abort_marker: object | None = None,
):
    if FlushEvent is None:
        raise RuntimeError("Fish Audio WebSocket streaming is unavailable")
    pending = None
    stream_ended = False
    while True:
        item = pending if pending is not None else text_queue.get()
        pending = None
        if abort_marker is not None and item is abort_marker:
            return
        if item is end_marker:
            return
        item_data = item if isinstance(item, dict) else {"text": item}
        spoken = " ".join(str(item_data.get("text") or "").split()).strip()
        if not spoken:
            continue
        grouped = [spoken]
        grouped_words = len(re.findall(r"\S+", spoken))
        flush_immediately = bool(item_data.get("flush_immediately", False))
        if not flush_immediately:
            deadline = time.monotonic() + PROGRESSIVE_TEXT_COALESCE_SECONDS
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    break
                try:
                    next_item = text_queue.get(timeout=remaining)
                except queue.Empty:
                    break
                if abort_marker is not None and next_item is abort_marker:
                    return
                if next_item is end_marker:
                    stream_ended = True
                    break
                next_data = next_item if isinstance(next_item, dict) else {"text": next_item}
                next_text = " ".join(str(next_data.get("text") or "").split()).strip()
                if not next_text:
                    continue
                next_words = len(re.findall(r"\S+", next_text))
                if (
                    bool(next_data.get("flush_immediately", False))
                    or grouped_words + next_words > PROGRESSIVE_TEXT_COALESCE_MAX_WORDS
                ):
                    pending = next_item
                    break
                grouped.append(next_text)
                grouped_words += next_words
        yield f"{' '.join(grouped)} "
        yield FlushEvent()
        if stream_ended:
            return


FISH_COMMA_BREAK_RE = re.compile(r",\s+(?!\[break\])")


def fish_comma_breaks(text: str) -> str:
    """A short [break] after each comma between words, which Fish otherwise reads straight through.
    "1,200" has no space after its comma and is left alone, as is a comma the model already followed
    with a [break]."""
    return FISH_COMMA_BREAK_RE.sub(", [break] ", str(text or ""))


def build_fish_stream_config(
    *,
    sample_rate: int,
    latency: str,
    chunk_length: int,
    speed: float,
    volume_db: float,
    top_p: float,
    temperature: float,
    repetition_penalty: float,
    condition_on_previous_chunks: bool,
):
    return TTSConfig(
        format="pcm",
        sample_rate=max(8000, int(sample_rate or FISH_AUDIO_SAMPLE_RATE)),
        latency=str(latency or "balanced").strip() or "balanced",
        chunk_length=max(100, min(300, int(chunk_length or 180))),
        prosody=Prosody(
            speed=max(0.5, min(2.0, float(speed or 1.0))),
            volume=max(-20.0, min(20.0, float(volume_db or 0.0))),
        ),
        top_p=max(0.0, min(1.0, float(top_p))),
        temperature=max(0.0, min(1.0, float(temperature))),
        repetition_penalty=max(0.1, float(repetition_penalty)),
        condition_on_previous_chunks=bool(condition_on_previous_chunks),
    )


def fish_stream_worker(connection, api_key: str) -> None:
    try:
        # Fish workers must not inherit the main voice-loop SIGTERM/SIGINT handler.
        # They remain alive across requests so Python/forkserver module startup is
        # paid once at service start, not inside every first-audio deadline.
        with contextlib.suppress(Exception):
            signal.signal(signal.SIGINT, signal.SIG_DFL)
        with contextlib.suppress(Exception):
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
        if FishAudio is None or TTSConfig is None or Prosody is None:
            raise RuntimeError("Fish Audio SDK is unavailable")
        client = FishAudio(api_key=str(api_key or "").strip())
        connection.send(("worker_ready", None))
        while True:
            command, payload = connection.recv()
            if command == "stop":
                break
            if command not in {"stream", "live_start"} or not isinstance(payload, dict):
                continue
            request = payload
            try:
                config = build_fish_stream_config(
                    sample_rate=int(request.get("sample_rate") or FISH_AUDIO_SAMPLE_RATE),
                    latency=str(request.get("latency") or "balanced"),
                    chunk_length=int(request.get("chunk_length") or 180),
                    speed=float(request.get("speed") or 1.0),
                    volume_db=float(request.get("volume_db") or 0.0),
                    top_p=float(request.get("top_p") or 0.88),
                    temperature=float(request.get("temperature") or 0.82),
                    repetition_penalty=float(request.get("repetition_penalty") or 1.15),
                    condition_on_previous_chunks=bool(request.get("condition_on_previous_chunks", True)),
                )
                text_stream = build_fish_text_stream(str(request.get("spoken") or ""))
                command_thread = None
                stop_after_live = False
                if command == "live_start":
                    stream_id = str(request.get("stream_id") or "").strip()
                    text_queue: "queue.Queue[object]" = queue.Queue(maxsize=16)
                    end_marker = object()
                    abort_marker = object()

                    def receive_live_commands() -> None:
                        nonlocal stop_after_live
                        while True:
                            live_command, live_payload = connection.recv()
                            live_data = live_payload if isinstance(live_payload, dict) else {}
                            if str(live_data.get("stream_id") or "").strip() != stream_id:
                                continue
                            if live_command == "live_text":
                                text = " ".join(str(live_data.get("text") or "").split()).strip()
                                if text:
                                    text_queue.put({
                                        "text": text,
                                        "flush_immediately": bool(live_data.get("flush_immediately", False)),
                                    })
                                continue
                            if live_command in {"live_end", "live_abort", "stop"}:
                                stop_after_live = live_command == "stop"
                                text_queue.put(
                                    end_marker if live_command == "live_end" else abort_marker
                                )
                                return

                    command_thread = threading.Thread(
                        target=receive_live_commands,
                        name=f"fish-live-input-{stream_id[:8]}",
                        daemon=True,
                    )
                    command_thread.start()
                    text_stream = build_progressive_fish_text_stream(
                        text_queue,
                        end_marker,
                        abort_marker,
                    )
                    connection.send(("live_ready", {"stream_id": stream_id}))

                for chunk in client.tts.stream_websocket(
                    text_stream,
                    reference_id=str(request.get("voice_id") or "").strip(),
                    format="pcm",
                    latency=str(request.get("latency") or "balanced"),
                    config=config,
                    model=str(request.get("model") or "s2-pro"),
                ):
                    if not chunk:
                        continue
                    connection.send(("chunk", bytes(chunk)))
                connection.send(("done", None))
                if command_thread is not None:
                    command_thread.join(timeout=1.0)
                if stop_after_live:
                    break
            except Exception as err:
                with contextlib.suppress(Exception):
                    connection.send(("error", str(err)))
                if command == "live_start":
                    return
    except Exception as err:
        with contextlib.suppress(Exception):
            connection.send(("worker_error", str(err)))
    finally:
        with contextlib.suppress(Exception):
            connection.close()


@dataclasses.dataclass
class PreparedSpeech:
    path: str
    backend: str
    utterance: str
    phase: str
    sample_rate: int = SAMPLE_RATE
    raw_pcm: bool = False


@dataclasses.dataclass
class ProgressivePlaybackResult:
    stream_id: str
    utterance: str
    segment_count: int
    first_audio_ms: int | None
    question_to_first_audio_ms: int | None
    total_ms: int
    total_bytes: int
    played_ms: int
    underruns: int
    partial_audio: bool


@dataclasses.dataclass
class PlaybackMirrorSegment:
    started_at: float = 0.0
    phase: str = ""
    frames: list[bytes] = dataclasses.field(default_factory=list)
    ended_at: float | None = None

    def append_frames(self, frames: list[bytes]) -> None:
        if frames:
            if not self.frames and self.started_at <= 0.0:
                self.started_at = time.monotonic()
            self.frames.extend(frames)


def normalize_pcm_for_matching(
    audio_bytes: bytes,
    sample_rate: int,
    channels: int = 1,
    sample_width: int = SAMPLE_WIDTH,
    rate_state=None,
) -> tuple[bytes, object]:
    payload = bytes(audio_bytes or b"")
    if not payload:
        return b"", rate_state
    samples = pcm_bytes_to_samples(payload, sample_width=max(1, int(sample_width or SAMPLE_WIDTH)))
    mono_samples = mix_samples_to_mono(samples, channels=max(1, int(channels or 1)))
    normalized_samples, rate_state = resample_pcm_samples(
        mono_samples,
        source_rate=max(1, int(sample_rate or SAMPLE_RATE)),
        target_rate=SAMPLE_RATE,
        state=rate_state,
    )
    return pcm_samples_to_bytes(normalized_samples), rate_state


def split_audio_frames(audio_bytes: bytes, carry: bytes = b"") -> tuple[list[bytes], bytes]:
    payload = bytes(carry or b"") + bytes(audio_bytes or b"")
    if not payload:
        return [], b""
    frame_count = len(payload) // FRAME_BYTES
    if frame_count <= 0:
        return [], payload
    frames = [payload[index * FRAME_BYTES:(index + 1) * FRAME_BYTES] for index in range(frame_count)]
    return frames, payload[frame_count * FRAME_BYTES:]


def pcm_frame_similarity(left: bytes, right: bytes) -> float:
    if len(left) != FRAME_BYTES or len(right) != FRAME_BYTES:
        return 0.0
    left_view = memoryview(left).cast("h")
    right_view = memoryview(right).cast("h")
    dot = 0.0
    left_energy = 0.0
    right_energy = 0.0
    for left_sample, right_sample in zip(left_view, right_view):
        left_value = float(left_sample)
        right_value = float(right_sample)
        dot += left_value * right_value
        left_energy += left_value * left_value
        right_energy += right_value * right_value
    if left_energy <= 0.0 or right_energy <= 0.0:
        return 0.0
    return dot / math.sqrt(left_energy * right_energy)


def pcm_frame_dot(left: bytes, right: bytes) -> tuple[float, float]:
    if len(left) != FRAME_BYTES or len(right) != FRAME_BYTES:
        return 0.0, 0.0
    dot = 0.0
    right_energy = 0.0
    for left_sample, right_sample in zip(memoryview(left).cast("h"), memoryview(right).cast("h")):
        left_value = float(left_sample)
        right_value = float(right_sample)
        dot += left_value * right_value
        right_energy += right_value * right_value
    return dot, right_energy


def pcm_bytes_to_samples(audio_bytes: bytes, sample_width: int = SAMPLE_WIDTH) -> list[int]:
    payload = bytes(audio_bytes or b"")
    if not payload:
        return []
    width = max(1, int(sample_width or SAMPLE_WIDTH))
    if width == 2:
        return list(memoryview(payload).cast("h"))
    if width == 1:
        return [(byte - 128) << 8 for byte in payload]
    raise ValueError(f"unsupported PCM sample width for matcher: {width}")


def pcm_samples_to_bytes(samples: list[int]) -> bytes:
    if not samples:
        return b""
    packed = array.array("h", (max(-32768, min(32767, int(sample))) for sample in samples))
    return packed.tobytes()


def mix_samples_to_mono(samples: list[int], channels: int = 1) -> list[int]:
    channel_count = max(1, int(channels or 1))
    if channel_count <= 1:
        return list(samples)
    mono = []
    usable = len(samples) - (len(samples) % channel_count)
    for index in range(0, usable, channel_count):
        chunk = samples[index:index + channel_count]
        mono.append(int(round(sum(chunk) / float(channel_count))))
    return mono


def resample_pcm_samples(
    samples: list[int],
    source_rate: int,
    target_rate: int,
    state=None,
) -> tuple[list[int], object]:
    source = max(1, int(source_rate or SAMPLE_RATE))
    target = max(1, int(target_rate or SAMPLE_RATE))
    if source == target:
        return list(samples), None
    tail_samples, position = state if isinstance(state, tuple) and len(state) == 2 else ([], 0.0)
    working = list(tail_samples or []) + list(samples)
    if not working:
        return [], (tail_samples, float(position or 0.0))
    step = float(source) / float(target)
    cursor = float(position or 0.0)
    emitted: list[int] = []
    length = len(working)
    while int(cursor) < length:
        emitted.append(int(working[int(cursor)]))
        cursor += step
    consumed = min(length, int(cursor))
    next_tail = working[consumed:]
    next_position = cursor - consumed
    return emitted, (next_tail, next_position)


def pcm_frame_rms(frame: bytes) -> int:
    samples = memoryview(frame).cast("h") if frame else ()
    if not samples:
        return 0
    total = 0.0
    count = 0
    for sample in samples:
        total += float(sample) * float(sample)
        count += 1
    if count <= 0:
        return 0
    return int(round(math.sqrt(total / count)))


class LivePlaybackMirror:
    def __init__(
        self,
        *,
        enabled: bool,
        max_lag_ms: int = DEFAULT_SELF_VOICE_REJECT_MAX_LAG_MS,
        min_similarity: float = DEFAULT_SELF_VOICE_REJECT_MIN_SIMILARITY,
        min_playback_rms: int = DEFAULT_SELF_VOICE_REJECT_MIN_PLAYBACK_RMS,
        min_mic_rms: int = DEFAULT_SELF_VOICE_REJECT_MIN_MIC_RMS,
        max_gain: float = DEFAULT_SELF_VOICE_REJECT_MAX_GAIN,
        residual_ratio: float = DEFAULT_SELF_VOICE_REJECT_RESIDUAL_RATIO,
    ):
        self._enabled = bool(enabled)
        self._max_lag_frames = max(0, int(round(max(0.0, float(max_lag_ms)) / FRAME_MS)))
        self._min_similarity = max(-1.0, min(1.0, float(min_similarity)))
        self._min_playback_rms = max(0, int(min_playback_rms))
        self._min_mic_rms = max(0, int(min_mic_rms))
        self._max_gain = max(0.1, float(max_gain))
        self._residual_ratio = max(0.0, min(1.0, float(residual_ratio)))
        self._search_frames = max(self._max_lag_frames + 24, self._max_lag_frames * 2, 45)
        self._lock = threading.Lock()
        self._segments = collections.deque()
        self._recent_frames = collections.deque(maxlen=self._search_frames)
        self._matched_frames = 0
        self._subtracted_frames = 0
        self._rejected_frames = 0

    def enabled(self) -> bool:
        return self._enabled

    def begin_stream(self, sample_rate: int, channels: int = 1, sample_width: int = SAMPLE_WIDTH, phase: str = ""):
        if not self._enabled:
            return NullPlaybackMirrorStream()
        segment = PlaybackMirrorSegment(started_at=time.monotonic(), phase=str(phase or "").strip())
        with self._lock:
            self._segments.append(segment)
        return PlaybackMirrorStream(self, segment, sample_rate=sample_rate, channels=channels, sample_width=sample_width)

    def mirror_prepared(self, prepared: PreparedSpeech) -> None:
        if not self._enabled:
            return
        payload = b""
        channels = 1
        sample_width = SAMPLE_WIDTH
        sample_rate = prepared.sample_rate
        if prepared.raw_pcm:
            with open(prepared.path, "rb") as handle:
                payload = handle.read()
        else:
            with wave.open(prepared.path, "rb") as wav_handle:
                channels = wav_handle.getnchannels()
                sample_width = wav_handle.getsampwidth()
                sample_rate = wav_handle.getframerate()
                payload = wav_handle.readframes(wav_handle.getnframes())
        stream = self.begin_stream(sample_rate=sample_rate, channels=channels, sample_width=sample_width, phase=prepared.phase)
        stream.append(payload)
        stream.finish()

    def process_frame(self, frame: bytes) -> bytes:
        if not self._enabled or len(frame) != FRAME_BYTES:
            return frame
        mic_rms = pcm_frame_rms(frame)
        if mic_rms < self._min_mic_rms:
            return frame
        with self._lock:
            self._prune_segments(time.monotonic())
            candidate, similarity = self._find_best_candidate(frame)
            if candidate is None or similarity < self._min_similarity:
                return frame
            self._matched_frames += 1
            residual = self._subtract_candidate(frame, candidate)
            residual_rms = pcm_frame_rms(residual)
            if residual_rms < mic_rms:
                self._subtracted_frames += 1
            if residual_rms <= max(self._min_mic_rms // 2, int(round(mic_rms * self._residual_ratio))):
                self._rejected_frames += 1
                return SILENCE_FRAME
            return residual

    def should_reject(self, frame: bytes) -> bool:
        return self.process_frame(frame) == SILENCE_FRAME

    def matched_frames(self) -> int:
        with self._lock:
            return self._matched_frames

    def subtracted_frames(self) -> int:
        with self._lock:
            return self._subtracted_frames

    def rejected_frames(self) -> int:
        with self._lock:
            return self._rejected_frames

    def snapshot_audio(self) -> bytes:
        with self._lock:
            chunks = []
            for segment in self._segments:
                if segment.frames:
                    chunks.extend(segment.frames)
            return b"".join(chunks)

    def _find_best_candidate(self, frame: bytes) -> tuple[bytes | None, float]:
        best_candidate = None
        best_similarity = -1.0
        for candidate in reversed(self._recent_frames):
            if pcm_frame_rms(candidate) < self._min_playback_rms:
                continue
            similarity = pcm_frame_similarity(frame, candidate)
            if similarity > best_similarity:
                best_candidate = candidate
                best_similarity = similarity
        return best_candidate, best_similarity

    def _subtract_candidate(self, frame: bytes, candidate: bytes) -> bytes:
        dot, candidate_energy = pcm_frame_dot(frame, candidate)
        if candidate_energy <= 0.0:
            return frame
        gain = max(0.0, min(self._max_gain, dot / candidate_energy))
        mic_samples = memoryview(frame).cast("h")
        playback_samples = memoryview(candidate).cast("h")
        residual = [
            int(round(float(mic_sample) - (float(playback_sample) * gain)))
            for mic_sample, playback_sample in zip(mic_samples, playback_samples)
        ]
        return pcm_samples_to_bytes(residual)

    def _prune_segments(self, now: float) -> None:
        while self._segments:
            segment = self._segments[0]
            if segment.ended_at is None:
                break
            segment_duration = len(segment.frames) * (FRAME_MS / 1000.0)
            expires_at = float(segment.started_at) + segment_duration + (self._max_lag_frames * FRAME_MS / 1000.0) + 0.2
            if expires_at >= now:
                break
            self._segments.popleft()


class PlaybackMirrorStream:
    def __init__(self, mirror: LivePlaybackMirror, segment: PlaybackMirrorSegment, *, sample_rate: int, channels: int, sample_width: int):
        self._mirror = mirror
        self._segment = segment
        self._sample_rate = sample_rate
        self._channels = channels
        self._sample_width = sample_width
        self._rate_state = None
        self._carry = b""

    def append(self, audio_bytes: bytes) -> None:
        normalized, self._rate_state = normalize_pcm_for_matching(
            audio_bytes,
            sample_rate=self._sample_rate,
            channels=self._channels,
            sample_width=self._sample_width,
            rate_state=self._rate_state,
        )
        frames, self._carry = split_audio_frames(normalized, carry=self._carry)
        if not frames:
            return
        with self._mirror._lock:
            self._segment.append_frames(frames)
            for frame in frames:
                self._mirror._recent_frames.append(frame)

    def finish(self) -> None:
        if self._carry:
            padded = self._carry.ljust(FRAME_BYTES, b"\x00")
            with self._mirror._lock:
                self._segment.append_frames([padded])
                self._mirror._recent_frames.append(padded)
            self._carry = b""
        with self._mirror._lock:
            self._segment.ended_at = time.monotonic()


class NullPlaybackMirrorStream:
    def append(self, _audio_bytes: bytes) -> None:
        return

    def finish(self) -> None:
        return


def normalize_fish_tone_tags(raw: object = None) -> dict[str, str]:
    """Default tone->tag map with config overrides. An empty string silences a
    tone; neutral and unknown tones never get a tag, and no tag may be angry."""
    tags = dict(DEFAULT_FISH_TONE_TAGS)
    if isinstance(raw, dict):
        for key, value in raw.items():
            tone = str(key or "").strip().lower()
            if tone not in SPEECH_TONES or tone == "neutral":
                continue
            tag = " ".join(str(value or "").split()).strip()
            if not tag:
                tags.pop(tone, None)
            elif FISH_TAG_RE.fullmatch(tag) and "angry" not in tag.lower():
                tags[tone] = tag
    return tags


def apply_fish_tone(text: str, tone: object, tags: dict[str, str], kind: str = "", phase: str = "") -> tuple[str, str]:
    """Prefix at most one delivery tag chosen by the assistant's code-picked tone.
    Bridge lines, thinking phrases and text that already carries a tag stay as they are."""
    spoken = str(text or "").strip()
    normalized_tone = str(tone or "").strip().lower()
    if (
        not spoken
        or str(kind or "").strip() == "bridge"
        or str(phase or "").strip() == "thinking"
        or FISH_TAG_RE.search(spoken)
    ):
        return spoken, ""
    tag = tags.get(normalized_tone, "")
    if not tag:
        return spoken, ""
    return f"{tag} {spoken}", tag


def parse_clock_minutes(value: object, default: str) -> int:
    for candidate in (value, default):
        match = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*", str(candidate or ""))
        if match and int(match.group(1)) < 24 and int(match.group(2)) < 60:
            return int(match.group(1)) * 60 + int(match.group(2))
    return 0


def night_quiet_active(now: datetime, start_minutes: int, end_minutes: int) -> bool:
    minute = now.hour * 60 + now.minute
    if start_minutes == end_minutes:
        return False
    if start_minutes < end_minutes:
        return start_minutes <= minute < end_minutes
    return minute >= start_minutes or minute < end_minutes


def night_or_day_moment(now: datetime, night: bool, start_minutes: int, end_minutes: int) -> datetime:
    """A moment today that is inside (night) or outside the night window."""
    base = now.replace(hour=0, minute=0, second=0, microsecond=0)
    for step in range(48):
        moment = base + timedelta(minutes=30 * step)
        if night_quiet_active(moment, start_minutes, end_minutes) == night:
            return moment
    return now


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[voice] {stamp} {message}", flush=True)


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def estimate_tts_duration_ms(text: str) -> int:
    spoken = " ".join(str(text or "").split()).strip()
    if not spoken:
        return 0
    words = max(1, len(re.findall(r"[A-Za-z0-9']+", spoken)))
    chars = len(spoken)
    return max(900, int(round((words * 360) + (chars * 24) + 420)))


def month_stamp(ts: float | None = None) -> str:
    when = time.gmtime(ts if ts is not None else time.time())
    return time.strftime("%Y-%m", when)


def classify_jarvis_transport_error(err: Exception) -> str:
    if isinstance(err, TimeoutError):
        return "brain_path_down"
    if isinstance(err, urllib.error.HTTPError):
        if int(getattr(err, "code", 0) or 0) >= 500:
            return "brain_path_down"
        return "jarvis_http_error"
    if isinstance(err, urllib.error.URLError):
        reason = getattr(err, "reason", None)
        if isinstance(reason, TimeoutError):
            return "brain_path_down"
        if isinstance(reason, socket.timeout):
            return "brain_path_down"
        if isinstance(reason, ConnectionRefusedError):
            return "brain_path_down"
        if isinstance(reason, OSError):
            return "brain_path_down"
        if "timed out" in str(reason or "").lower():
            return "brain_path_down"
        return "jarvis_http_error"
    if isinstance(err, socket.timeout):
        return "brain_path_down"
    if isinstance(err, ConnectionRefusedError):
        return "brain_path_down"
    if isinstance(err, OSError):
        return "brain_path_down"
    if "timed out" in str(err or "").lower():
        return "brain_path_down"
    return "jarvis_http_error"


def normalize_string_list(value) -> list[str]:
    if isinstance(value, list):
        raw_items = value
    elif isinstance(value, str):
        raw_items = value.split(",")
    else:
        raw_items = []
    return [str(item).strip() for item in raw_items if str(item).strip()]


def normalize_browser_voice_trusted_clients(value) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    canonical_speakers = {speaker.lower(): speaker for speaker in known_wake_speakers()}
    normalized: dict[str, str] = {}
    for raw_client_id, raw_speaker in value.items():
        client_id = " ".join(str(raw_client_id or "").split()).strip()[:128]
        speaker = canonical_speakers.get(" ".join(str(raw_speaker or "").split()).strip().lower())
        if client_id and speaker:
            normalized[client_id] = speaker
    return normalized


@dataclasses.dataclass
class JarvisFailureMetadata:
    code: str = ""
    summary: str = ""
    provider: str = ""
    retryable: bool = True


@dataclasses.dataclass
class JarvisReply:
    text: str = ""
    model_used: bool = False
    usage: dict | None = None
    failure: JarvisFailureMetadata | None = None
    speech: dict | None = None
    voice_response: dict | None = None
    tail: dict | None = None
    progressive_spoken: bool = False
    progressive_tail_spoken: bool = False
    progressive_played_ms: int = 0
    progressive_segment_count: int = 0


class ProgressiveStreamUnavailable(RuntimeError):
    pass


class ProgressiveTurnError(RuntimeError):
    def __init__(self, message: str, fallback_allowed: bool):
        super().__init__(message)
        self.fallback_allowed = bool(fallback_allowed)


def progressive_error_allows_legacy(error: Exception) -> bool:
    if isinstance(error, ProgressiveTurnError):
        return error.fallback_allowed
    if isinstance(error, TTSPlaybackError):
        return not error.partial_audio
    return isinstance(error, ProgressiveStreamUnavailable)


@dataclasses.dataclass
class JarvisTail:
    status: str = ""
    text: str = ""
    speech: dict | None = None
    reason: str = ""
    latency_ms: int | None = None


@dataclasses.dataclass
class PreparedJarvisTail:
    tail: JarvisTail
    prepared: "PreparedSpeech | None" = None


@dataclasses.dataclass
class BrowserVoiceSession:
    session_id: str
    last_seen_at: float
    wake_requested_at: float = 0.0
    wake_prompt_future: object | None = None
    wake_speaker_future: object | None = None
    wake_prompt_delivered: bool = False
    speaker_name: str = ""
    speaker_confidence: float = 0.0
    ears_test: dict | None = None
    # Voiceprints of the session speaker's turns so far (endpoint sessions): their mean is that voice
    # heard for longer than any one short turn.
    voiceprints: list = dataclasses.field(default_factory=list)


class VoiceEventLogger:
    def __init__(self, log_dir: str):
        self._log_dir = str(log_dir or "").strip() or DEFAULT_VOICE_EVENT_LOG_DIR

    def log_event(self, event_type: str, **fields) -> None:
        event_name = str(event_type or "").strip()
        if not event_name:
            return
        try:
            os.makedirs(self._log_dir, exist_ok=True)
            payload = {
                "timestamp": utc_timestamp(),
                "event": event_name,
            }
            for key, value in fields.items():
                normalized_key = str(key or "").strip()
                if not normalized_key or value is None:
                    continue
                payload[normalized_key] = value
            line = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
            with open(self._event_path(), "a", encoding="utf-8") as handle:
                handle.write(f"{line}\n")
        except Exception:
            return

    def _event_path(self) -> str:
        return os.path.join(self._log_dir, f"voice-events-{month_stamp()}.jsonl")


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if is_browser_voice_client_disconnected(error):
            return
        super().handle_error(request, client_address)


class HomeAssistantStatePublisher:
    def __init__(
        self,
        enabled: bool,
        base_url: str,
        token: str,
        client_id: str = "",
        timeout_seconds: float = 3.0,
        interval_seconds: float = 1.0,
        cache_path: str = "",
    ):
        self._enabled = bool(enabled)
        self._base_url = str(base_url or "").strip().rstrip("/")
        self._token = str(token or "").strip()
        self._client_id = str(client_id or "").strip()
        self._timeout_seconds = max(0.2, float(timeout_seconds or 3.0))
        self._interval_seconds = max(0.2, float(interval_seconds or 1.0))
        self._cache_path = str(cache_path or "").strip() or DEFAULT_HA_STATE_PUBLISH_CACHE_PATH
        self._lock = threading.Lock()
        self._wake_event = threading.Event()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._voice_state = "idle"
        self._last_speaker = self._load_cached_last_speaker()
        self._tts_playing = False
        self._tts_text = ""
        self._tts_phase = ""
        self._tts_started_at = ""
        self._tts_speaker = ""
        self._tts_duration_ms = 0
        self._endpoint_tts_playing = False
        self._endpoint_tts_text = ""
        self._endpoint_tts_phase = ""
        self._endpoint_tts_started_at = ""
        self._endpoint_tts_speaker = ""
        self._endpoint_tts_client_id = ""
        self._endpoint_tts_playback_id = ""
        self._dirty = True
        self._last_publish_at = 0.0
        self._access_token = ""
        self._access_token_expires_at = 0.0

    def start(self) -> None:
        if not self._enabled or self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="housemate-ha-state", daemon=True)
        self._thread.start()
        self._wake_event.set()

    def stop(self) -> None:
        if not self._enabled:
            return
        self.clear_tts_phrase()
        self.clear_endpoint_tts_phrase()
        self.set_voice_state("idle")
        self._publish_snapshot(force=True)
        self._stop_event.set()
        self._wake_event.set()
        thread = self._thread
        self._thread = None
        if thread and thread.is_alive():
            thread.join(timeout=max(1.0, self._timeout_seconds + 0.5))

    def set_voice_state(self, state: object) -> None:
        if not self._enabled:
            return
        normalized = normalize_voice_state(state)
        with self._lock:
            if normalized == self._voice_state and not self._dirty:
                return
            self._voice_state = normalized
            self._dirty = True
        self._wake_event.set()

    def set_last_speaker(self, speaker: object) -> None:
        if not self._enabled:
            return
        normalized = normalize_household_speaker_slug(speaker)
        with self._lock:
            if normalized == self._last_speaker and not self._dirty:
                return
            self._last_speaker = normalized
            self._dirty = True
        self._save_cached_last_speaker(normalized)
        self._wake_event.set()

    def snapshot(self) -> tuple[str, str]:
        with self._lock:
            return self._voice_state, self._last_speaker

    def set_tts_phrase(self, text: object, phase: object = "", speaker: object = "", duration_ms: object = 0) -> None:
        if not self._enabled:
            return
        normalized_text = " ".join(str(text or "").split()).strip()
        normalized_phase = " ".join(str(phase or "").split()).strip()
        normalized_speaker = normalize_household_speaker_slug(speaker)
        normalized_duration_ms = max(0, int(duration_ms or 0))
        started_at = utc_timestamp() if normalized_text else ""
        with self._lock:
            if (
                normalized_text == self._tts_text
                and normalized_phase == self._tts_phase
                and normalized_speaker == self._tts_speaker
                and normalized_duration_ms == self._tts_duration_ms
                and not self._dirty
            ):
                return
            self._tts_text = normalized_text
            self._tts_phase = normalized_phase
            self._tts_speaker = normalized_speaker
            self._tts_started_at = started_at
            self._tts_duration_ms = normalized_duration_ms
            self._tts_playing = bool(normalized_text)
            self._dirty = True
        self._wake_event.set()

    def clear_tts_phrase(self) -> None:
        if not self._enabled:
            return
        with self._lock:
            if not self._tts_text and not self._tts_started_at and not self._dirty:
                return
            self._tts_text = ""
            self._tts_phase = ""
            self._tts_started_at = ""
            self._tts_speaker = ""
            self._tts_duration_ms = 0
            self._tts_playing = False
            self._dirty = True
        self._wake_event.set()

    def set_endpoint_tts_phrase(
        self,
        text: object,
        phase: object = "",
        speaker: object = "",
        client_id: object = "",
        playback_id: object = "",
    ) -> None:
        if not self._enabled:
            return
        normalized_text = " ".join(str(text or "").split()).strip()
        normalized_phase = " ".join(str(phase or "").split()).strip()
        normalized_speaker = normalize_household_speaker_slug(speaker)
        normalized_client_id = " ".join(str(client_id or "").split()).strip()[:128]
        normalized_playback_id = " ".join(str(playback_id or "").split()).strip()[:128]
        with self._lock:
            self._endpoint_tts_playing = True
            self._endpoint_tts_text = normalized_text
            self._endpoint_tts_phase = normalized_phase
            self._endpoint_tts_started_at = utc_timestamp()
            self._endpoint_tts_speaker = normalized_speaker
            self._endpoint_tts_client_id = normalized_client_id
            self._endpoint_tts_playback_id = normalized_playback_id
            self._dirty = True
        self._wake_event.set()

    def clear_endpoint_tts_phrase(self, playback_id: object = "") -> bool:
        if not self._enabled:
            return False
        normalized_playback_id = " ".join(str(playback_id or "").split()).strip()[:128]
        with self._lock:
            if (
                normalized_playback_id
                and self._endpoint_tts_playback_id
                and normalized_playback_id != self._endpoint_tts_playback_id
            ):
                return False
            self._endpoint_tts_playing = False
            self._endpoint_tts_text = ""
            self._endpoint_tts_phase = ""
            self._endpoint_tts_started_at = ""
            self._endpoint_tts_speaker = ""
            self._endpoint_tts_client_id = ""
            self._endpoint_tts_playback_id = ""
            self._dirty = True
        self._wake_event.set()
        return True

    def _run(self) -> None:
        while not self._stop_event.is_set():
            self._publish_snapshot()
            self._wake_event.wait(timeout=self._interval_seconds)
            self._wake_event.clear()
        self._publish_snapshot(force=True)

    def _publish_snapshot(self, force: bool = False) -> None:
        if not self._enabled:
            return
        now = time.monotonic()
        with self._lock:
            voice_state = self._voice_state
            last_speaker = self._last_speaker
            tts_text = self._tts_text
            tts_phase = self._tts_phase
            tts_started_at = self._tts_started_at
            tts_speaker = self._tts_speaker
            tts_duration_ms = self._tts_duration_ms
            tts_playing = self._tts_playing
            endpoint_tts_playing = self._endpoint_tts_playing
            endpoint_tts_text = self._endpoint_tts_text
            endpoint_tts_phase = self._endpoint_tts_phase
            endpoint_tts_started_at = self._endpoint_tts_started_at
            endpoint_tts_speaker = self._endpoint_tts_speaker
            endpoint_tts_client_id = self._endpoint_tts_client_id
            endpoint_tts_playback_id = self._endpoint_tts_playback_id
            dirty = self._dirty
        if not force and not dirty and (now - self._last_publish_at) < self._interval_seconds:
            return
        voice_ok = self._post_state(
            ha_state_entity("sensor", "voice_state"),
            voice_state,
            {
                "friendly_name": f"{assistant_name()} Voice State",
                "source": "housemate",
                "available_states": list(HA_VOICE_STATES),
            },
        )
        speaker_ok = self._post_state(
            ha_state_entity("sensor", "last_speaker"),
            last_speaker,
            {
                "friendly_name": f"{assistant_name()} Last Speaker",
                "source": "housemate",
                "available_states": [normalize_household_speaker_slug(name) for name in sorted(known_wake_speakers())] + ["unknown"],
            },
        )
        tts_ok = self._post_state(
            ha_state_entity("sensor", "tts_reply"),
            "active" if tts_text else "idle",
            {
                "friendly_name": f"{assistant_name()} TTS Reply",
                "source": "housemate",
                "text": tts_text,
                "phase": tts_phase,
                "started_at": tts_started_at,
                "speaker": tts_speaker or last_speaker,
                "duration_ms": tts_duration_ms,
                "word_count": len(re.findall(r"[A-Za-z0-9']+", tts_text)) if tts_text else 0,
            },
        )
        playback_ok = self._post_state(
            ha_state_entity("binary_sensor", "tts_playing"),
            "on" if tts_playing else "off",
            {
                "friendly_name": f"{assistant_name()} TTS Playing",
                "source": "housemate",
                "text": tts_text,
                "phase": tts_phase,
                "started_at": tts_started_at,
                "speaker": tts_speaker or last_speaker,
                "duration_ms": tts_duration_ms,
                "word_count": len(re.findall(r"[A-Za-z0-9']+", tts_text)) if tts_text else 0,
            },
        )
        endpoint_tts_ok = self._post_state(
            ha_state_entity("sensor", "endpoint_tts_reply"),
            "active" if endpoint_tts_playing else "idle",
            {
                "friendly_name": f"{assistant_name()} Endpoint TTS Reply",
                "source": "housemate",
                "text": endpoint_tts_text,
                "phase": endpoint_tts_phase,
                "started_at": endpoint_tts_started_at,
                "speaker": endpoint_tts_speaker or last_speaker,
                "client_id": endpoint_tts_client_id,
                "playback_id": endpoint_tts_playback_id,
                "word_count": len(re.findall(r"[A-Za-z0-9']+", endpoint_tts_text)) if endpoint_tts_text else 0,
            },
        )
        endpoint_playback_ok = self._post_state(
            ha_state_entity("binary_sensor", "endpoint_tts_playing"),
            "on" if endpoint_tts_playing else "off",
            {
                "friendly_name": f"{assistant_name()} Endpoint TTS Playing",
                "source": "housemate",
                "text": endpoint_tts_text,
                "phase": endpoint_tts_phase,
                "started_at": endpoint_tts_started_at,
                "speaker": endpoint_tts_speaker or last_speaker,
                "client_id": endpoint_tts_client_id,
                "playback_id": endpoint_tts_playback_id,
                "word_count": len(re.findall(r"[A-Za-z0-9']+", endpoint_tts_text)) if endpoint_tts_text else 0,
            },
        )
        if voice_ok and speaker_ok and tts_ok and playback_ok and endpoint_tts_ok and endpoint_playback_ok:
            with self._lock:
                self._dirty = False
            self._last_publish_at = time.monotonic()

    def _post_state(self, entity_id: str, state: str, attributes: dict | None = None) -> bool:
        access_token = self._api_token()
        if not access_token:
            return False
        request = urllib.request.Request(
            self._state_url(entity_id),
            data=json.dumps(
                {
                    "state": str(state or "").strip(),
                    "attributes": attributes or {},
                },
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
                response.read()
            return True
        except Exception:
            return False

    def read_state(self, entity_id: str) -> dict | None:
        """One entity's state from HA, or None (no token, not found, HA slow)."""
        access_token = self._api_token()
        if not access_token:
            return None
        request = urllib.request.Request(
            self._state_url(entity_id),
            headers={"Authorization": f"Bearer {access_token}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=min(2.0, self._timeout_seconds)) as response:
                body = json.loads(response.read().decode("utf-8") or "{}")
        except Exception:
            return None
        return body if isinstance(body, dict) else None

    def api_request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict | None = None,
        timeout: float = 15.0,
    ) -> bytes:
        """One call to HA's REST API under /api (path like "stt/stt.x"); raises on any failure.
        Used whether or not state publishing is on."""
        access_token = self._api_token()
        if not access_token:
            raise RuntimeError("no Home Assistant token")
        parsed = urllib.parse.urlparse(self._state_url("x"))
        api_root = parsed.path.rsplit("/states/", 1)[0]
        url = urllib.parse.urlunparse(
            (parsed.scheme, parsed.netloc, f"{api_root}/{str(path).lstrip('/')}", "", "", "")
        )
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Authorization": f"Bearer {access_token}", **(headers or {})},
            method=method,
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()

    def call_service(self, domain: str, service: str, data: dict) -> bool:
        """One HA service call; True when HA accepted it."""
        access_token = self._api_token()
        if not access_token:
            return False
        parsed = urllib.parse.urlparse(self._state_url("x"))
        api_root = parsed.path.rsplit("/states/", 1)[0]
        url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, f"{api_root}/services/{domain}/{service}", "", "", ""))
        request = urllib.request.Request(
            url,
            data=json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode("utf-8"),
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=min(2.0, self._timeout_seconds)) as response:
                response.read()
            return True
        except Exception:
            return False

    def _api_token(self) -> str:
        if not self._client_id:
            return self._token
        now = time.monotonic()
        if self._access_token and now < self._access_token_expires_at:
            return self._access_token
        return self._refresh_access_token()

    def _refresh_access_token(self) -> str:
        payload = urllib.parse.urlencode(
            {
                "grant_type": "refresh_token",
                "client_id": self._client_id,
                "refresh_token": self._token,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self._token_url(),
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8") or "{}")
        except Exception:
            return ""
        access_token = str(body.get("access_token") or "").strip()
        expires_in = max(60, int(body.get("expires_in") or 0))
        if not access_token:
            return ""
        self._access_token = access_token
        self._access_token_expires_at = time.monotonic() + max(30, expires_in - 60)
        return access_token

    def _state_url(self, entity_id: str) -> str:
        parsed = urllib.parse.urlparse(self._base_url)
        path = parsed.path.rstrip("/")
        api_root = path if path.endswith("/api") else f"{path}/api"
        normalized_path = f"{api_root}/states/{entity_id}"
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, normalized_path, "", "", ""))

    def _token_url(self) -> str:
        parsed = urllib.parse.urlparse(self._base_url)
        path = parsed.path.rstrip("/")
        normalized_path = f"{path}/auth/token" if path else "/auth/token"
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, normalized_path, "", "", ""))

    def _load_cached_last_speaker(self) -> str:
        try:
            with open(self._cache_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except Exception:
            return "unknown"
        return normalize_household_speaker_slug(payload.get("last_speaker"))

    def _save_cached_last_speaker(self, speaker: str) -> None:
        try:
            os.makedirs(os.path.dirname(self._cache_path), exist_ok=True)
            with open(self._cache_path, "w", encoding="utf-8") as handle:
                json.dump({"last_speaker": speaker}, handle, ensure_ascii=True, separators=(",", ":"))
        except Exception:
            return


class RemoteTtsServer:
    def __init__(self, bind_host: str, port: int, token: str, speak_callback, event_logger: VoiceEventLogger | None = None):
        self._bind_host = str(bind_host or "127.0.0.1").strip() or "127.0.0.1"
        self._port = max(0, int(port or 0))
        self._token = str(token or "").strip()
        self._speak_callback = speak_callback
        self._event_logger = event_logger
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        if self._server:
            return int(self._server.server_address[1])
        return self._port

    def start(self) -> None:
        if self._server:
            return

        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                if self.path != "/speak":
                    self._send_json(404, {"error": "not_found"})
                    return
                token = str(self.headers.get("x-jarvis-token") or "").strip()
                if not outer._token or token != outer._token:
                    outer._log_event("remote_tts_rejected", reason="unauthorized")
                    self._send_json(401, {"error": "unauthorized"})
                    return

                try:
                    length = int(self.headers.get("Content-Length") or "0")
                except ValueError:
                    length = 0
                if length <= 0 or length > 32768:
                    outer._log_event("remote_tts_rejected", reason="invalid_length")
                    self._send_json(400, {"error": "invalid_length"})
                    return

                try:
                    raw = self.rfile.read(length)
                    body = json.loads(raw.decode("utf-8"))
                except Exception:
                    outer._log_event("remote_tts_rejected", reason="invalid_json")
                    self._send_json(400, {"error": "invalid_json"})
                    return

                text = " ".join(str(body.get("text") or "").split()).strip()
                if not text:
                    outer._log_event("remote_tts_rejected", reason="missing_text")
                    self._send_json(400, {"error": "text_required"})
                    return

                speech = body.get("speech") if isinstance(body.get("speech"), dict) else None
                normalized_speech = {
                    key: str(value).strip()
                    for key, value in (speech or {}).items()
                    if str(value or "").strip()
                } or None

                try:
                    outer._log_event(
                        "remote_tts_received",
                        utterance=text,
                        voice_name=str((normalized_speech or {}).get("voice_name") or "").strip() or None,
                        voice_id=str((normalized_speech or {}).get("voice_id") or "").strip() or None,
                    )
                    outer._speak_callback(text, normalized_speech)
                except Exception as err:
                    outer._log_event("remote_tts_failed", utterance=text, error=str(err))
                    self._send_json(500, {"error": "speak_failed", "detail": str(err)})
                    return

                self._send_json(200, {"ok": True})

            def log_message(self, _format, *_args):
                return

            def _send_json(self, status: int, payload: dict) -> None:
                encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self._server = QuietThreadingHTTPServer((self._bind_host, self._port), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, name="housemate-remote-tts", daemon=True)
        self._thread.start()
        log(f"remote TTS listener ready on {self._bind_host}:{self.port}")

    def stop(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server:
            server.shutdown()
            server.server_close()
        if thread and thread.is_alive():
            thread.join(timeout=2.0)

    def _log_event(self, event_type: str, **fields) -> None:
        if self._event_logger:
            self._event_logger.log_event(event_type, **fields)


BROWSER_VOICE_POST_PATHS = frozenset({
    "/browser-voice/wake",
    "/browser-voice/wake-prompt",
    "/browser-voice/turn",
    "/browser-voice/turn-stream",
    "/browser-voice/turn-live-stream",
    "/browser-voice/wake-sample",
    "/browser-voice/playback",
})


class LiveEndOfTurnSignal:
    """Tell a live-streaming client that STT heard the end of its turn.

    The bridge sends its NDJSON response headers before reading the upload,
    and the HA relay passes response bytes through while the upload is still
    open, so the terminal can stop capturing without its 1.5 s silence wait.
    `end_of_turn_ready` goes first so the terminal can trust Flux and hold
    its silence cut-off back for mid-sentence pauses. A wake-attached turn
    that so far holds only the wake phrase keeps listening, and the terminal
    is told so it can use its short silence wait for that pause. Events from
    the STT thread and the handler share one lock.
    """

    def __init__(self, stream_writer, *, wake_attached: bool, phrase_variants: dict):
        self._stream_writer = stream_writer
        self._wake_attached = bool(wake_attached)
        self._phrase_variants = phrase_variants
        self._lock = threading.Lock()
        self._open = True
        self.sent = False

    def announce(self) -> None:
        with self._lock:
            if self._open:
                self._stream_writer({"event": "end_of_turn_ready"})

    def __call__(self, transcript: str) -> bool:
        """Return True once the client has been told the turn ended."""
        if self._wake_attached:
            _command, outcome = resolve_wake_attached_utterance(transcript, self._phrase_variants)
            if outcome in {"empty", "wake_only"}:
                with self._lock:
                    if self._open and not self.sent:
                        self._stream_writer({"event": "end_of_turn_wake_only"})
                return False
        with self._lock:
            if self.sent or not self._open:
                return self.sent
            self._stream_writer({"event": "end_of_turn"})
            self.sent = True
        log("live stt end of turn sent to client")
        return True

    def upload_finished(self) -> None:
        with self._lock:
            self._open = False

    def writer(self, payload: dict) -> None:
        with self._lock:
            self._open = False
            self._stream_writer(payload)


class BrowserVoiceServer:
    def __init__(
        self,
        bind_host: str,
        port: int,
        token: str,
        allowed_origins: list[str],
        wake_callback,
        wake_prompt_callback,
        turn_callback,
        turn_stream_callback,
        turn_live_stream_callback=None,
        event_logger: VoiceEventLogger | None = None,
        health_callback=None,
        wake_sample_callback=None,
        playback_callback=None,
    ):
        self._bind_host = normalize_bind_host(bind_host, default="0.0.0.0")
        self._port = max(0, int(port or 0))
        self._token = str(token or "").strip()
        self._allowed_origins = normalize_origin_list(allowed_origins)
        self._wake_callback = wake_callback
        self._wake_prompt_callback = wake_prompt_callback
        self._turn_callback = turn_callback
        self._turn_stream_callback = turn_stream_callback
        self._turn_live_stream_callback = turn_live_stream_callback
        self._event_logger = event_logger
        self._health_callback = health_callback
        self._wake_sample_callback = wake_sample_callback
        self._playback_callback = playback_callback
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        if self._server:
            return int(self._server.server_address[1])
        return self._port

    def start(self) -> None:
        if self._server:
            return

        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_OPTIONS(self):
                if self.path not in BROWSER_VOICE_POST_PATHS:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    return
                origin = outer._allowed_origin(self.headers.get("Origin"))
                if not origin:
                    self.send_response(403)
                    self.send_header("Content-Length", "0")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    return
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Jarvis-Token")
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Max-Age", "86400")
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

            def do_GET(self):
                if self.path != "/browser-voice/health":
                    self._send_json(404, {"error": "not_found"})
                    return
                health = outer._health_callback() if callable(outer._health_callback) else {}
                self._send_json(200, {
                    "ok": True,
                    "port": outer.port,
                    **(health if isinstance(health, dict) else {}),
                })

            def do_POST(self):
                if self.path not in BROWSER_VOICE_POST_PATHS:
                    self._send_json(404, {"error": "not_found"})
                    return
                origin = outer._allowed_origin(self.headers.get("Origin"))
                if not origin:
                    outer._log_event("browser_voice_rejected", reason="origin_not_allowed")
                    self._send_json(403, {"error": "origin_not_allowed"})
                    return
                token = str(self.headers.get("x-jarvis-token") or "").strip()
                if outer._token and token != outer._token:
                    outer._log_event("browser_voice_rejected", reason="unauthorized")
                    self._send_json(401, {"error": "unauthorized"}, origin=origin)
                    return
                if self.path == "/browser-voice/turn-live-stream":
                    if not callable(outer._turn_live_stream_callback):
                        self._send_json(404, {"error": "live_stream_unavailable"}, origin=origin)
                        return
                    client_id = " ".join(str(self.headers.get("X-Jarvis-Client-Id") or "browser-default").split()).strip()[:128]
                    wake_attached = str(self.headers.get("X-Jarvis-Wake-Attached") or "0").strip() == "1"
                    wake_candidate = wake_attached and str(self.headers.get("X-Jarvis-Wake-Candidate") or "0").strip() == "1"
                    try:
                        self._start_event_stream(origin=origin)
                        live_kwargs = {"wake_candidate": True} if wake_candidate else {}
                        outer._turn_live_stream_callback(
                            client_id,
                            wake_attached,
                            self._iter_audio_chunks(),
                            self._write_event,
                            **live_kwargs,
                        )
                        self._write_event({"event": "done"})
                    except BrowserVoiceClientDisconnected:
                        self.close_connection = True
                    except Exception as err:
                        outer._log_event("browser_voice_live_stream_failed", error=str(err))
                        with contextlib.suppress(Exception):
                            self._write_event({"event": "error", "detail": str(err)})
                    return
                try:
                    length = int(self.headers.get("Content-Length") or "0")
                except ValueError:
                    length = 0
                if length <= 0 or length > 4_000_000:
                    outer._log_event("browser_voice_rejected", reason="invalid_length")
                    self._send_json(400, {"error": "invalid_length"}, origin=origin)
                    return
                try:
                    raw = self.rfile.read(length)
                    body = json.loads(raw.decode("utf-8"))
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    self.close_connection = True
                    return
                except Exception:
                    outer._log_event("browser_voice_rejected", reason="invalid_json")
                    self._send_json(400, {"error": "invalid_json"}, origin=origin)
                    return
                try:
                    if self.path == "/browser-voice/wake":
                        result = outer._wake_callback(body)
                    elif self.path == "/browser-voice/wake-prompt":
                        result = outer._wake_prompt_callback(body)
                    elif self.path == "/browser-voice/wake-sample":
                        if not callable(outer._wake_sample_callback):
                            self._send_json(404, {"error": "not_found"}, origin=origin)
                            return
                        result = outer._wake_sample_callback(body)
                    elif self.path == "/browser-voice/playback":
                        if not callable(outer._playback_callback):
                            self._send_json(404, {"error": "not_found"}, origin=origin)
                            return
                        result = outer._playback_callback(body)
                    elif self.path == "/browser-voice/turn-stream":
                        self._start_event_stream(origin=origin)
                        outer._turn_stream_callback(body, self._write_event)
                        self._write_event({"event": "done"})
                        return
                    else:
                        result = outer._turn_callback(body)
                except BrowserVoiceClientDisconnected:
                    self.close_connection = True
                    return
                except Exception as err:
                    outer._log_event("browser_voice_failed", error=str(err))
                    if self.path == "/browser-voice/turn-stream":
                        with contextlib.suppress(Exception):
                            self._write_event({"event": "error", "detail": str(err)})
                        return
                    self._send_json(500, {"error": "turn_failed", "detail": str(err)}, origin=origin)
                    return
                self._send_json(200, result, origin=origin)

            def log_message(self, _format, *_args):
                return

            def _send_json(self, status: int, payload: dict, origin: str | None = None) -> None:
                encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.send_header("Connection", "close")
                if origin:
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Vary", "Origin")
                self.end_headers()
                self.close_connection = True
                self.wfile.write(encoded)

            def _start_event_stream(self, origin: str) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.end_headers()
                self.close_connection = True

            def _write_event(self, payload: dict) -> None:
                encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8") + b"\n"
                try:
                    self.wfile.write(encoded)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as err:
                    self.close_connection = True
                    raise BrowserVoiceClientDisconnected("browser voice client disconnected") from err

            def _iter_audio_chunks(self):
                total = 0
                transfer_encoding = str(self.headers.get("Transfer-Encoding") or "").lower()
                if "chunked" in transfer_encoding:
                    while True:
                        size_line = self.rfile.readline(128)
                        if not size_line:
                            raise ValueError("truncated chunked audio stream")
                        size_text = size_line.split(b";", 1)[0].strip()
                        try:
                            size = int(size_text, 16)
                        except ValueError as err:
                            raise ValueError("invalid chunk size") from err
                        if size == 0:
                            while True:
                                trailer = self.rfile.readline(8192)
                                if trailer in {b"\r\n", b"\n", b""}:
                                    break
                            return
                        if size < 0 or total + size > 2_000_000:
                            raise ValueError("live audio stream too large")
                        payload = self.rfile.read(size)
                        if len(payload) != size:
                            raise ValueError("truncated audio chunk")
                        terminator = self.rfile.read(2)
                        if terminator != b"\r\n":
                            raise ValueError("invalid audio chunk terminator")
                        total += size
                        yield payload
                else:
                    try:
                        remaining = int(self.headers.get("Content-Length") or "0")
                    except ValueError:
                        remaining = 0
                    if remaining <= 0 or remaining > 2_000_000:
                        raise ValueError("invalid live audio length")
                    while remaining:
                        payload = self.rfile.read(min(8192, remaining))
                        if not payload:
                            raise ValueError("truncated live audio stream")
                        remaining -= len(payload)
                        yield payload

        self._server = QuietThreadingHTTPServer((self._bind_host, self._port), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, name="housemate-browser-voice", daemon=True)
        self._thread.start()
        log(f"browser voice listener ready on {self._bind_host}:{self.port}")

    def stop(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server:
            server.shutdown()
            server.server_close()
        if thread and thread.is_alive():
            thread.join(timeout=2)

    def _allowed_origin(self, value: object) -> str | None:
        if not self._allowed_origins:
            return str(value or "").strip() or None
        candidate = str(value or "").strip()
        return candidate if candidate in self._allowed_origins else None

    def _log_event(self, event_type: str, **fields) -> None:
        if self._event_logger:
            self._event_logger.log_event(event_type, **fields)


def _default_voice_audio_manifest_url(configured_url: str, jarvis_url: str) -> str:
    explicit = str(configured_url or "").strip()
    if explicit.lower() in {"disabled", "none", "off", "false"}:
        return ""
    if explicit:
        return explicit
    parsed = urllib.parse.urlparse(str(jarvis_url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return ""
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/admin/voice-clips", "", "", ""))


def _force_ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    results = _force_ipv4_getaddrinfo._orig(host, port, family, type, proto, flags)
    ipv4 = [item for item in results if item[0] == socket.AF_INET]
    return ipv4 or results


_force_ipv4_getaddrinfo._orig = socket.getaddrinfo


@contextlib.contextmanager
def prefer_ipv4():
    original = socket.getaddrinfo
    socket.getaddrinfo = _force_ipv4_getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = original


def _ffmpeg_escape_filter_value(value: str) -> str:
    escaped = str(value or "")
    for source, target in (("\\", "\\\\"), (":", "\\:"), (",", "\\,"), ("'", "\\'")):
        escaped = escaped.replace(source, target)
    return escaped


def cosine_similarity(left: np.ndarray, right: np.ndarray) -> float:
    if np is None:
        return 0.0
    left_norm = float(np.linalg.norm(left))
    right_norm = float(np.linalg.norm(right))
    if left_norm <= 0.0 or right_norm <= 0.0:
        return 0.0
    return float(np.dot(left, right) / (left_norm * right_norm))


def extract_voiced_audio(audio_bytes: bytes, vad_mode: int = 2, pad_frames: int = 2) -> bytes:
    payload = bytes(audio_bytes or b"")
    if not payload:
        return b""
    frame_size = FRAME_BYTES
    frame_count = len(payload) // frame_size
    if frame_count <= 0:
        return payload
    vad = webrtcvad.Vad(max(0, min(3, int(vad_mode))))
    speech_marks = [False] * frame_count
    for index in range(frame_count):
        start = index * frame_size
        frame = payload[start:start + frame_size]
        if len(frame) != frame_size:
            continue
        speech_marks[index] = bool(vad.is_speech(frame, SAMPLE_RATE))
    if not any(speech_marks):
        return payload
    expanded = speech_marks[:]
    pad = max(0, int(pad_frames))
    for index, mark in enumerate(speech_marks):
        if not mark:
            continue
        for cursor in range(max(0, index - pad), min(frame_count, index + pad + 1)):
            expanded[cursor] = True
    chunks = []
    for index, keep in enumerate(expanded):
        if keep:
            start = index * frame_size
            chunks.append(payload[start:start + frame_size])
    return b"".join(chunks) or payload


@dataclasses.dataclass
class Config:
    jarvis_url: str
    jarvis_token: str
    room: str
    jarvis_channel: str
    jarvis_source_via: str
    input_device: str
    output_device: str
    local_voice_enabled: bool
    wake_phrase: str
    kill_phrase: str
    greeting: str
    goodbye: str
    silence_seconds: float
    pre_roll_ms: int
    audio_settle_ms: int
    noise_filter_enabled: bool
    noise_filter_profile: str
    noise_filter_model_path: str
    noise_filter_highpass_hz: int
    noise_filter_lowpass_hz: int
    noise_filter_normalize: bool
    playback_mic_mode: str
    self_voice_reject_enabled: bool
    self_voice_reject_max_lag_ms: int
    self_voice_reject_min_similarity: float
    self_voice_reject_min_playback_rms: int
    self_voice_reject_min_mic_rms: int
    self_voice_reject_max_gain: float
    self_voice_reject_residual_ratio: float
    post_tts_flush_ms: int
    session_idle_seconds: float
    vad_mode: int
    start_trigger_frames: int
    speech_reset_frames: int
    max_turn_seconds: float
    wake_follow_seconds: float
    tts_voice: str
    tts_speed: int
    tts_pitch: int
    fish_audio_enabled: bool
    fish_audio_api_key: str
    fish_audio_voice_id: str
    fish_audio_model: str
    fish_audio_latency: str
    fish_audio_sample_rate: int
    fish_tts_speed: float
    fish_tts_volume_db: float
    fish_tts_temperature: float
    fish_tts_top_p: float
    fish_tts_chunk_length: int
    fish_tts_repetition_penalty: float
    fish_tts_condition_on_previous_chunks: bool
    fish_tts_tone_enabled: bool
    # A short [break] after each comma: Fish runs through commas otherwise.
    fish_tts_comma_breaks: bool
    fish_tts_tone_tags: dict
    fish_tts_night_enabled: bool
    fish_tts_night_start: str
    fish_tts_night_end: str
    fish_tts_night_volume_db: float
    fish_tts_night_speed: float
    stt_model: str
    fast_stt_model: str
    fast_stt_command_max_words: int
    stt_backend: str
    deepgram_api_key: str
    deepgram_model: str
    deepgram_language: str
    deepgram_timeout_seconds: float
    deepgram_endpointing_ms: int
    deepgram_keyterms: list[str]
    deepgram_end_of_turn: str
    deepgram_flux_model: str
    deepgram_flux_eot_threshold: float
    deepgram_flux_warm_socket: bool
    # A person's own Flux end-of-turn threshold, by speaker name: Sam pauses mid-sentence, and the
    # house default ended her turns in the pauses.
    speaker_flux_eot_thresholds: dict
    inworld_api_key: str
    inworld_model: str
    inworld_language: str
    inworld_url: str
    inworld_timeout_seconds: float
    inworld_keyterms: list[str]
    inworld_eot_threshold: float
    inworld_voice_profile: bool
    inworld_voice_profile_top_n: int
    elevenlabs_api_key: str
    elevenlabs_model_id: str
    elevenlabs_language_code: str
    elevenlabs_realtime_url: str
    elevenlabs_audio_format: str
    elevenlabs_commit_strategy: str
    elevenlabs_vad_silence_threshold_secs: float
    elevenlabs_vad_threshold: float
    elevenlabs_min_speech_duration_ms: int
    elevenlabs_min_silence_duration_ms: int
    elevenlabs_no_verbatim: bool
    elevenlabs_enable_logging: bool
    elevenlabs_include_timestamps: bool
    elevenlabs_include_language_detection: bool
    elevenlabs_keyterms: list[str]
    elevenlabs_timeout_seconds: float
    slow_reply_threshold_ms: int
    voice_audio_manifest_url: str
    voice_audio_request_timeout_seconds: float
    voice_audio_cache_seconds: float
    prompt_text_manifest_path: str
    remote_tts_enabled: bool
    remote_tts_bind_host: str
    remote_tts_port: int
    remote_tts_token: str
    browser_voice_enabled: bool
    browser_voice_bind_host: str
    browser_voice_port: int
    browser_voice_token: str
    browser_voice_allowed_origins: list[str]
    browser_voice_trusted_clients: dict[str, str]
    ha_state_publish_enabled: bool
    ha_state_publish_url: str
    ha_state_publish_token: str
    ha_state_publish_client_id: str
    ha_state_publish_timeout_seconds: float
    ha_state_publish_interval_seconds: float
    ha_state_publish_cache_path: str
    default_greeting_speaker: str
    wake_ack_clip_path: str
    wake_ack_clip_speed: float
    wake_ack_clip_volume: float
    wake_greeting_ticker_enabled: bool
    wake_engine: str
    wake_microwakeword_model: str
    wake_vosk_fallback_enabled: bool
    speaker_id_enabled: bool
    speaker_profiles_path: str
    wake_speaker_profiles_path: str
    speaker_id_threshold: float
    speaker_id_min_seconds: float
    speaker_model_cache_dir: str
    wake_model_dir: str
    voice_event_log_dir: str
    wake_sample_capture_enabled: bool
    wake_sample_dir: str
    wake_sample_max_files: int
    phrase_variants: dict
    ears_clip_dir: str = ""
    hard_max_turn_seconds: float = DEFAULT_HARD_MAX_TURN_SECONDS
    # Endpoint Gateway authenticated endpoints (a speaker, later speaker) stream turns
    # into the same live path as the browser bridge. Off unless configured.
    endpoint_gateway_enabled: bool = False
    endpoint_gateway_bind_host: str = "0.0.0.0"
    endpoint_gateway_port: int = 8096
    endpoint_gateway_db_path: str = "~/.local/share/housemate-voice/endpoint-gateway.sqlite3"
    endpoint_gateway_key_path: str = "~/.config/housemate-voice/endpoint-gateway.key"
    # Overrides for the wake policy every endpoint is sent (housemate_endpoint_gateway.live).
    endpoint_wake_policy: dict = dataclasses.field(default_factory=dict)
    # Mute the endpoint's Music Assistant player while it listens (housemate_endpoint_gateway.music_mute).
    endpoint_music_mute: bool = True
    # Deepgram hearing and Fish voice as a Wyoming server for HA Assist (housemate_assist). Off unless configured.
    assist_wyoming_enabled: bool = False
    assist_wyoming_bind_host: str = "0.0.0.0"
    assist_wyoming_port: int = 10310
    assist_stt_no_speech_seconds: float = 8.0
    # The housemate_assist HA agent's turn API (housemate_assist.turns), on with the Wyoming server.
    assist_turn_port: int = 10311
    # Any speech-to-text or voice Home Assistant has, used through HA's own API.
    # stt_backend "home_assistant" hears through ha_stt_entity; ha_tts_entity speaks instead of
    # espeak whenever Fish is off or fails.
    ha_stt_entity: str = ""
    ha_stt_language: str = "en"
    ha_tts_entity: str = ""

    @classmethod
    def load(cls, path: str) -> "Config":
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        # The house first: the assistant's name and people feed the defaults below.
        configure_house(
            str(raw["assistant_name"]) if "assistant_name" in raw else None,
            normalize_user_runtime_path(raw["household_file"]) if raw.get("household_file") else ("" if "household_file" in raw else None),
            raw["ears_house_prompts"] if isinstance(raw.get("ears_house_prompts"), dict) else None,
            raw["assistant_heard_as"] if isinstance(raw.get("assistant_heard_as"), list) else None,
        )
        jarvis_url = str(raw["jarvis_url"]).strip()
        input_device = require_nuc_local_audio_device(raw.get("input_device", "plughw:1,0"), field_name="input_device")
        output_device = require_nuc_local_audio_device(raw.get("output_device", "plughw:1,0"), field_name="output_device")
        remote_tts_enabled = bool(raw.get("remote_tts_enabled", False))
        browser_voice_enabled = bool(raw.get("browser_voice_enabled", False))
        ha_state_publish_enabled = bool(raw.get("ha_state_publish_enabled", False))
        remote_tts_bind_host = require_localhost_bind_host(
            raw.get("remote_tts_bind_host", "127.0.0.1"),
            field_name="remote_tts_bind_host",
        ) if remote_tts_enabled else (str(raw.get("remote_tts_bind_host", "127.0.0.1")).strip() or "127.0.0.1")
        browser_voice_bind_host = normalize_bind_host(
            raw.get("browser_voice_bind_host", "0.0.0.0"),
            default="0.0.0.0",
        ) if browser_voice_enabled else (str(raw.get("browser_voice_bind_host", "0.0.0.0")).strip() or "0.0.0.0")
        ha_state_publish_url = require_http_url(
            raw.get("ha_state_publish_url", ""),
            field_name="ha_state_publish_url",
        ) if ha_state_publish_enabled else (str(raw.get("ha_state_publish_url", "")).strip().rstrip("/"))
        ha_state_publish_token = str(raw.get("ha_state_publish_token", "")).strip()
        if ha_state_publish_enabled and not ha_state_publish_token:
            raise ValueError("ha_state_publish_token must not be empty when ha_state_publish_enabled is true")
        return cls(
            jarvis_url=jarvis_url,
            jarvis_token=str(raw["jarvis_token"]).strip(),
            room=str(raw.get("room", "office")).strip() or "office",
            jarvis_channel=str(raw.get("jarvis_channel", "voice_http")).strip() or "voice_http",
            jarvis_source_via=str(raw.get("jarvis_source_via", "linux_voice_loop")).strip() or "linux_voice_loop",
            input_device=input_device,
            output_device=output_device,
            local_voice_enabled=bool(raw.get("local_voice_enabled", True)),
            wake_phrase=str(raw.get("wake_phrase", "hey housemate")).strip(),
            kill_phrase=str(raw.get("kill_phrase", "bye bye housemate")).strip(),
            greeting=str(raw.get("greeting", "Hi, what can I help you with?")).strip(),
            goodbye=str(raw.get("goodbye", "See you")).strip(),
            silence_seconds=float(raw.get("silence_seconds", 2.0)),
            pre_roll_ms=int(raw.get("pre_roll_ms", 300)),
            audio_settle_ms=int(raw.get("audio_settle_ms", 350)),
            noise_filter_enabled=bool(raw.get("noise_filter_enabled", True)),
            noise_filter_profile=str(raw.get("noise_filter_profile", "speech")).strip().lower() or "speech",
            noise_filter_model_path=normalize_user_runtime_path(raw.get("noise_filter_model_path"), DEFAULT_ARNNDN_MODEL_PATH),
            noise_filter_highpass_hz=int(raw.get("noise_filter_highpass_hz", 65)),
            noise_filter_lowpass_hz=int(raw.get("noise_filter_lowpass_hz", 5000)),
            noise_filter_normalize=bool(raw.get("noise_filter_normalize", True)),
            playback_mic_mode=normalize_playback_mic_mode(raw.get("playback_mic_mode", "suppress")),
            self_voice_reject_enabled=bool(raw.get("self_voice_reject_enabled", True)),
            self_voice_reject_max_lag_ms=int(raw.get("self_voice_reject_max_lag_ms", DEFAULT_SELF_VOICE_REJECT_MAX_LAG_MS)),
            self_voice_reject_min_similarity=float(
                raw.get("self_voice_reject_min_similarity", DEFAULT_SELF_VOICE_REJECT_MIN_SIMILARITY)
            ),
            self_voice_reject_min_playback_rms=int(
                raw.get("self_voice_reject_min_playback_rms", DEFAULT_SELF_VOICE_REJECT_MIN_PLAYBACK_RMS)
            ),
            self_voice_reject_min_mic_rms=int(raw.get("self_voice_reject_min_mic_rms", DEFAULT_SELF_VOICE_REJECT_MIN_MIC_RMS)),
            self_voice_reject_max_gain=float(raw.get("self_voice_reject_max_gain", DEFAULT_SELF_VOICE_REJECT_MAX_GAIN)),
            self_voice_reject_residual_ratio=float(
                raw.get("self_voice_reject_residual_ratio", DEFAULT_SELF_VOICE_REJECT_RESIDUAL_RATIO)
            ),
            post_tts_flush_ms=int(raw.get("post_tts_flush_ms", 700)),
            session_idle_seconds=float(raw.get("session_idle_seconds", 12.0)),
            vad_mode=int(raw.get("vad_mode", 3)),
            start_trigger_frames=int(raw.get("start_trigger_frames", 4)),
            speech_reset_frames=int(raw.get("speech_reset_frames", 3)),
            max_turn_seconds=normalize_max_turn_seconds(raw.get("max_turn_seconds")),
            hard_max_turn_seconds=normalize_hard_max_turn_seconds(
                raw.get("hard_max_turn_seconds"), normalize_max_turn_seconds(raw.get("max_turn_seconds"))
            ),
            wake_follow_seconds=float(raw.get("wake_follow_seconds", 0.55)),
            tts_voice=str(raw.get("tts_voice", "en-au+m3")).strip(),
            tts_speed=int(raw.get("tts_speed", 155)),
            tts_pitch=int(raw.get("tts_pitch", 40)),
            fish_audio_enabled=bool(raw.get("fish_audio_enabled", False)),
            fish_audio_api_key=str(raw.get("fish_audio_api_key", "")).strip(),
            fish_audio_voice_id=str(raw.get("fish_audio_voice_id", "")).strip(),
            fish_audio_model=str(raw.get("fish_audio_model", "s2-pro")).strip() or "s2-pro",
            fish_audio_latency=str(raw.get("fish_audio_latency", "balanced")).strip() or "balanced",
            fish_audio_sample_rate=int(raw.get("fish_audio_sample_rate", FISH_AUDIO_SAMPLE_RATE)),
            fish_tts_speed=float(raw.get("fish_tts_speed", 1.0)),
            fish_tts_volume_db=float(raw.get("fish_tts_volume_db", 0.0)),
            fish_tts_temperature=float(raw.get("fish_tts_temperature", 0.82)),
            fish_tts_top_p=float(raw.get("fish_tts_top_p", 0.88)),
            fish_tts_chunk_length=int(raw.get("fish_tts_chunk_length", 180)),
            fish_tts_repetition_penalty=float(raw.get("fish_tts_repetition_penalty", 1.15)),
            fish_tts_condition_on_previous_chunks=bool(raw.get("fish_tts_condition_on_previous_chunks", True)),
            fish_tts_tone_enabled=bool(raw.get("fish_tts_tone_enabled", True)),
            fish_tts_comma_breaks=bool(raw.get("fish_tts_comma_breaks", False)),
            fish_tts_tone_tags=normalize_fish_tone_tags(raw.get("fish_tts_tone_tags")),
            fish_tts_night_enabled=bool(raw.get("fish_tts_night_enabled", True)),
            fish_tts_night_start=str(raw.get("fish_tts_night_start", DEFAULT_FISH_TTS_NIGHT_START)).strip()
            or DEFAULT_FISH_TTS_NIGHT_START,
            fish_tts_night_end=str(raw.get("fish_tts_night_end", DEFAULT_FISH_TTS_NIGHT_END)).strip()
            or DEFAULT_FISH_TTS_NIGHT_END,
            fish_tts_night_volume_db=float(raw.get("fish_tts_night_volume_db", DEFAULT_FISH_TTS_NIGHT_VOLUME_DB)),
            fish_tts_night_speed=float(raw.get("fish_tts_night_speed", DEFAULT_FISH_TTS_NIGHT_SPEED)),
            stt_model=str(raw.get("stt_model", "base.en")).strip(),
            fast_stt_model=str(raw.get("fast_stt_model", "tiny.en")).strip(),
            fast_stt_command_max_words=int(raw.get("fast_stt_command_max_words", 12)),
            stt_backend=str(raw.get("stt_backend", "local")).strip().lower() or "local",
            deepgram_api_key=str(raw.get("deepgram_api_key", "")).strip(),
            deepgram_model=str(raw.get("deepgram_model", "nova-3")).strip() or "nova-3",
            deepgram_language=str(raw.get("deepgram_language", "en-AU")).strip() or "en-AU",
            deepgram_timeout_seconds=float(raw.get("deepgram_timeout_seconds", 15.0)),
            deepgram_endpointing_ms=max(10, min(2000, int(raw.get("deepgram_endpointing_ms", 300)))),
            deepgram_keyterms=normalize_string_list(raw.get("deepgram_keyterms", list(default_keyterms()))),
            deepgram_end_of_turn=normalize_deepgram_end_of_turn(raw.get("deepgram_end_of_turn")),
            deepgram_flux_model=str(raw.get("deepgram_flux_model", DEFAULT_DEEPGRAM_FLUX_MODEL)).strip() or DEFAULT_DEEPGRAM_FLUX_MODEL,
            deepgram_flux_eot_threshold=max(0.5, min(0.9, float(raw.get("deepgram_flux_eot_threshold", DEFAULT_DEEPGRAM_FLUX_EOT_THRESHOLD)))),
            deepgram_flux_warm_socket=bool(raw.get("deepgram_flux_warm_socket", True)),
            speaker_flux_eot_thresholds=parse_speaker_flux_eot_thresholds(raw.get("speaker_flux_eot_thresholds")),
            inworld_api_key=str(raw.get("inworld_api_key", "")).strip(),
            inworld_model=str(raw.get("inworld_model", DEFAULT_INWORLD_STT_MODEL)).strip() or DEFAULT_INWORLD_STT_MODEL,
            inworld_language=str(raw.get("inworld_language", "en")).strip() or "en",
            inworld_url=str(raw.get("inworld_url", DEFAULT_INWORLD_STT_URL)).strip() or DEFAULT_INWORLD_STT_URL,
            inworld_timeout_seconds=float(raw.get("inworld_timeout_seconds", raw.get("deepgram_timeout_seconds", 15.0))),
            inworld_keyterms=normalize_string_list(raw.get("inworld_keyterms", list(default_keyterms()))),
            inworld_eot_threshold=max(0.0, min(1.0, float(raw.get("inworld_eot_threshold", DEFAULT_INWORLD_EOT_THRESHOLD)))),
            inworld_voice_profile=bool(raw.get("inworld_voice_profile", True)),
            inworld_voice_profile_top_n=max(1, min(INWORLD_VOICE_PROFILE_MAX_TOP_N, int(raw.get("inworld_voice_profile_top_n", 3)))),
            elevenlabs_api_key=str(raw.get("elevenlabs_api_key", "")).strip(),
            elevenlabs_model_id=str(raw.get("elevenlabs_model_id", "scribe_v2_realtime")).strip() or "scribe_v2_realtime",
            elevenlabs_language_code=str(raw.get("elevenlabs_language_code", "en")).strip() or "en",
            elevenlabs_realtime_url=str(raw.get("elevenlabs_realtime_url", "wss://api.elevenlabs.io/v1/speech-to-text/realtime")).strip()
            or "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
            elevenlabs_audio_format=str(raw.get("elevenlabs_audio_format", "pcm_16000")).strip() or "pcm_16000",
            elevenlabs_commit_strategy=str(raw.get("elevenlabs_commit_strategy", "manual")).strip().lower() or "manual",
            elevenlabs_vad_silence_threshold_secs=float(raw.get("elevenlabs_vad_silence_threshold_secs", 1.5)),
            elevenlabs_vad_threshold=float(raw.get("elevenlabs_vad_threshold", 0.4)),
            elevenlabs_min_speech_duration_ms=int(raw.get("elevenlabs_min_speech_duration_ms", 100)),
            elevenlabs_min_silence_duration_ms=int(raw.get("elevenlabs_min_silence_duration_ms", 100)),
            elevenlabs_no_verbatim=bool(raw.get("elevenlabs_no_verbatim", False)),
            elevenlabs_enable_logging=bool(raw.get("elevenlabs_enable_logging", True)),
            elevenlabs_include_timestamps=bool(raw.get("elevenlabs_include_timestamps", False)),
            elevenlabs_include_language_detection=bool(raw.get("elevenlabs_include_language_detection", False)),
            elevenlabs_keyterms=normalize_string_list(raw.get("elevenlabs_keyterms", [])),
            elevenlabs_timeout_seconds=float(raw.get("elevenlabs_timeout_seconds", raw.get("deepgram_timeout_seconds", 15.0))),
            slow_reply_threshold_ms=int(raw.get("slow_reply_threshold_ms", 900)),
            voice_audio_manifest_url=_default_voice_audio_manifest_url(
                str(raw.get("voice_audio_manifest_url") or raw.get("waiting_audio_manifest_url", "")).strip(),
                jarvis_url,
            ),
            voice_audio_request_timeout_seconds=float(
                raw.get("voice_audio_request_timeout_seconds", raw.get("waiting_audio_request_timeout_seconds", 10.0))
            ),
            voice_audio_cache_seconds=float(
                raw.get("voice_audio_cache_seconds", raw.get("waiting_audio_cache_seconds", 60.0))
            ),
            prompt_text_manifest_path=normalize_user_runtime_path(
                raw.get("prompt_text_manifest_path"), DEFAULT_PROMPT_TEXT_MANIFEST_PATH
            ),
            remote_tts_enabled=remote_tts_enabled,
            remote_tts_bind_host=remote_tts_bind_host,
            remote_tts_port=int(raw.get("remote_tts_port", 8093)),
            remote_tts_token=str(raw.get("remote_tts_token", raw.get("jarvis_token", ""))).strip(),
            browser_voice_enabled=browser_voice_enabled,
            browser_voice_bind_host=browser_voice_bind_host,
            browser_voice_port=int(raw.get("browser_voice_port", 8094)),
            browser_voice_token=str(raw.get("browser_voice_token", "")).strip(),
            browser_voice_allowed_origins=normalize_origin_list(
                raw.get("browser_voice_allowed_origins", ["http://homeassistant.local:8123", "http://homeassistant:8123"])
            ),
            browser_voice_trusted_clients=normalize_browser_voice_trusted_clients(
                raw.get("browser_voice_trusted_clients", {})
            ),
            ha_state_publish_enabled=ha_state_publish_enabled,
            ha_state_publish_url=ha_state_publish_url,
            ha_state_publish_token=ha_state_publish_token,
            ha_state_publish_client_id=str(raw.get("ha_state_publish_client_id", "")).strip(),
            ha_state_publish_timeout_seconds=float(raw.get("ha_state_publish_timeout_seconds", 3.0)),
            ha_state_publish_interval_seconds=float(raw.get("ha_state_publish_interval_seconds", 1.0)),
            ha_state_publish_cache_path=normalize_user_runtime_path(
                raw.get("ha_state_publish_cache_path"), DEFAULT_HA_STATE_PUBLISH_CACHE_PATH
            ),
            default_greeting_speaker=str(raw.get("default_greeting_speaker", DEFAULT_GREETING_SPEAKER)).strip() or DEFAULT_GREETING_SPEAKER,
            # An empty clip path turns the clip off; only a set one is resolved.
            wake_ack_clip_path=normalize_user_runtime_path(str(raw.get("wake_ack_clip_path", DEFAULT_WAKE_ACK_CLIP_PATH)).strip()),
            wake_ack_clip_speed=max(0.5, min(2.0, float(raw.get("wake_ack_clip_speed", DEFAULT_WAKE_ACK_CLIP_SPEED)))),
            wake_ack_clip_volume=max(0.0, min(2.0, float(raw.get("wake_ack_clip_volume", DEFAULT_WAKE_ACK_CLIP_VOLUME)))),
            wake_greeting_ticker_enabled=bool(raw.get("wake_greeting_ticker_enabled", False)),
            wake_engine=str(raw.get("wake_engine", DEFAULT_WAKE_ENGINE)).strip().lower() or DEFAULT_WAKE_ENGINE,
            wake_microwakeword_model=str(raw.get("wake_microwakeword_model", DEFAULT_MICROWAKEWORD_MODEL)).strip() or DEFAULT_MICROWAKEWORD_MODEL,
            wake_vosk_fallback_enabled=bool(raw.get("wake_vosk_fallback_enabled", False)),
            speaker_id_enabled=bool(raw.get("speaker_id_enabled", True)),
            speaker_profiles_path=normalize_user_runtime_path(
                raw.get("speaker_profiles_path", DEFAULT_SPEAKER_PROFILES_PATH),
                DEFAULT_SPEAKER_PROFILES_PATH,
            ),
            wake_speaker_profiles_path=normalize_user_runtime_path(
                raw.get("wake_speaker_profiles_path", DEFAULT_WAKE_SPEAKER_PROFILES_PATH),
                DEFAULT_WAKE_SPEAKER_PROFILES_PATH,
            ),
            speaker_id_threshold=float(raw.get("speaker_id_threshold", DEFAULT_SPEAKER_THRESHOLD)),
            speaker_id_min_seconds=float(raw.get("speaker_id_min_seconds", DEFAULT_SPEAKER_MIN_SECONDS)),
            speaker_model_cache_dir=normalize_user_runtime_path(raw.get("speaker_model_cache_dir"), DEFAULT_SPEAKER_MODEL_CACHE_DIR),
            wake_model_dir=normalize_user_runtime_path(raw.get("wake_model_dir"), "~/models/vosk-model-small-en-us-0.15"),
            voice_event_log_dir=normalize_user_runtime_path(raw.get("voice_event_log_dir"), DEFAULT_VOICE_EVENT_LOG_DIR),
            wake_sample_capture_enabled=bool(raw.get("wake_sample_capture_enabled", False)),
            wake_sample_dir=os.path.expanduser(str(raw.get("wake_sample_dir", DEFAULT_WAKE_SAMPLE_DIR)).strip() or DEFAULT_WAKE_SAMPLE_DIR),
            ears_clip_dir=os.path.expanduser(str(raw.get("ears_clip_dir", DEFAULT_EARS_CLIP_DIR)).strip() or DEFAULT_EARS_CLIP_DIR),
            wake_sample_max_files=max(0, min(100000, int(raw.get("wake_sample_max_files", 400)))),
            phrase_variants=raw.get("phrase_variants", {}),
            endpoint_gateway_enabled=bool(raw.get("endpoint_gateway_enabled", False)),
            endpoint_gateway_bind_host=normalize_bind_host(raw.get("endpoint_gateway_bind_host", "0.0.0.0")),
            endpoint_gateway_port=int(raw.get("endpoint_gateway_port", 8096)),
            endpoint_gateway_db_path=normalize_user_runtime_path(
                raw.get("endpoint_gateway_db_path"), "~/.local/share/housemate-voice/endpoint-gateway.sqlite3"
            ),
            endpoint_gateway_key_path=normalize_user_runtime_path(
                raw.get("endpoint_gateway_key_path"), "~/.config/housemate-voice/endpoint-gateway.key"
            ),
            endpoint_wake_policy=dict(raw.get("endpoint_wake_policy") or {}),
            endpoint_music_mute=bool(raw.get("endpoint_music_mute", True)),
            assist_wyoming_enabled=bool(raw.get("assist_wyoming_enabled", False)),
            assist_wyoming_bind_host=normalize_bind_host(raw.get("assist_wyoming_bind_host", "0.0.0.0")),
            assist_wyoming_port=int(raw.get("assist_wyoming_port", 10310)),
            assist_stt_no_speech_seconds=max(1.0, min(30.0, float(raw.get("assist_stt_no_speech_seconds", 8.0)))),
            assist_turn_port=int(raw.get("assist_turn_port", 10311)),
            ha_stt_entity=str(raw.get("ha_stt_entity", "")).strip(),
            ha_stt_language=str(raw.get("ha_stt_language", "en")).strip() or "en",
            ha_tts_entity=str(raw.get("ha_tts_entity", "")).strip(),
        )


def normalize_text(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9']+", " ", str(text or "").lower())
    return " ".join(normalized.split())


def configure_name_patterns() -> None:
    """The patterns that hear the assistant's name, built from its name and how it is misheard
    (configure_house); every other word in them is ordinary English."""
    global CALIBRATION_START_RE, THANKS_KILL_RE, BARE_GOODBYE_RE, SHORT_POST_WAKE_GOODBYE_RE
    global BARE_WAKE_NAMES, WAKE_MISHEARD_START_RE, WAKE_NAME_EARLY_RE
    names = name_alternation()
    misheard = "|".join(re.escape(word) for word in sorted(_HOUSE["heard_as"], key=len, reverse=True)) or "(?!)"
    CALIBRATION_START_RE = re.compile(
        rf"^(?:(?:ok|okay|right|alright|{names}|please)\s+)*(?:play|start|run|begin|do)\s+(?:a\s+|the\s+)?"
        r"(?:calibration|calibrating|calibrate)(?:\s+(?:mode|test|please))*$"
    )
    THANKS_KILL_RE = re.compile(
        r"\b(?:thanks|thank you|cheers)\b"
        rf"(?:\s+(?:{names}))?"
        r".{0,24}?"
        r"\b(?:see ya|see you|bye|catch you later)\b"
    )
    # A goodbye on its own, without the name: inside a conversation "see you", "okay bye" or
    # "later mate" can only mean the conversation is over.
    BARE_GOODBYE_RE = re.compile(
        r"^(?:(?:ok(?:ay)?|alright|right|sweet|thanks|thank you|cheers)\s+)*"
        r"(?:bye(?: bye)?|goodbye|good bye|see (?:you|ya|u)|seeya|cya|c ya|c u|cu|catch (?:you|ya)|later|laters)"
        rf"(?:\s+(?:later|then|mate|for now|{names}))*$"
    )
    SHORT_POST_WAKE_GOODBYE_RE = re.compile(
        r"^(?:ok(?:ay)?\s+|alright\s+|right\s+|sweet\s+)?"
        r"(?:see you|see ya|bye|bye bye|goodbye|catch you later)"
        rf"(?:\s+(?:mate|{names}))?"
        r"\.?$"
    )
    BARE_WAKE_NAMES = frozenset(assistant_names())
    # The wake phrase as speech-to-text writes it when it misses: a mishearing of the name opening the
    # turn ("hey <misheard> ..."), or the name itself a few words in.
    WAKE_MISHEARD_START_RE = re.compile(rf"^(?:(?:hey|hi|hay|a|my|our|ok|okay|oh) )?(?:{misheard})\b")
    # Only the name itself counts a few words in: a mishearing there ("tell your dad") is ordinary talk.
    WAKE_NAME_EARLY_RE = re.compile(rf"^(?:\S+ ){{0,3}}{re.escape(normalize_text(assistant_name()))}\b")


configure_name_patterns()


FORBIDDEN_EXTERNAL_AUDIO_DEVICE_RE = re.compile(r"(?:^|[^a-z0-9])(?:echo|alexa|amazon)(?:$|[^a-z0-9])", re.IGNORECASE)


def require_nuc_local_audio_device(value: object, field_name: str) -> str:
    device = str(value or "").strip()
    if not device:
        raise ValueError(f"{field_name} must not be empty")
    if FORBIDDEN_EXTERNAL_AUDIO_DEVICE_RE.search(device):
        raise ValueError(f"{field_name} must stay on this box's own audio path; Echo/Alexa devices are not allowed")
    return device


def require_localhost_bind_host(value: object, field_name: str) -> str:
    host = str(value or "").strip() or "127.0.0.1"
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"{field_name} must stay on localhost for local-only audio control")
    return host


def normalize_bind_host(value: object, default: str = "0.0.0.0") -> str:
    host = str(value or "").strip()
    return host or str(default or "0.0.0.0").strip() or "0.0.0.0"


def normalize_user_runtime_path(value: object, default: str = "") -> str:
    configured = str(value or default or "").strip() or str(default or "").strip()
    runtime_home = os.path.abspath(
        str(os.environ.get("HOME") or os.path.expanduser("~") or "").strip()
    )
    # A path written for another user's home (a settings file moved from another box) is re-rooted here.
    moved = re.match(r"^/home/[^/]+/(.+)$", configured)
    if moved and runtime_home and not configured.startswith(runtime_home.rstrip("/") + "/"):
        configured = os.path.join(runtime_home, moved.group(1))
    return os.path.abspath(os.path.expanduser(configured)) if configured else ""


def normalize_max_turn_seconds(value: object) -> float:
    seconds = float(DEFAULT_MAX_TURN_SECONDS if value in (None, "") else value)
    if abs(seconds - LEGACY_MAX_TURN_SECONDS) < 0.001:
        seconds = DEFAULT_MAX_TURN_SECONDS
    return max(2.0, min(45.0, seconds))


def normalize_hard_max_turn_seconds(value: object, soft_seconds: float) -> float:
    seconds = float(DEFAULT_HARD_MAX_TURN_SECONDS if value in (None, "") else value)
    return max(soft_seconds, min(300.0, seconds))


def normalize_playback_mic_mode(value: object) -> str:
    mode = str(value or "suppress").strip().lower()
    if mode in {"aec", "echo_cancel", "echo-cancel", "barge_in", "barge-in"}:
        return "aec"
    return "suppress"


def normalize_voice_state(value: object) -> str:
    state = str(value or "").strip().lower()
    if state in HA_VOICE_STATES:
        return state
    return "idle"


def normalize_household_speaker_slug(value: object) -> str:
    """A household speaker as a lower-case slug for HA states ("sam"); anyone else is "unknown"."""
    normalized = normalize_text(str(value or ""))
    for speaker in known_wake_speakers():
        if normalize_text(speaker) == normalized:
            return re.sub(r"[^a-z0-9]+", "_", normalized).strip("_") or "unknown"
    return "unknown"


def require_http_url(value: object, field_name: str) -> str:
    url = str(value or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field_name} must be a valid http or https URL")
    return url


def normalize_origin_list(value: object) -> list[str]:
    origins = []
    for candidate in normalize_string_list(value):
        parsed = urllib.parse.urlparse(str(candidate or "").strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        origin = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))
        if origin not in origins:
            origins.append(origin)
    return origins


def encode_wav_bytes(
    audio_bytes: bytes,
    *,
    sample_rate: int = SAMPLE_RATE,
    channels: int = 1,
    sample_width: int = SAMPLE_WIDTH,
) -> bytes:
    handle = io.BytesIO()
    with wave.open(handle, "wb") as wav_handle:
        wav_handle.setnchannels(max(1, int(channels or 1)))
        wav_handle.setsampwidth(max(1, int(sample_width or SAMPLE_WIDTH)))
        wav_handle.setframerate(max(1, int(sample_rate or SAMPLE_RATE)))
        wav_handle.writeframes(bytes(audio_bytes or b""))
    return handle.getvalue()


WAKE_SAMPLE_MIN_FREE_BYTES = 2 * 1024 ** 3
WAKE_SAMPLE_STAMP_RE = re.compile(r"\d{8}T\d{6}")


def wake_sample_sort_key(stem: str) -> tuple[str, str]:
    # Turn stems start "browser-turn-<stamp>", wake stems start "<stamp>":
    # sort by the stamp so pruning removes the oldest clips, not wake clips.
    match = WAKE_SAMPLE_STAMP_RE.search(stem)
    return (match.group(0) if match else "", stem)


def prune_wake_samples(directory: str, max_files: int) -> None:
    """Keep the newest max_files clips; 0 keeps everything for wake training."""
    if int(max_files) <= 0:
        return
    stems = sorted(
        {name.rsplit(".", 1)[0] for name in os.listdir(directory) if name.endswith((".wav", ".json"))},
        key=wake_sample_sort_key,
    )
    for stem in stems[: max(0, len(stems) - int(max_files))]:
        for suffix in (".wav", ".json"):
            with contextlib.suppress(FileNotFoundError):
                os.remove(os.path.join(directory, stem + suffix))


def decode_browser_audio_to_pcm(audio_bytes: bytes) -> bytes:
    payload = bytes(audio_bytes or b"")
    if not payload:
        return b""
    with wave.open(io.BytesIO(payload), "rb") as wav_handle:
        channels = wav_handle.getnchannels()
        sample_width = wav_handle.getsampwidth()
        sample_rate = wav_handle.getframerate()
        raw_audio = wav_handle.readframes(wav_handle.getnframes())
    samples = pcm_bytes_to_samples(raw_audio, sample_width=sample_width)
    mono_samples = mix_samples_to_mono(samples, channels=channels)
    if sample_rate != SAMPLE_RATE:
        mono_samples, _ = resample_pcm_samples(
            mono_samples,
            source_rate=sample_rate,
            target_rate=SAMPLE_RATE,
            state=None,
        )
    return pcm_samples_to_bytes(mono_samples)


def trim_audio_tail(audio_bytes: bytes, trim_seconds: float) -> bytes:
    payload = bytes(audio_bytes or b"")
    if not payload:
        return b""
    trim_bytes = int(round(max(0.0, float(trim_seconds)) * SAMPLE_RATE * SAMPLE_WIDTH))
    if trim_bytes <= 0:
        return payload
    if trim_bytes >= len(payload):
        return b""
    return payload[:-trim_bytes]


def estimate_trailing_non_speech_ms(audio_bytes: bytes, vad_mode: int = 3) -> int | None:
    payload = bytes(audio_bytes or b"")
    if not payload:
        return None
    frame_count = len(payload) // FRAME_BYTES
    if frame_count <= 0:
        return None
    vad = webrtcvad.Vad(max(0, min(3, int(vad_mode))))
    trailing_frames = 0
    found_speech = False
    for index in range(frame_count - 1, -1, -1):
        start = index * FRAME_BYTES
        frame = payload[start:start + FRAME_BYTES]
        if len(frame) != FRAME_BYTES:
            continue
        if vad.is_speech(frame, SAMPLE_RATE):
            found_speech = True
            break
        trailing_frames += 1
    if not found_speech:
        return None
    return max(0, int(trailing_frames * FRAME_MS))


def estimate_wake_phrase_start_lag_ms(audio_bytes: bytes, vad_mode: int = 3) -> int | None:
    payload = bytes(audio_bytes or b"")
    if not payload:
        return None
    frame_count = len(payload) // FRAME_BYTES
    if frame_count <= 0:
        return None
    vad = webrtcvad.Vad(max(0, min(3, int(vad_mode))))
    for index in range(frame_count):
        start = index * FRAME_BYTES
        frame = payload[start:start + FRAME_BYTES]
        if len(frame) != FRAME_BYTES:
            continue
        if vad.is_speech(frame, SAMPLE_RATE):
            return max(0, int((frame_count - index) * FRAME_MS))
    return None


def apply_known_transcript_corrections(text: str) -> str:
    spoken = " ".join(str(text or "").split()).strip()
    if not spoken:
        return ""
    corrected = re.sub(r"\boffice slide\b", "office light", spoken, flags=re.IGNORECASE)
    corrected = re.sub(rf"\bsay a ({name_alternation()})\b", r"see ya \1", corrected, flags=re.IGNORECASE)
    return corrected


def kill_phrase_candidates(phrase_variants: dict) -> tuple[str, ...]:
    candidates: set[str] = set()
    for phrase in phrase_variants.get("kill", []):
        candidate = normalize_text(phrase)
        if candidate:
            candidates.add(candidate)
    for opener in DEFAULT_KILL_OPENERS:
        for name in assistant_names():
            candidates.add(f"{opener} {name}")
    return tuple(sorted(candidates))


def matches_kill_phrase_text(text: str, phrase_variants: dict) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    if THANKS_KILL_RE.search(normalized) or BARE_GOODBYE_RE.match(normalized):
        return True
    # Whole words only: "standby housemate" is not "by housemate".
    padded = f" {normalized} "
    for candidate in kill_phrase_candidates(phrase_variants):
        if candidate and f" {candidate} " in padded:
            return True
    return False


def build_noise_filter_chain(config: Config) -> str:
    if not config.noise_filter_enabled:
        return ""
    filters: list[str] = []
    highpass_hz = max(0, int(config.noise_filter_highpass_hz))
    lowpass_hz = max(0, int(config.noise_filter_lowpass_hz))
    if highpass_hz:
        filters.append(f"highpass=f={highpass_hz}")
    if lowpass_hz:
        filters.append(f"lowpass=f={lowpass_hz}")
    if config.noise_filter_profile in {"speech", "arnndn", "rnnoise"} and os.path.isfile(config.noise_filter_model_path):
        filters.append(f"arnndn=m={_ffmpeg_escape_filter_value(config.noise_filter_model_path)}")
    if config.noise_filter_normalize:
        filters.append("speechnorm=e=6.25:r=0.00005:l=1")
    return ",".join(filters)


def looks_like_explicit_device_command(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    if not re.search(rf"\b{CONTROL_VERB_RE}\b", normalized):
        return False
    return bool(re.search(rf"\b{DEVICE_NOUN_RE}\b", normalized))


def looks_like_followup_device_command(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    if not re.search(rf"\b{CONTROL_VERB_RE}\b", normalized):
        return False
    if re.search(rf"\b{DEVICE_NOUN_RE}\b", normalized):
        return True
    return bool(re.search(r"\b(it|them|that|this|those|these)\b", normalized))


def looks_like_short_fast_turn(text: str, phrase_variants: dict, max_words: int) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    if len(normalized.split()) > max_words:
        return False
    if looks_like_explicit_device_command(normalized):
        return True
    if looks_like_followup_device_command(normalized):
        return True
    return matches_kill_phrase_text(normalized, phrase_variants)


def is_wake_only_text(text: str, phrase_variants: dict) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    for phrase in phrase_variants.get("wake", []):
        candidate = normalize_text(phrase)
        if candidate and normalized == candidate:
            return True
    return False


def strip_leading_wake_phrase(text: str, phrase_variants: dict) -> str:
    spoken = " ".join(str(text or "").split()).strip()
    if not spoken:
        return ""
    wake_prefixes = list(phrase_variants.get("wake", [])) + list(assistant_names())
    for phrase in wake_prefixes:
        candidate = normalize_text(phrase)
        if not candidate:
            continue
        pattern = re.compile(rf"^\W*{re.escape(candidate)}(?:\W+|$)", re.IGNORECASE)
        match = pattern.match(normalize_text(spoken))
        if not match:
            continue
        normalized_spoken = normalize_text(spoken)
        stripped = normalized_spoken[match.end():].strip()
        return stripped
    return ""


# "bye bye Housemate" is primed too: unprimed it came back as "Barbie Housemate" and "Buy buy Housemate".
def default_keyterms() -> tuple[str, str]:
    """The assistant's name and its goodbye, for engines that take keyterms."""
    return (assistant_name(), f"bye bye {assistant_name()}")


def normalize_deepgram_end_of_turn(value) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in DEEPGRAM_END_OF_TURN_MODES else "silence"

# An endpoint sends up to 2.5 s from before its wake word so the first word is never clipped, and with
# a TV or other people talking STT writes that down too. That is at most this many words.
PRE_WAKE_MAX_WORDS = 10


def after_pre_wake_words(normalized: str, phrase_variants: dict) -> str | None:
    """What follows a full wake phrase found after some opening words, or None if there is none.

    Only full phrases ("hey housemate"), not the bare name: a bare "Housemate" further in is more likely
    part of the request than its start.
    """
    words = normalized.split()
    variants = [normalize_text(phrase).split() for phrase in phrase_variants.get("wake", [])]
    for at in range(1, min(len(words), PRE_WAKE_MAX_WORDS + 1)):
        for variant in variants:
            if variant and words[at:at + len(variant)] == variant:
                return " ".join(words[at + len(variant):])
    return None


def resolve_wake_attached_utterance(text: str, phrase_variants: dict) -> tuple[str, str]:
    """Return (command, outcome) for a turn that carries wake audio.

    A transcript is only wake-only when it contains nothing but the wake
    phrase. A missing or mangled wake prefix never discards the command.
    Words before a wake phrase in the opening few were the room, not the
    speaker ("were just hurting him. Hey, Housemate. Turn..."), and are dropped.
    """
    spoken = " ".join(str(text or "").split()).strip()
    normalized = normalize_text(spoken)
    if not normalized:
        return "", "empty"
    if is_wake_only_text(normalized, phrase_variants) or normalized in BARE_WAKE_NAMES:
        return "", "wake_only"
    stripped = strip_leading_wake_phrase(spoken, phrase_variants)
    if stripped:
        return stripped, "wake_stripped"
    after = after_pre_wake_words(normalized, phrase_variants)
    if after is not None:
        return after, ("wake_stripped" if after else "wake_only")
    return spoken, "no_wake_prefix"


# "Hey Housemate" as STT hears it when it misses the phrase: "my job is pause", "our jobs stopped", a
# child's "Hey, dad", or "Housemate" a few words in ("I mean, Housemate,..."). All
# real wakes a speaker was sure of without the phrase look like this; false ones ("help. It's a jersey", "You know? What do you have?") do not.


# A plain command on its own: over music STT can lose "Hey Housemate" and keep only the word that matters
# Room talk that a speaker is
# sure of AND that is nothing but one of these is not worth refusing.
PLAIN_COMMAND_RE = re.compile(
    r"^(?:(?:please|now) )?(?:pause|stop|resume|play|skip|next(?: song| track| one)?|previous(?: song| track| one)?|"
    r"stop the music|pause the music|turn it (?:up|down)|louder|quieter|volume (?:up|down)|mute|unmute|"
    r"lights? (?:on|off)|turn (?:on|off) the lights?|turn the lights? (?:on|off))(?: please)?$"
)


# Timer sentences on an Assist satellite go to HA's own timer intents, which tie the timer to the
# satellite so it rings on the dot ("set a timer for ten minutes", "how long is left", "cancel the timer").
HA_TIMER_COMMAND_RE = re.compile(
    r"\btimers?\b|\bhow (?:long|much time)(?: is| has| have i got| do i have)?(?: got)? (?:left|remaining|to go)\b"
    r"|\btime (?:left|remaining)\b"
)


def looks_like_ha_timer_command(text: str) -> bool:
    return bool(HA_TIMER_COMMAND_RE.search(normalize_text(text)))


def looks_like_misheard_wake(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(WAKE_MISHEARD_START_RE.match(normalized) or WAKE_NAME_EARLY_RE.match(normalized)
                or PLAIN_COMMAND_RE.match(normalized))


def looks_like_wake_only_fast_turn(text: str, phrase_variants: dict) -> bool:
    return is_wake_only_text(text, phrase_variants)


def looks_like_probable_wake_garble(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    words = normalized.split()
    if len(words) > 3:
        return False
    if looks_like_explicit_device_command(normalized):
        return False
    if looks_like_followup_device_command(normalized):
        return False
    return True


def should_ignore_short_first_post_wake_goodbye(text: str, audio_bytes: bytes, phrase_variants: dict) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    audio_seconds = len(bytes(audio_bytes or b"")) / float(SAMPLE_RATE * SAMPLE_WIDTH)
    if audio_seconds <= 0.0 or audio_seconds > SHORT_POST_WAKE_GOODBYE_MAX_SECONDS:
        return False
    if SHORT_POST_WAKE_GOODBYE_RE.fullmatch(normalized):
        return True
    return matches_kill_phrase_text(normalized, phrase_variants)


class AudioInput:
    def __init__(self, device: str, settle_ms: int = 0, filter_chain: str = "", self_voice_rejector: LivePlaybackMirror | None = None):
        self._device = device
        self._settle_ms = max(0, int(settle_ms))
        self._filter_chain = str(filter_chain or "").strip()
        self._self_voice_rejector = self_voice_rejector
        self._capture_proc = None
        self._filter_proc = None
        self._stdout = None
        self._suppress_lock = threading.Lock()
        with self._suppress_lock:
            self._suppressed_frames = 0
            self._playback_suppressed = False

    def __enter__(self) -> "AudioInput":
        self.restart()
        return self

    def restart(self) -> None:
        self._stop()
        capture_cmd = [
            "arecord",
            "-D",
            self._device,
            "-f",
            "S16_LE",
            "-c",
            "1",
            "-r",
            str(SAMPLE_RATE),
            "-t",
            "raw",
            "-q",
            "-",
        ]
        self._capture_proc = subprocess.Popen(
            capture_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self._stdout = self._capture_proc.stdout
        if self._filter_chain:
            ffmpeg_cmd = [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-i",
                "pipe:0",
                "-af",
                self._filter_chain,
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-",
            ]
            self._filter_proc = subprocess.Popen(
                ffmpeg_cmd,
                stdin=self._capture_proc.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
            if self._capture_proc.stdout:
                self._capture_proc.stdout.close()
            self._stdout = self._filter_proc.stdout
        if self._settle_ms:
            time.sleep(self._settle_ms / 1000.0)
        log(f"audio capture ready{' with filter' if self._filter_chain else ''}")

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop()

    def _stop(self) -> None:
        if self._filter_proc:
            self._filter_proc.terminate()
            with contextlib.suppress(Exception):
                self._filter_proc.wait(timeout=2)
        if self._capture_proc:
            self._capture_proc.terminate()
            with contextlib.suppress(Exception):
                self._capture_proc.wait(timeout=2)
        self._capture_proc = None
        self._filter_proc = None
        self._stdout = None
        with self._suppress_lock:
            self._suppressed_frames = 0
            self._playback_suppressed = False

    def _read_frame_from_stream(self) -> bytes:
        if not self._stdout:
            raise RuntimeError("audio input not running")
        chunks = bytearray()
        while len(chunks) < FRAME_BYTES:
            piece = self._stdout.read(FRAME_BYTES - len(chunks))
            if not piece:
                break
            chunks.extend(piece)
        if len(chunks) != FRAME_BYTES:
            raise EOFError("audio input stream ended")
        return bytes(chunks)

    def read_frame(self) -> bytes:
        frame = self._read_frame_from_stream()
        with self._suppress_lock:
            if self._playback_suppressed:
                return SILENCE_FRAME
            if self._suppressed_frames > 0:
                self._suppressed_frames -= 1
                return SILENCE_FRAME
        rejector = getattr(self, "_self_voice_rejector", None)
        if rejector is not None:
            if hasattr(rejector, "process_frame"):
                return rejector.process_frame(frame)
            if hasattr(rejector, "should_reject") and rejector.should_reject(frame):
                return SILENCE_FRAME
        return frame

    def discard_ms(self, duration_ms: int) -> None:
        frames = max(0, int(round(duration_ms / FRAME_MS)))
        for _ in range(frames):
            self._read_frame_from_stream()

    def discard_pending_ms(self, duration_ms: int) -> int:
        if not self._stdout:
            return 0
        frames = max(0, int(round(max(0.0, float(duration_ms)) / FRAME_MS)))
        target_bytes = frames * FRAME_BYTES
        if target_bytes <= 0:
            return 0
        try:
            fd = self._stdout.fileno()
            was_blocking = os.get_blocking(fd)
        except (AttributeError, OSError, ValueError):
            return 0
        discarded_bytes = 0
        try:
            os.set_blocking(fd, False)
            while discarded_bytes < target_bytes:
                try:
                    chunk = os.read(fd, min(8192, target_bytes - discarded_bytes))
                except BlockingIOError:
                    break
                except OSError:
                    break
                if not chunk:
                    self.restart()
                    break
                discarded_bytes += len(chunk)
        finally:
            with contextlib.suppress(OSError, ValueError):
                os.set_blocking(fd, was_blocking)
        if discarded_bytes <= 0:
            return 0
        return int(math.ceil(discarded_bytes / FRAME_BYTES))

    def suppress_next_ms(self, duration_ms: int) -> None:
        frames = max(0, int(round(max(0.0, float(duration_ms)) / FRAME_MS)))
        if frames <= 0:
            return
        with self._suppress_lock:
            self._suppressed_frames += frames

    def begin_playback_suppression(self) -> None:
        with self._suppress_lock:
            self._playback_suppressed = True

    def end_playback_suppression(self) -> None:
        with self._suppress_lock:
            self._playback_suppressed = False


class PhraseSpotter:
    def __init__(self, model_dir: str, phrase_variants: dict):
        if not os.path.isdir(model_dir):
            raise FileNotFoundError(f"missing Vosk model directory: {model_dir}")
        SetLogLevel(-1)
        self._model = Model(model_dir)
        self._recognizer = self._build_recognizer()
        self._buffer = bytearray()
        self._recent_frames = collections.deque(maxlen=max(1, int(round(WAKE_HISTORY_MS / FRAME_MS))))
        self._phrase_variants = {
            key: tuple(str(value).lower().strip() for value in values)
            for key, values in phrase_variants.items()
        }

    def _build_recognizer(self):
        recognizer = KaldiRecognizer(self._model, SAMPLE_RATE)
        recognizer.SetWords(False)
        return recognizer

    def reset(self) -> None:
        self._recognizer = self._build_recognizer()
        self._buffer.clear()
        self._recent_frames.clear()

    def feed(self, frame: bytes) -> str | None:
        self._recent_frames.append(frame)
        self._buffer.extend(frame)
        if len(self._buffer) < FRAME_BYTES * WAKE_CHUNK_FRAMES:
            return None
        chunk = bytes(self._buffer)
        self._buffer.clear()
        if self._recognizer.AcceptWaveform(chunk):
            return self._classify(self._recognizer.Result())
        partial = self._classify(self._recognizer.PartialResult())
        return partial

    def flush(self) -> str | None:
        return self._classify(self._recognizer.FinalResult())

    def recent_audio(self) -> bytes:
        return b"".join(self._recent_frames)

    def _classify(self, payload: str) -> str | None:
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return None
        text = " ".join(str(data.get("text") or data.get("partial") or "").lower().split())
        if not text:
            return None
        for event, variants in self._phrase_variants.items():
            if event == "kill" and matches_kill_phrase_text(text, self._phrase_variants):
                return event
            if any(phrase in text for phrase in variants):
                return event
        return None


class MicroWakeWordPhraseSpotter:
    def __init__(self, model_name: str):
        if MicroWakeWord is None or MicroWakeWordFeatures is None:
            raise RuntimeError("microWakeWord is unavailable in this environment")
        candidate = str(model_name or DEFAULT_MICROWAKEWORD_MODEL).strip() or DEFAULT_MICROWAKEWORD_MODEL
        self._label = candidate
        if os.path.isfile(candidate):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self._model = MicroWakeWord.from_config(candidate)
            self._label = str(getattr(self._model, "wake_word", "") or os.path.basename(candidate)).strip()
        else:
            if MicroWakeWordBuiltinModel is None:
                raise RuntimeError("microWakeWord built-in models are unavailable")
            enum_name = candidate.replace("-", "_").replace(" ", "_").upper()
            try:
                builtin = MicroWakeWordBuiltinModel[enum_name]
            except KeyError as err:
                raise FileNotFoundError(f"unknown microWakeWord model: {candidate}") from err
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self._model = MicroWakeWord.from_builtin(builtin)
            self._label = candidate
        self._features = MicroWakeWordFeatures()
        self._buffer = bytearray()
        self._recent_frames = collections.deque(maxlen=max(1, int(round(WAKE_HISTORY_MS / FRAME_MS))))

    def reset(self) -> None:
        self._model.reset()
        self._features.reset()
        self._buffer.clear()
        self._recent_frames.clear()

    def feed(self, frame: bytes) -> str | None:
        self._recent_frames.append(frame)
        self._buffer.extend(frame)
        while len(self._buffer) >= MICROWAKEWORD_FRAME_BYTES:
            chunk = bytes(self._buffer[:MICROWAKEWORD_FRAME_BYTES])
            del self._buffer[:MICROWAKEWORD_FRAME_BYTES]
            for features in self._features.process_streaming(chunk):
                detected = self._model.process_streaming(features)
                if detected:
                    return "wake"
        return None

    def recent_audio(self) -> bytes:
        return b"".join(self._recent_frames)


class CombinedWakeSpotter:
    def __init__(self, primary, fallback):
        self._primary = primary
        self._fallback = fallback

    def reset(self) -> None:
        for spotter in (self._primary, self._fallback):
            if hasattr(spotter, "reset"):
                spotter.reset()

    def feed(self, frame: bytes) -> str | None:
        primary_event = self._primary.feed(frame)
        fallback_event = self._fallback.feed(frame)
        return primary_event or fallback_event

    def recent_audio(self) -> bytes:
        if hasattr(self._primary, "recent_audio"):
            return self._primary.recent_audio()
        if hasattr(self._fallback, "recent_audio"):
            return self._fallback.recent_audio()
        return b""


class SpeakerIdentifier:
    def __init__(
        self,
        enabled: bool,
        profiles_path: str,
        wake_profiles_path: str,
        threshold: float,
        min_seconds: float,
        model_cache_dir: str,
    ):
        self._enabled = bool(enabled)
        self._profiles_path = normalize_user_runtime_path(profiles_path)
        self._wake_profiles_path = normalize_user_runtime_path(wake_profiles_path)
        self._threshold = max(0.0, min(1.0, float(threshold)))
        self._min_bytes = max(1, int(round(max(0.1, float(min_seconds)) * SAMPLE_RATE * SAMPLE_WIDTH)))
        self._model_cache_dir = str(model_cache_dir or DEFAULT_SPEAKER_MODEL_CACHE_DIR).strip() or DEFAULT_SPEAKER_MODEL_CACHE_DIR
        self._profile_load_errors: dict[str, str] = {}
        self._profiles = self._load_profiles()
        self._wake_profiles = self._load_profiles(self._wake_profiles_path)
        self._engine = None
        self._engine_state = "not_loaded"
        self._engine_lock = threading.Lock()

    def _load_profiles(self, path: str | None = None) -> dict[str, np.ndarray]:
        path = normalize_user_runtime_path(path if path is not None else self._profiles_path)
        if not path:
            self._profile_load_errors[path] = "path_not_configured"
            return {}
        if not os.path.isfile(path):
            self._profile_load_errors[path] = "file_missing"
            return {}
        if np is None:
            self._profile_load_errors[path] = "numpy_unavailable"
            return {}
        if tag_profiles_with_person_ids(path):
            log(f"speaker profiles in {path} now carry person ids (backup kept)")
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except Exception as err:
            self._profile_load_errors[path] = f"load_failed: {err}"
            log(f"speaker profile load failed for {path}: {err}")
            return {}
        speakers = payload.get("speakers", []) if isinstance(payload, dict) else []
        profiles = {}
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            name = profile_speaker_name(speaker)
            embedding = speaker.get("embedding")
            if not name or not isinstance(embedding, list):
                continue
            try:
                profiles[name] = np.asarray(embedding, dtype=np.float32)
            except Exception:
                continue
        if profiles:
            self._profile_load_errors.pop(path, None)
        else:
            self._profile_load_errors[path] = "no_valid_speakers"
        return profiles

    def can_identify(self) -> bool:
        return bool(
            getattr(self, "_enabled", False)
            and (getattr(self, "_profiles", {}) or getattr(self, "_wake_profiles", {}))
            and np is not None
            and torch is not None
            and SpeakerRecognition is not None
            and getattr(self, "_engine_state", "not_loaded") == "ready"
            and getattr(self, "_engine", None) is not None
        )

    def readiness(self) -> dict:
        enabled = bool(getattr(self, "_enabled", False))
        profile_count = len(getattr(self, "_profiles", {}) or {})
        wake_profile_count = len(getattr(self, "_wake_profiles", {}) or {})
        session_path = normalize_user_runtime_path(getattr(self, "_profiles_path", ""))
        wake_path = normalize_user_runtime_path(getattr(self, "_wake_profiles_path", ""))
        dependencies_ready = bool(np is not None and torch is not None and SpeakerRecognition is not None)
        missing_paths = [
            path
            for path in (session_path, wake_path)
            if path and not os.path.isfile(path)
        ]
        if not enabled:
            status = "disabled"
            reason = "speaker_id_disabled"
        elif not dependencies_ready:
            status = "unavailable"
            reason = "runtime_dependencies_unavailable"
        elif profile_count <= 0 and wake_profile_count <= 0:
            status = "unavailable"
            reason = "profile_files_missing" if missing_paths else "profiles_empty_or_invalid"
        else:
            engine_state = str(getattr(self, "_engine_state", "not_loaded") or "not_loaded")
            if engine_state == "failed":
                status = "unavailable"
                reason = "speaker_model_load_failed"
            elif engine_state != "ready" or getattr(self, "_engine", None) is None:
                status = "initializing"
                reason = "speaker_model_loading" if engine_state == "loading" else "speaker_model_not_loaded"
            elif profile_count <= 0 or wake_profile_count <= 0:
                status = "degraded"
                reason = "one_profile_set_unavailable"
            else:
                status = "ready"
                reason = ""
        return {
            "enabled": enabled,
            "status": status,
            "reason": reason or None,
            "trusted_identity_available": self.can_identify(),
            "speaker_profiles_path": session_path or None,
            "wake_speaker_profiles_path": wake_path or None,
            "speaker_profile_count": profile_count,
            "wake_speaker_profile_count": wake_profile_count,
            "missing_paths": missing_paths,
        }

    def _ensure_engine(self, for_training: bool = False):
        engine = getattr(self, "_engine", None)
        if engine is not None:
            return engine
        # A house trains its first voice before it has any profile.
        if not self._enabled or SpeakerRecognition is None:
            return None
        if not for_training and not self._profiles and not self._wake_profiles:
            return None
        if getattr(self, "_engine_state", "not_loaded") == "failed":
            return None
        engine_lock = getattr(self, "_engine_lock", None)
        if engine_lock is None:
            engine_lock = threading.Lock()
            self._engine_lock = engine_lock
        with engine_lock:
            engine = getattr(self, "_engine", None)
            if engine is not None:
                return engine
            if getattr(self, "_engine_state", "not_loaded") == "failed":
                return None
            self._engine_state = "loading"
            try:
                with prefer_ipv4():
                    engine = SpeakerRecognition.from_hparams(
                        source="speechbrain/spkrec-ecapa-voxceleb",
                        savedir=self._model_cache_dir,
                    )
                if engine is None:
                    raise RuntimeError("speaker recognition model returned no engine")
            except Exception as err:
                self._engine_state = "failed"
                log(f"speaker recognition model unavailable: {err}")
                return None
            self._engine = engine
            self._engine_state = "ready"
            return engine

    def warmup(self) -> None:
        self._ensure_engine()

    def _embed(self, audio_bytes: bytes, for_training: bool = False):
        """The voiceprint of up to SPEAKER_ID_MAX_VOICED_SECONDS of voice, or None."""
        if not self._enabled or np is None or torch is None:
            return None
        if not audio_bytes or len(audio_bytes) < self._min_bytes:
            return None
        scored_audio = extract_voiced_audio(audio_bytes)
        if len(scored_audio) < max(FRAME_BYTES * 4, self._min_bytes):
            scored_audio = audio_bytes
        scored_audio = scored_audio[: int(SPEAKER_ID_MAX_VOICED_SECONDS * SAMPLE_RATE * SAMPLE_WIDTH)]
        engine = self._ensure_engine(for_training)
        if engine is None:
            return None
        waveform = np.frombuffer(scored_audio, dtype=np.int16).astype(np.float32) / 32768.0
        signal = torch.from_numpy(waveform).unsqueeze(0)
        try:
            with torch.no_grad():
                return engine.encode_batch(signal).detach().cpu().numpy().reshape(-1)
        except Exception as err:
            log(f"speaker identification failed: {err}")
            return None

    def trained_person_ids(self) -> list[str]:
        """The household people who have a voice profile now."""
        ids = {speaker.lower(): pid for speaker, pid in speaker_person_ids().items()}
        names = set(getattr(self, "_profiles", {}) or {}) | set(getattr(self, "_wake_profiles", {}) or {})
        return sorted({ids[base] for base in (name.split("@", 1)[0].strip().lower() for name in names) if base in ids})

    def train_person(self, person_id: str, name: str, takes: list[bytes], progress=lambda _share: None) -> int:
        """Voice training: the takes' mean voiceprint becomes this person's only profile in
        both sets (any older one, "@show" and the like included, goes), copy first; reloaded at once.
        Returns how many takes were used."""
        if not self._enabled:
            raise RuntimeError("speaker identification is off")
        if self._ensure_engine(for_training=True) is None:
            raise RuntimeError("the voice model could not load")
        embeddings = []
        for index, take in enumerate(takes):
            embedding = self._embed(take, for_training=True)
            if embedding is not None:
                embeddings.append(embedding)
            progress(0.9 * (index + 1) / max(1, len(takes)))
        if len(embeddings) < 3:
            raise RuntimeError("too few clear takes")
        record = {"name": name, "person_id": person_id, "clip_count": len(embeddings),
                  "embedding": np.mean(np.stack(embeddings), axis=0).astype(np.float32).tolist(), "trained": "page"}
        for path in (self._profiles_path, self._wake_profiles_path):
            replace_person_profile(normalize_user_runtime_path(path), person_id, name, record)
        self._profiles = self._load_profiles()
        self._wake_profiles = self._load_profiles(self._wake_profiles_path)
        progress(1.0)
        return len(embeddings)

    def _best_match(self, embedding, profiles: dict[str, np.ndarray]) -> tuple[str, float]:
        best_name = ""
        best_score = 0.0
        for name, reference in profiles.items():
            score = cosine_similarity(embedding, reference)
            if score > best_score:
                best_name = name
                best_score = score
        if best_score >= self._threshold:
            return speaker_of_reference(best_name), best_score
        return "", best_score

    def _identify_against_profiles(self, audio_bytes: bytes, profiles: dict[str, np.ndarray]) -> tuple[str, float]:
        if not profiles:
            return "", 0.0
        embedding = self._embed(audio_bytes)
        if embedding is None:
            return "", 0.0
        return self._best_match(embedding, profiles)

    def identify_turn(self, audio_bytes: bytes) -> tuple[str, float, object]:
        """A turn's match against the session profiles, with its voiceprint for identify_voiceprints."""
        if not self._profiles:
            return "", 0.0, None
        embedding = self._embed(audio_bytes)
        if embedding is None:
            return "", 0.0, None
        name, score = self._best_match(embedding, self._profiles)
        return name, score, embedding

    def identify_voiceprints(self, voiceprints: list) -> tuple[str, float]:
        """The match for several turns' voiceprints together: their mean, each counted alike."""
        if not voiceprints or not self._profiles or np is None:
            return "", 0.0
        unit = [v / max(float(np.linalg.norm(v)), 1e-9) for v in voiceprints]
        return self._best_match(np.mean(np.stack(unit), axis=0), self._profiles)

    def identify(self, audio_bytes: bytes, source: str = "session") -> tuple[str, float]:
        normalized_source = str(source or "session").strip().lower()
        if normalized_source.startswith("wake") and self._wake_profiles:
            # A wake is matched against every reference: the wake-word ones (voice host/terminal "Hey Housemate")
            # and each person's session ones, a speaker's far-field "Sam@show", "Alex@show", "Riley@show"
            # among them: the wake set alone holds only the wake-word references, which score far-field
            # voices low.
            references = {**self._profiles, **{f"{name}@wake": ref for name, ref in self._wake_profiles.items()}}
            return self._identify_against_profiles(audio_bytes, references)
        return self._identify_against_profiles(audio_bytes, self._profiles)


def parse_speaker_flux_eot_thresholds(raw) -> dict:
    """{"Alex": 0.9}: each named speaker's Flux end-of-turn threshold, within what Flux takes."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for name, value in raw.items():
        person = speaker_of_reference(str(name or ""))
        try:
            threshold = float(value)
        except (TypeError, ValueError):
            continue
        if person:
            out[person] = max(0.5, min(0.9, threshold))
    return out


def speaker_of_reference(name: str) -> str:
    """A person may have several references, one per kind of microphone: "Sam" from the voice host and
    terminal, "Sam@show" from a speaker's far-field mics. Each is its own averaged voice, so
    one mic's sound does not drag the other's; the best match names the person."""
    return str(name or "").split("@", 1)[0].strip()


@dataclasses.dataclass
class SpeakerIdentityState:
    default_name: str
    name: str = ""
    score: float = 0.0
    sources: set[str] = dataclasses.field(default_factory=set)

    def reset(self) -> None:
        self.name = ""
        self.score = 0.0
        self.sources.clear()

    def active_name(self) -> str:
        return self.name or self.default_name or DEFAULT_GREETING_SPEAKER

    def observe(self, source: str, speaker: str, score: float) -> str:
        source = str(source or "unknown").strip() or "unknown"
        speaker = str(speaker or "").strip()
        score = max(0.0, float(score or 0.0))
        if not speaker:
            if self.name:
                log(f"speaker identity unchanged after {source}: {self.name} score={self.score:.3f}")
            return self.active_name()
        if not self.name:
            self.name = speaker
            self.score = score
            self.sources = {source}
            log(f"session speaker set from {source}: {self.name} score={self.score:.3f}")
            return self.active_name()
        if speaker == self.name:
            self.score = max(self.score, score)
            self.sources.add(source)
            log(f"session speaker confirmed by {source}: {self.name} score={score:.3f}")
            return self.active_name()
        if score > self.score:
            old_name = self.name
            old_score = self.score
            self.name = speaker
            self.score = score
            self.sources = {source}
            log(
                "session speaker corrected by "
                f"{source}: {old_name} score={old_score:.3f} -> {self.name} score={self.score:.3f}"
            )
        else:
            log(
                "speaker candidate ignored from "
                f"{source}: {speaker} score={score:.3f}; active={self.name} score={self.score:.3f}"
            )
        return self.active_name()


class TurnCapture:
    def __init__(
        self,
        silence_seconds: float,
        pre_roll_ms: int,
        session_idle_seconds: float,
        vad_mode: int,
        start_trigger_frames: int,
        speech_reset_frames: int,
        max_turn_seconds: float,
        hard_max_turn_seconds: float = DEFAULT_HARD_MAX_TURN_SECONDS,
    ):
        self._vad = webrtcvad.Vad(max(0, min(3, int(vad_mode))))
        self._silence_frames = max(1, int(round((silence_seconds * 1000) / FRAME_MS)))
        self._pre_roll_frames = max(0, int(round(pre_roll_ms / FRAME_MS)))
        self._session_idle_frames = max(1, int(round((session_idle_seconds * 1000) / FRAME_MS)))
        self._start_trigger_frames = max(1, int(start_trigger_frames))
        self._speech_reset_frames = max(1, int(speech_reset_frames))
        # Soft cap: past it, the next short pause ends the turn; _max_frames is the hard ceiling.
        self._soft_max_frames = max(self._silence_frames, int(round(max_turn_seconds * 1000 / FRAME_MS)))
        self._max_frames = max(self._soft_max_frames, int(round(hard_max_turn_seconds * 1000 / FRAME_MS)))
        self._soft_cap_pause_frames = max(1, int(round(SOFT_CAP_PAUSE_MS / FRAME_MS)))

    def capture(
        self,
        audio: AudioInput,
        event_spotter=None,
        stop_events: tuple[str, ...] = (),
        frame_observer=None,
    ) -> tuple[bytes, str | None]:
        pre_roll = collections.deque(maxlen=self._pre_roll_frames)
        frames: list[bytes] = []
        speech_started = False
        silence_run = 0
        speech_run = 0
        idle_frames = 0
        stop_events = tuple(str(event or "").strip() for event in stop_events if str(event or "").strip())
        if event_spotter and hasattr(event_spotter, "reset"):
            event_spotter.reset()

        while True:
            frame = audio.read_frame()
            event = None
            if event_spotter:
                event = event_spotter.feed(frame)
                if event and event in stop_events:
                    return b"".join(frames), event
            is_speech = self._vad.is_speech(frame, SAMPLE_RATE)
            if not speech_started:
                idle_frames += 1
                pre_roll.append(frame)
                if is_speech:
                    speech_run += 1
                else:
                    speech_run = 0
                if speech_run < self._start_trigger_frames:
                    if idle_frames >= self._session_idle_frames:
                        log("session idle timeout hit before speech start")
                        return b"", None
                    continue
                speech_started = True
                frames.extend(pre_roll)
                if frame_observer and pre_roll:
                    frame_observer(b"".join(pre_roll))
                pre_roll.clear()
                silence_run = 0
                speech_run = self._start_trigger_frames
                continue

            frames.append(frame)
            if frame_observer:
                frame_observer(frame)
            if len(frames) >= self._max_frames:
                log("turn capture hit max length; forcing utterance boundary")
                break
            if is_speech:
                speech_run += 1
                if speech_run >= self._speech_reset_frames:
                    silence_run = 0
                continue

            speech_run = 0
            silence_run += 1
            if silence_run >= self._silence_frames or (
                len(frames) >= self._soft_max_frames and silence_run >= self._soft_cap_pause_frames
            ):
                if silence_run:
                    frames = frames[:-silence_run]
                break

        return b"".join(frames), None

    def capture_after_speech_start(
        self,
        audio: AudioInput,
        leading_frames: list[bytes] | tuple[bytes, ...],
        event_spotter=None,
        stop_events: tuple[str, ...] = (),
        frame_observer=None,
    ) -> tuple[bytes, str | None]:
        frames = list(leading_frames or [])
        silence_run = 0
        speech_run = 0
        stop_events = tuple(str(event or "").strip() for event in stop_events if str(event or "").strip())
        if frame_observer and frames:
            frame_observer(b"".join(frames))

        for frame in frames:
            if self._vad.is_speech(frame, SAMPLE_RATE):
                speech_run += 1
                if speech_run >= self._speech_reset_frames:
                    silence_run = 0
            else:
                speech_run = 0
                silence_run += 1

        while True:
            frame = audio.read_frame()
            event = None
            if event_spotter:
                event = event_spotter.feed(frame)
                if event and event in stop_events:
                    return b"".join(frames), event
            frames.append(frame)
            if frame_observer:
                frame_observer(frame)
            if len(frames) >= self._max_frames:
                log("turn capture hit max length; forcing utterance boundary")
                break
            if self._vad.is_speech(frame, SAMPLE_RATE):
                speech_run += 1
                if speech_run >= self._speech_reset_frames:
                    silence_run = 0
                continue

            speech_run = 0
            silence_run += 1
            if silence_run >= self._silence_frames or (
                len(frames) >= self._soft_max_frames and silence_run >= self._soft_cap_pause_frames
            ):
                if silence_run:
                    frames = frames[:-silence_run]
                break

        return b"".join(frames), None


class BufferedSttSession:
    """A batch engine (local Whisper, Home Assistant's speech-to-text) as a live session: the audio
    is kept and transcribed whole when the turn ends. The end of the turn comes from silence
    detection (the endpoint, or HA's own for Assist), not from the engine."""

    def __init__(self, transcribe):
        self._transcribe = transcribe
        self._audio = bytearray()
        self._lock = threading.Lock()

    def feed_audio(self, audio_bytes: bytes) -> None:
        with self._lock:
            self._audio.extend(audio_bytes or b"")

    def finish(self) -> str:
        with self._lock:
            audio = bytes(self._audio)
        return self._transcribe(audio) if audio else ""

    def close(self) -> None:
        return None


class ElevenLabsStreamingSession:
    def __init__(
        self,
        *,
        url: str,
        api_key: str,
        timeout_seconds: float,
        sample_rate: int = SAMPLE_RATE,
    ):
        self._url = url
        self._api_key = api_key
        self._timeout_seconds = max(1.0, float(timeout_seconds))
        self._sample_rate = max(8000, int(sample_rate or SAMPLE_RATE))
        self._buffer = bytearray()
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._commit_requested = threading.Event()
        self._done_event = threading.Event()
        self._partial_text = ""
        self._committed_texts: list[str] = []
        self._error: str | None = None
        self._commit_sent = False
        self._commit_started_at = 0.0
        self._thread = threading.Thread(target=self._run, name="elevenlabs-stt-stream", daemon=True)
        self._thread.start()

    def feed_audio(self, audio_bytes: bytes) -> None:
        payload = bytes(audio_bytes or b"")
        if not payload or self._stop_event.is_set():
            return
        with self._lock:
            self._buffer.extend(payload)

    def finish(self) -> str:
        self._commit_requested.set()
        wait_seconds = self._timeout_seconds + 2.0
        if not self._done_event.wait(timeout=wait_seconds):
            self.close()
            raise RuntimeError("ElevenLabs streaming STT timed out waiting for committed transcript")
        if self._error:
            raise RuntimeError(self._error)
        text = " ".join(" ".join(self._committed_texts).split()).strip()
        if text:
            return text
        return " ".join(str(self._partial_text or "").split())

    def close(self) -> None:
        self._stop_event.set()
        self._thread.join(timeout=1.0)

    def _take_send_chunk(self) -> tuple[bytes, bool]:
        with self._lock:
            if self._commit_requested.is_set():
                if not self._buffer:
                    return b"", False
                chunk = bytes(self._buffer)
                self._buffer.clear()
                self._commit_sent = True
                self._commit_started_at = time.monotonic()
                return chunk, True
            available = len(self._buffer) - ELEVENLABS_STREAM_COMMIT_HOLD_BYTES
            if available < ELEVENLABS_STREAM_CHUNK_BYTES:
                return b"", False
            send_len = min(available, ELEVENLABS_STREAM_CHUNK_BYTES)
            chunk = bytes(self._buffer[:send_len])
            del self._buffer[:send_len]
            return chunk, False

    def _handle_event(self, event: dict) -> None:
        message_type = str(event.get("message_type") or "").strip()
        lower_type = message_type.lower()
        if message_type == "partial_transcript":
            self._partial_text = str(event.get("text") or "").strip()
            return
        if message_type in {"committed_transcript", "committed_transcript_with_timestamps"}:
            text = str(event.get("text") or "").strip()
            if text:
                self._committed_texts.append(text)
            self._done_event.set()
            self._stop_event.set()
            return
        if lower_type.startswith("scribe") and "error" in lower_type:
            detail = event.get("message") or event.get("error") or event
            raise RuntimeError(f"ElevenLabs {message_type}: {detail}")

    def _recv_loop(self, ws) -> None:
        timeout_error = getattr(websocket, "WebSocketTimeoutException", None) if websocket is not None else None
        try:
            message = ws.recv()
        except Exception as err:
            if timeout_error and isinstance(err, timeout_error):
                return
            raise
        if not message:
            return
        self._handle_event(json.loads(message))

    def _run(self) -> None:
        ws = None
        try:
            ws = websocket.create_connection(
                self._url,
                header=[f"xi-api-key: {self._api_key}"],
                timeout=self._timeout_seconds,
            )
            ws.settimeout(0.2)
            while not self._stop_event.is_set():
                chunk, commit = self._take_send_chunk()
                if chunk:
                    payload = {
                        "message_type": "input_audio_chunk",
                        "audio_base_64": base64.b64encode(chunk).decode("ascii"),
                        "sample_rate": self._sample_rate,
                    }
                    if commit:
                        payload["commit"] = True
                    ws.send(json.dumps(payload, separators=(",", ":")))
                self._recv_loop(ws)
                if self._done_event.is_set():
                    break
                if self._commit_sent and self._commit_started_at > 0.0 and (time.monotonic() - self._commit_started_at) >= self._timeout_seconds:
                    raise RuntimeError("ElevenLabs streaming STT timed out after commit")
                if not chunk:
                    time.sleep(0.01)
            if self._commit_requested.is_set() and not self._done_event.is_set() and self._commit_sent:
                deadline = time.monotonic() + self._timeout_seconds
                while time.monotonic() < deadline and not self._done_event.is_set():
                    self._recv_loop(ws)
        except Exception as err:
            self._error = str(err)
        finally:
            self._done_event.set()
            with contextlib.suppress(Exception):
                if ws is not None:
                    ws.close()


class DeepgramStreamingSession:
    """Feed raw turn PCM to Deepgram while the speaker is still talking."""

    CHUNK_BYTES = DEEPGRAM_STREAM_CHUNK_BYTES
    PROVIDER = "Deepgram"

    def __init__(
        self,
        *,
        url: str,
        api_key: str,
        timeout_seconds: float,
        warm_connection=None,
    ):
        self._url = str(url or "").strip()
        self._api_key = str(api_key or "").strip()
        self._timeout_seconds = max(1.0, float(timeout_seconds))
        self._warm_connection = warm_connection
        self._buffer = bytearray()
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._finalize_requested = threading.Event()
        self._done_event = threading.Event()
        self._final_transcripts: list[str] = []
        self._partial_text = ""
        self._error: str | None = None
        self._finalize_sent_at = 0.0
        self._thread = threading.Thread(target=self._run, name="deepgram-stt-stream", daemon=True)
        self._thread.start()

    def feed_audio(self, audio_bytes: bytes) -> None:
        payload = bytes(audio_bytes or b"")
        if not payload or self._stop_event.is_set():
            return
        with self._lock:
            self._buffer.extend(payload)

    def finish(self) -> str:
        self._finalize_requested.set()
        if not self._done_event.wait(timeout=self._timeout_seconds + 2.0):
            self.close()
            raise RuntimeError("Deepgram streaming STT timed out waiting for final transcript")
        self._thread.join(timeout=1.0)
        if self._error:
            raise RuntimeError(self._error)
        text = " ".join(" ".join(self._final_transcripts).split()).strip()
        return text or " ".join(self._partial_text.split())

    def close(self) -> None:
        self._stop_event.set()
        self._thread.join(timeout=1.0)

    def _take_send_chunk(self) -> bytes:
        with self._lock:
            if not self._buffer:
                return b""
            send_len = min(len(self._buffer), self.CHUNK_BYTES)
            chunk = bytes(self._buffer[:send_len])
            del self._buffer[:send_len]
            return chunk

    def _buffer_empty(self) -> bool:
        with self._lock:
            return not self._buffer

    def _handle_event(self, event: dict) -> None:
        event_type = str(event.get("type") or "").strip()
        if event_type == "Results":
            try:
                alternatives = event.get("channel", {}).get("alternatives", [])
                transcript = str(alternatives[0].get("transcript") or "").strip() if alternatives else ""
            except (AttributeError, TypeError):
                transcript = ""
            if bool(event.get("is_final")):
                if transcript:
                    self._final_transcripts.append(transcript)
            elif transcript:
                self._partial_text = transcript
            # from_finalize is not an end marker: Deepgram sets it on the
            # results processed so far while earlier-sent audio is still
            # queued, which truncated or emptied wake-attached turns.
            return
        if event_type == "Metadata" and self._finalize_sent_at > 0.0:
            # CloseStream flushes every queued result before Metadata.
            self._finish_stream()
            return
        if event_type == "Error":
            detail = event.get("description") or event.get("message") or event
            raise RuntimeError(f"Deepgram {event_type}: {detail}")

    def _finish_stream(self) -> None:
        self._done_event.set()
        self._stop_event.set()

    def _recv_once(self, ws) -> None:
        timeout_error = getattr(websocket, "WebSocketTimeoutException", None) if websocket is not None else None
        closed_error = getattr(websocket, "WebSocketConnectionClosedException", None) if websocket is not None else None
        try:
            # websocket-client uses one socket timeout for both reads and
            # writes. Keep the tiny value scoped to this receive poll so a
            # slow network write cannot abort the live transcript stream.
            ws.settimeout(0.01)
            message = ws.recv()
        except Exception as err:
            if timeout_error and isinstance(err, timeout_error):
                return
            if self._finalize_sent_at > 0.0 and closed_error and isinstance(err, closed_error):
                self._finish_stream()
                return
            raise
        finally:
            with contextlib.suppress(Exception):
                ws.settimeout(self._timeout_seconds)
        if message:
            self._handle_event(json.loads(message))
        elif self._finalize_sent_at > 0.0:
            # Server close frame after CloseStream.
            self._finish_stream()

    def _connect(self):
        ws, self._warm_connection = self._warm_connection, None
        if ws is not None:
            try:
                ws.settimeout(self._timeout_seconds)
                self._probe_warm_connection(ws)
                return ws
            except Exception as err:
                log(f"deepgram warm socket unusable; connecting fresh: {err}")
                with contextlib.suppress(Exception):
                    ws.close()
        return websocket.create_connection(
            self._url,
            header=[f"Authorization: Token {self._api_key}"],
            timeout=self._timeout_seconds,
        )

    def _probe_warm_connection(self, ws) -> None:
        ws.send(json.dumps({"type": "KeepAlive"}, separators=(",", ":")))

    def _send_chunk(self, ws, chunk: bytes) -> None:
        send_binary = getattr(ws, "send_binary", None)
        if callable(send_binary):
            send_binary(chunk)
        else:
            ws.send(chunk, opcode=websocket.ABNF.OPCODE_BINARY)

    def _close_stream_message(self) -> str:
        return json.dumps({"type": "CloseStream"}, separators=(",", ":"))

    def _send_finalize(self, ws) -> None:
        ws.send(self._close_stream_message())
        self._finalize_sent_at = time.monotonic()

    def _run(self) -> None:
        ws = None
        try:
            ws = self._connect()
            while not self._stop_event.is_set():
                chunk = self._take_send_chunk()
                if chunk:
                    self._send_chunk(ws, chunk)
                if self._finalize_requested.is_set() and self._buffer_empty() and self._finalize_sent_at <= 0.0:
                    self._send_finalize(ws)
                    if self._stop_event.is_set():
                        break
                self._recv_once(ws)
                if self._finalize_sent_at > 0.0 and (time.monotonic() - self._finalize_sent_at) >= self._timeout_seconds:
                    raise RuntimeError(f"{self.PROVIDER} streaming STT timed out after finalize")
                if not chunk:
                    time.sleep(0.01)
        except Exception as err:
            self._error = str(err)
        finally:
            self._done_event.set()
            with contextlib.suppress(Exception):
                if ws is not None:
                    if self._finalize_sent_at <= 0.0:
                        ws.send(self._close_stream_message())
                    ws.close()


class DeepgramFluxSession(DeepgramStreamingSession):
    """Stream turn PCM to Deepgram Flux and report its model-based end of turn.

    Flux ends a turn from what was said instead of a fixed silence wait (corpus
    clip: EndOfTurn +0.65 s after speech end vs the terminal's 1.5 s). One
    stream can hold several Flux turns; the transcript joins them in order.
    Flux only accepts CloseStream, ForceEndTurn and Configure: JSON KeepAlive
    closes the socket, so warm sockets are probed with a WebSocket ping, and
    CloseStream alone drops an unfinished turn, so ForceEndTurn goes first.
    """

    CHUNK_BYTES = DEEPGRAM_FLUX_CHUNK_BYTES

    def __init__(self, *, end_of_turn_callback=None, interim_callback=None, **kwargs):
        self._end_of_turn_callback = end_of_turn_callback
        self._interim_callback = interim_callback
        self._ended_turns: dict[int, str] = {}
        self._open_turns: dict[int, str] = {}
        self._sent_bytes = 0
        self._processed_seconds = 0.0
        self._client_told_turn_ended = False
        super().__init__(**kwargs)

    def finish(self) -> str:
        self._finalize_requested.set()
        if not self._done_event.wait(timeout=self._timeout_seconds + 2.0):
            self.close()
            raise RuntimeError("Deepgram Flux timed out waiting for the end of turn")
        if self._error:
            raise RuntimeError(self._error)
        return self.transcript()

    def close(self) -> None:
        # The worker closes its own socket; waiting on the close handshake
        # would put up to a second back into the reply path.
        self._stop_event.set()

    def transcript(self) -> str:
        texts = [self._ended_turns[index] for index in sorted(self._ended_turns)]
        texts.extend(self._open_turns[index] for index in sorted(self._open_turns))
        return " ".join(" ".join(texts).split())

    def _probe_warm_connection(self, ws) -> None:
        ws.ping()

    def _send_chunk(self, ws, chunk: bytes) -> None:
        super()._send_chunk(ws, chunk)
        self._sent_bytes += len(chunk)

    def _caught_up_after_end_of_turn(self) -> bool:
        if not self._ended_turns or any(self._open_turns.values()):
            return False
        if self._client_told_turn_ended:
            # Audio after that is only the client's reaction time; waiting
            # for Flux to work through it cost ~0.4 s per turn.
            return True
        sent_seconds = self._sent_bytes / float(SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS)
        return self._processed_seconds >= sent_seconds - DEEPGRAM_FLUX_CAUGHT_UP_SECONDS

    def _send_finalize(self, ws) -> None:
        if self._caught_up_after_end_of_turn():
            # Turn already ended and nothing new was said since.
            self._finish_stream()
            return
        ws.send(json.dumps({"type": "ForceEndTurn"}, separators=(",", ":")))
        super()._send_finalize(ws)

    def _handle_event(self, event: dict) -> None:
        event_type = str(event.get("type") or "").strip()
        if event_type == "Error":
            detail = event.get("description") or event.get("message") or event
            raise RuntimeError(f"Deepgram Flux error: {detail}")
        if event_type != "TurnInfo":
            return
        try:
            index = int(event.get("turn_index") or 0)
            self._processed_seconds = max(self._processed_seconds, float(event.get("audio_window_end") or 0.0))
        except (TypeError, ValueError):
            index = 0
        transcript = " ".join(str(event.get("transcript") or "").split())
        if str(event.get("event") or "") != "EndOfTurn":
            if transcript:
                self._open_turns[index] = transcript
                interim = self._interim_callback
                if callable(interim):
                    try:
                        interim(self.transcript())
                    except Exception as err:
                        log(f"deepgram flux interim callback failed: {err}")
            return
        self._open_turns.pop(index, None)
        if not transcript:
            return
        self._ended_turns[index] = transcript
        callback = self._end_of_turn_callback
        if callable(callback) and not self._finalize_requested.is_set():
            try:
                if callback(self.transcript()):
                    self._client_told_turn_ended = True
            except Exception as err:
                log(f"deepgram flux end-of-turn callback failed: {err}")


class DeepgramWarmSocket:
    """Hold one idle Deepgram socket so a turn skips the ~1.1 s connect.

    A fresh connect per turn let that second of audio queue behind the
    handshake, and Deepgram then ran the whole turn that far behind: wake
    turns finished 1.6-2.0 s after upload close instead of ~0.6 s. Idle
    KeepAlive time carries no audio, and Deepgram bills streamed audio.
    """

    def __init__(
        self,
        *,
        url: str,
        api_key: str,
        timeout_seconds: float,
        keepalive_seconds: float = DEEPGRAM_WARM_KEEPALIVE_SECONDS,
        max_age_seconds: float = DEEPGRAM_WARM_MAX_AGE_SECONDS,
        ping_keepalive: bool = False,
    ):
        self._url = str(url or "").strip()
        self._api_key = str(api_key or "").strip()
        self._timeout_seconds = max(1.0, float(timeout_seconds))
        self._keepalive_seconds = max(0.5, float(keepalive_seconds))
        self._max_age_seconds = max(self._keepalive_seconds, float(max_age_seconds))
        self._ping_keepalive = bool(ping_keepalive)
        self._lock = threading.Lock()
        self._ws = None
        self._opened_at = 0.0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="deepgram-warm-socket", daemon=True)
        self._thread.start()

    def take(self):
        with self._lock:
            ws, self._ws = self._ws, None
        self._wake.set()
        return ws

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=1.0)
        self._drop(self.take())

    @staticmethod
    def _drop(ws) -> None:
        if ws is not None:
            with contextlib.suppress(Exception):
                ws.close()

    def _run(self) -> None:
        failures = 0
        while not self._stop.is_set():
            wait_seconds = self._keepalive_seconds
            with self._lock:
                ws = self._ws
                expired = ws is not None and time.monotonic() - self._opened_at >= self._max_age_seconds
                if ws is not None and not expired:
                    try:
                        if self._ping_keepalive:
                            ws.ping()
                        else:
                            ws.send(json.dumps({"type": "KeepAlive"}, separators=(",", ":")))
                    except Exception:
                        self._ws, expired = None, True
            if expired:
                self._drop(ws)
                with self._lock:
                    if self._ws is ws:
                        self._ws = None
                ws = None
            if ws is None:
                try:
                    fresh = websocket.create_connection(
                        self._url,
                        header=[f"Authorization: Token {self._api_key}"],
                        timeout=self._timeout_seconds,
                    )
                except Exception as err:
                    failures += 1
                    wait_seconds = min(60.0, 2.0 ** failures)
                    if failures == 1 or failures % 10 == 0:
                        log(f"deepgram warm socket connect failed ({failures}): {err}")
                else:
                    failures = 0
                    with self._lock:
                        self._ws, self._opened_at = fresh, time.monotonic()
                    if self._stop.is_set():
                        self._drop(self.take())
            self._wake.wait(wait_seconds)
            self._wake.clear()


def parse_inworld_voice_profile(raw, top_n: int = INWORLD_VOICE_PROFILE_MAX_TOP_N) -> dict | None:
    """Bound Inworld's voiceProfile to known labels and finite confidences.

    Returns None when there is no profile. Raises ValueError on a malformed
    one so the caller drops the whole profile rather than a guessed half.
    Unknown labels and categories are dropped. The result is acoustic hints
    for model context only: never identity, safety, action or memory evidence.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("voiceProfile is not an object")
    limit = max(1, min(INWORLD_VOICE_PROFILE_MAX_TOP_N, int(top_n)))
    profile: dict[str, list[dict]] = {}
    for category, allowed in INWORLD_VOICE_PROFILE_LABELS.items():
        entries = raw.get(category)
        if entries is None:
            continue
        if not isinstance(entries, list):
            raise ValueError(f"voiceProfile.{category} is not a list")
        kept = []
        for entry in entries[:32]:
            if not isinstance(entry, dict):
                raise ValueError(f"voiceProfile.{category} entry is not an object")
            label = entry.get("label")
            confidence = entry.get("confidence")
            if not isinstance(label, str) or isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
                raise ValueError(f"voiceProfile.{category} entry has a bad label or confidence")
            confidence = float(confidence)
            if not math.isfinite(confidence) or confidence < 0.0 or confidence > 1.0:
                raise ValueError(f"voiceProfile.{category} confidence out of range")
            label = label.strip()
            known = INWORLD_ACCENT_PATTERN.match(label) if allowed is None else label in allowed
            if known:
                kept.append({"label": label, "confidence": round(confidence, 3)})
        kept.sort(key=lambda item: item["confidence"], reverse=True)
        if kept:
            profile[category] = kept[:limit]
    return profile or None


def summarize_inworld_voice_profile(profile: dict | None) -> str:
    if not profile:
        return "none"
    return " ".join(
        f"{category}={profile[category][0]['label']}:{profile[category][0]['confidence']:.2f}"
        for category in INWORLD_VOICE_PROFILE_LABELS
        if profile.get(category)
    )


class InworldStreamingSession(DeepgramStreamingSession):
    """Stream turn PCM to Inworld STT-1 and keep each final's voice profile.

    Disabled unless `stt_backend` is `inworld`. Audio goes up as base64 JSON
    `audioChunk`s after one `transcribeConfig`; `closeStream` flushes pending
    audio and the server answers with any last final, then `usage`. Each
    final ends one detected turn and is the only result whose voice profile is
    kept: interim profiles may still change, finals without words have
    nothing to describe, and anything after `usage` belongs to no turn. When
    one upload holds several finals, `voice_profile` returns None because no
    single profile describes the whole turn; `segments` keeps each one.
    """

    CHUNK_BYTES = INWORLD_STREAM_CHUNK_BYTES
    PROVIDER = "Inworld"

    def __init__(self, *, transcribe_config: dict, voice_profile_top_n: int = 3, **kwargs):
        self._transcribe_config = dict(transcribe_config)
        self._voice_profile_top_n = voice_profile_top_n
        self._segments: list[dict] = []
        self._rejected_profiles = 0
        self._usage_ms: int | None = None
        self._started_at = time.monotonic()
        self._heard_from_server = False
        self._audio_square_sum = 0.0
        self._audio_samples = 0
        super().__init__(**kwargs)

    def feed_audio(self, audio_bytes: bytes) -> None:
        payload = bytes(audio_bytes or b"")
        if payload and not self._stop_event.is_set():
            samples = memoryview(payload[: len(payload) - len(payload) % 2]).cast("h")
            self._audio_square_sum += sum(float(sample) * float(sample) for sample in samples)
            self._audio_samples += len(samples)
        super().feed_audio(payload)

    def _turn_was_silent(self) -> bool:
        if self._audio_samples <= 0:
            return True
        return math.sqrt(self._audio_square_sum / self._audio_samples) <= INWORLD_SILENT_TURN_MAX_RMS

    def _recv_once(self, ws) -> None:
        super()._recv_once(ws)
        if (
            not self._heard_from_server
            and not self._done_event.is_set()
            and self._finalize_sent_at > 0.0
            and time.monotonic() - self._finalize_sent_at >= INWORLD_SILENT_TURN_GRACE_SECONDS
            and self._turn_was_silent()
        ):
            log("stt inworld silent turn: no server events; ending empty")
            self._finish_stream()

    def finish(self) -> str:
        self._finalize_requested.set()
        if not self._done_event.wait(timeout=self._timeout_seconds + 2.0):
            self.close()
            raise RuntimeError("Inworld STT timed out waiting for final transcript")
        self._thread.join(timeout=1.0)
        if self._error:
            raise RuntimeError(self._error)
        return self.transcript()

    def transcript(self) -> str:
        text = " ".join(" ".join(segment["transcript"] for segment in self._segments).split())
        return text or " ".join(self._partial_text.split())

    @property
    def segments(self) -> list[dict]:
        return [dict(segment) for segment in self._segments]

    @property
    def voice_profile(self) -> dict | None:
        if len(self._segments) != 1:
            return None
        return self._segments[0]["voice_profile"]

    @property
    def rejected_profiles(self) -> int:
        return self._rejected_profiles

    @property
    def usage_ms(self) -> int | None:
        return self._usage_ms

    def voice_profile_log(self) -> str:
        return (
            f"stt inworld voice_profile segments={len(self._segments)} "
            f"rejected={self._rejected_profiles} usage_ms={self._usage_ms} "
            f"profile={summarize_inworld_voice_profile(self.voice_profile)}"
        )

    def _connect(self):
        ws = websocket.create_connection(
            self._url,
            # The portal key is already base64 credentials; send it verbatim.
            header=[f"Authorization: Basic {self._api_key}"],
            timeout=self._timeout_seconds,
        )
        ws.send(json.dumps({"transcribeConfig": self._transcribe_config}, separators=(",", ":")))
        return ws

    def _send_chunk(self, ws, chunk: bytes) -> None:
        ws.send(json.dumps(
            {"audioChunk": {"content": base64.b64encode(chunk).decode("ascii")}},
            separators=(",", ":"),
        ))

    def _close_stream_message(self) -> str:
        return json.dumps({"closeStream": {}}, separators=(",", ":"))

    def _handle_event(self, event) -> None:
        if not isinstance(event, dict):
            return
        self._heard_from_server = True
        error = event.get("error")
        if error is not None:
            detail = error.get("message") if isinstance(error, dict) else error
            code = error.get("code") if isinstance(error, dict) else None
            raise RuntimeError(f"Inworld STT error {code}: {detail}")
        result = event.get("result")
        if not isinstance(result, dict) or self._usage_ms is not None:
            return
        usage = result.get("usage")
        if isinstance(usage, dict):
            try:
                self._usage_ms = max(0, int(usage.get("transcribedAudioMs") or 0))
            except (TypeError, ValueError):
                self._usage_ms = 0
            if self._finalize_sent_at > 0.0:
                self._finish_stream()
            return
        transcription = result.get("transcription")
        if not isinstance(transcription, dict):
            return
        text = " ".join(str(transcription.get("transcript") or "").split())
        if transcription.get("isFinal") is not True:
            self._partial_text = text
            return
        self._partial_text = ""
        if not text:
            return
        try:
            profile = parse_inworld_voice_profile(transcription.get("voiceProfile"), self._voice_profile_top_n)
        except (ValueError, TypeError) as err:
            self._rejected_profiles += 1
            log(f"inworld voice profile rejected: {err}")
            profile = None
        self._segments.append({
            "index": len(self._segments),
            "transcript": text,
            "voice_profile": profile,
            "final_ms": int(round((time.monotonic() - self._started_at) * 1000)),
        })


class SttEngine:
    def __init__(
        self,
        model_name: str,
        fast_model_name: str,
        phrase_variants: dict,
        fast_command_max_words: int,
        backend: str,
        deepgram_api_key: str,
        deepgram_model: str,
        deepgram_language: str,
        deepgram_timeout_seconds: float,
        elevenlabs_api_key: str = "",
        elevenlabs_model_id: str = "scribe_v2_realtime",
        elevenlabs_language_code: str = "en",
        elevenlabs_realtime_url: str = "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
        elevenlabs_audio_format: str = "pcm_16000",
        elevenlabs_commit_strategy: str = "manual",
        elevenlabs_vad_silence_threshold_secs: float = 1.5,
        elevenlabs_vad_threshold: float = 0.4,
        elevenlabs_min_speech_duration_ms: int = 100,
        elevenlabs_min_silence_duration_ms: int = 100,
        elevenlabs_no_verbatim: bool = False,
        elevenlabs_enable_logging: bool = True,
        elevenlabs_include_timestamps: bool = False,
        elevenlabs_include_language_detection: bool = False,
        elevenlabs_keyterms: list[str] | None = None,
        elevenlabs_timeout_seconds: float = 15.0,
        deepgram_endpointing_ms: int = 300,
        deepgram_keyterms: list[str] | None = None,
        deepgram_end_of_turn: str = "silence",
        deepgram_flux_model: str = DEFAULT_DEEPGRAM_FLUX_MODEL,
        deepgram_flux_eot_threshold: float = DEFAULT_DEEPGRAM_FLUX_EOT_THRESHOLD,
        deepgram_flux_warm_socket: bool = True,
        inworld_api_key: str = "",
        inworld_model: str = DEFAULT_INWORLD_STT_MODEL,
        inworld_language: str = "en",
        inworld_url: str = DEFAULT_INWORLD_STT_URL,
        inworld_timeout_seconds: float = 15.0,
        inworld_keyterms: list[str] | None = None,
        inworld_eot_threshold: float = DEFAULT_INWORLD_EOT_THRESHOLD,
        inworld_voice_profile: bool = True,
        inworld_voice_profile_top_n: int = 3,
        ha_stt_entity: str = "",
        ha_stt_language: str = "en",
    ):
        self._ha_api = None
        self._ha_stt_entity = str(ha_stt_entity or "").strip()
        self._ha_stt_language = str(ha_stt_language or "en").strip() or "en"
        self._model_name = model_name
        self._fast_model_name = fast_model_name if fast_model_name and fast_model_name != model_name else ""
        self._phrase_variants = phrase_variants
        self._fast_command_max_words = max(1, int(fast_command_max_words))
        self._backend = backend
        self._deepgram_api_key = deepgram_api_key
        self._deepgram_model = deepgram_model
        self._deepgram_language = deepgram_language or "en-AU"
        self._deepgram_timeout_seconds = max(1.0, float(deepgram_timeout_seconds))
        self._deepgram_endpointing_ms = max(10, min(2000, int(deepgram_endpointing_ms)))
        self._deepgram_keyterms = list(default_keyterms() if deepgram_keyterms is None else deepgram_keyterms)[:20]
        self._deepgram_end_of_turn = normalize_deepgram_end_of_turn(deepgram_end_of_turn)
        self._deepgram_flux_model = str(deepgram_flux_model or "").strip() or DEFAULT_DEEPGRAM_FLUX_MODEL
        self._deepgram_flux_eot_threshold = max(0.5, min(0.9, float(deepgram_flux_eot_threshold)))
        self._deepgram_flux_warm_socket = bool(deepgram_flux_warm_socket)
        self._deepgram_warm_socket = None
        self._inworld_api_key = str(inworld_api_key or "").strip()
        self._inworld_model = str(inworld_model or "").strip() or DEFAULT_INWORLD_STT_MODEL
        self._inworld_language = str(inworld_language or "").strip() or "en"
        self._inworld_url = str(inworld_url or "").strip() or DEFAULT_INWORLD_STT_URL
        self._inworld_timeout_seconds = max(1.0, float(inworld_timeout_seconds))
        self._inworld_keyterms = list(default_keyterms() if inworld_keyterms is None else inworld_keyterms)[:50]
        self._inworld_eot_threshold = max(0.0, min(1.0, float(inworld_eot_threshold)))
        self._inworld_voice_profile = bool(inworld_voice_profile)
        self._inworld_voice_profile_top_n = max(1, min(INWORLD_VOICE_PROFILE_MAX_TOP_N, int(inworld_voice_profile_top_n)))
        self._elevenlabs_api_key = elevenlabs_api_key
        self._elevenlabs_model_id = elevenlabs_model_id or "scribe_v2_realtime"
        self._elevenlabs_language_code = elevenlabs_language_code or "en"
        self._elevenlabs_realtime_url = elevenlabs_realtime_url or "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
        self._elevenlabs_audio_format = elevenlabs_audio_format or "pcm_16000"
        self._elevenlabs_commit_strategy = elevenlabs_commit_strategy if elevenlabs_commit_strategy in {"manual", "vad"} else "manual"
        self._elevenlabs_vad_silence_threshold_secs = min(3.0, max(0.3, float(elevenlabs_vad_silence_threshold_secs)))
        self._elevenlabs_vad_threshold = min(0.9, max(0.1, float(elevenlabs_vad_threshold)))
        self._elevenlabs_min_speech_duration_ms = min(2000, max(50, int(elevenlabs_min_speech_duration_ms)))
        self._elevenlabs_min_silence_duration_ms = min(2000, max(50, int(elevenlabs_min_silence_duration_ms)))
        self._elevenlabs_no_verbatim = bool(elevenlabs_no_verbatim)
        self._elevenlabs_enable_logging = bool(elevenlabs_enable_logging)
        self._elevenlabs_include_timestamps = bool(elevenlabs_include_timestamps)
        self._elevenlabs_include_language_detection = bool(elevenlabs_include_language_detection)
        self._elevenlabs_keyterms = list(elevenlabs_keyterms or [])[:50]
        self._elevenlabs_timeout_seconds = max(1.0, float(elevenlabs_timeout_seconds))
        self._model = None
        self._fast_model = None

        if self._backend == "deepgram" and self._deepgram_api_key:
            log(
                f"STT backend set to Deepgram model={self._deepgram_model} "
                f"end_of_turn={self._deepgram_end_of_turn}"
                + (f" flux_model={self._deepgram_flux_model}" if self._uses_deepgram_flux() else "")
            )
            self._ensure_fast_model()
        elif self._uses_inworld():
            log(
                f"STT backend set to Inworld model={self._inworld_model} "
                f"voice_profile={self._inworld_voice_profile}"
            )
            self._ensure_fast_model()
        elif self._backend == "elevenlabs" and self._elevenlabs_api_key:
            log(
                "STT backend set to ElevenLabs "
                f"model={self._elevenlabs_model_id} language={self._elevenlabs_language_code}"
            )
            self._ensure_fast_model()
        elif self._uses_home_assistant():
            log(f"STT backend set to Home Assistant entity={self._ha_stt_entity} language={self._ha_stt_language}")
            self._ensure_fast_model()
        else:
            self._ensure_local_models()

    def set_home_assistant(self, api) -> None:
        """api is the HomeAssistantStatePublisher (its api_request reaches HA's REST API)."""
        self._ha_api = api

    def _uses_home_assistant(self) -> bool:
        return self._backend == "home_assistant" and bool(self._ha_stt_entity)

    def prewarm_live_sessions(self) -> None:
        self._take_warm_deepgram_socket(start_only=True)

    @property
    def live_end_of_turn(self) -> bool:
        """True when live sessions report the end of turn before upload close."""
        return websocket is not None and self._uses_deepgram_flux()

    def _uses_deepgram_flux(self) -> bool:
        return self._backend == "deepgram" and bool(self._deepgram_api_key) and self._deepgram_end_of_turn == "flux"

    def _uses_inworld(self) -> bool:
        return self._backend == "inworld" and bool(self._inworld_api_key)

    def _inworld_transcribe_config(self) -> dict:
        config = {
            "modelId": self._inworld_model,
            "audioEncoding": "LINEAR16",
            "sampleRateHertz": SAMPLE_RATE,
            "numberOfChannels": CHANNELS,
            "language": self._inworld_language,
            "endOfTurnConfidenceThreshold": self._inworld_eot_threshold,
        }
        if self._inworld_keyterms:
            config["prompts"] = list(self._inworld_keyterms)
        if self._inworld_voice_profile:
            config["voiceProfileConfig"] = {
                "enableVoiceProfile": True,
                "topN": self._inworld_voice_profile_top_n,
            }
        return config

    def _start_inworld_session(self) -> "InworldStreamingSession":
        return InworldStreamingSession(
            url=self._inworld_url,
            api_key=self._inworld_api_key,
            timeout_seconds=self._inworld_timeout_seconds,
            transcribe_config=self._inworld_transcribe_config(),
            voice_profile_top_n=self._inworld_voice_profile_top_n,
        )

    def _take_warm_deepgram_socket(self, *, start_only: bool = False):
        if websocket is None or self._backend != "deepgram" or not self._deepgram_api_key:
            return None
        flux = self._uses_deepgram_flux()
        if flux and not self._deepgram_flux_warm_socket:
            return None
        if self._deepgram_warm_socket is None:
            self._deepgram_warm_socket = DeepgramWarmSocket(
                url=self._build_deepgram_flux_url() if flux else self._build_deepgram_realtime_url(),
                api_key=self._deepgram_api_key,
                timeout_seconds=self._deepgram_timeout_seconds,
                ping_keepalive=flux,
            )
            return None
        return None if start_only else self._deepgram_warm_socket.take()

    def start_live_session(self, end_of_turn_callback=None, interim_callback=None, eot_threshold=None):
        """interim_callback, when the backend has interim transcripts (Flux), gets the text so far.
        eot_threshold is a speaker's own Flux end-of-turn threshold; the warm socket was opened with
        the house one, so a different threshold opens its own.
        A batch engine (Home Assistant's, local Whisper) gets a BufferedSttSession."""
        if self._uses_home_assistant() or self._backend in {"local", "whisper"}:
            return BufferedSttSession(self.transcribe_bytes)
        if websocket is None:
            return None
        if self._uses_deepgram_flux():
            own = eot_threshold is not None and abs(float(eot_threshold) - self._deepgram_flux_eot_threshold) > 1e-6
            return DeepgramFluxSession(
                url=self._build_deepgram_flux_url(eot_threshold if own else None),
                api_key=self._deepgram_api_key,
                timeout_seconds=self._deepgram_timeout_seconds,
                warm_connection=None if own else self._take_warm_deepgram_socket(),
                end_of_turn_callback=end_of_turn_callback,
                interim_callback=interim_callback,
            )
        if self._backend == "deepgram" and self._deepgram_api_key:
            return DeepgramStreamingSession(
                url=self._build_deepgram_realtime_url(),
                api_key=self._deepgram_api_key,
                timeout_seconds=self._deepgram_timeout_seconds,
                warm_connection=self._take_warm_deepgram_socket(),
            )
        if self._uses_inworld():
            return self._start_inworld_session()
        if self._backend == "elevenlabs" and self._elevenlabs_api_key:
            return ElevenLabsStreamingSession(
                url=self._build_elevenlabs_realtime_url(),
                api_key=self._elevenlabs_api_key,
                timeout_seconds=self._elevenlabs_timeout_seconds,
                sample_rate=SAMPLE_RATE,
            )
        return None

    def transcribe_bytes(self, audio_bytes: bytes, fast_only: bool = False, live_session=None) -> str:
        if not fast_only and live_session is not None:
            try:
                started = time.monotonic()
                streaming_text = live_session.finish()
                streaming_ms = int(round((time.monotonic() - started) * 1000))
                log(
                    f"stt {self._backend} streaming completed "
                    f"latency_ms={streaming_ms} text={streaming_text}"
                )
                profile_log = getattr(live_session, "voice_profile_log", None)
                if callable(profile_log):
                    log(profile_log())
                if streaming_text:
                    return streaming_text
                raise RuntimeError(f"{self._backend} streaming STT returned no transcript")
            except Exception as err:
                log(f"{self._backend} streaming stt failed; falling back to batch transcription: {err}")
            finally:
                with contextlib.suppress(Exception):
                    live_session.close()

        if not fast_only and self._uses_home_assistant():
            try:
                started = time.monotonic()
                ha_text = self._transcribe_with_home_assistant(audio_bytes)
                ha_ms = int(round((time.monotonic() - started) * 1000))
                log(f"stt home_assistant completed entity={self._ha_stt_entity} latency_ms={ha_ms} text={ha_text}")
                return ha_text
            except Exception as err:
                log(f"home assistant stt failed; falling back to local whisper: {err}")

        if not fast_only and self._backend == "deepgram" and self._deepgram_api_key:
            try:
                started = time.monotonic()
                deepgram_text = self._transcribe_with_deepgram(audio_bytes)
                deepgram_ms = int(round((time.monotonic() - started) * 1000))
                log(
                    f"stt deepgram completed model={self._deepgram_model} "
                    f"latency_ms={deepgram_ms} text={deepgram_text}"
                )
                return deepgram_text
            except Exception as err:
                log(f"deepgram stt failed; falling back to local whisper: {err}")

        if not fast_only and self._uses_inworld():
            try:
                started = time.monotonic()
                inworld_text = self._transcribe_with_inworld(audio_bytes)
                inworld_ms = int(round((time.monotonic() - started) * 1000))
                log(
                    f"stt inworld completed model={self._inworld_model} "
                    f"latency_ms={inworld_ms} text={inworld_text}"
                )
                return inworld_text
            except Exception as err:
                log(f"inworld stt failed; falling back to local whisper: {err}")

        if not fast_only and self._backend == "elevenlabs" and self._elevenlabs_api_key:
            try:
                started = time.monotonic()
                elevenlabs_text = self._transcribe_with_elevenlabs(audio_bytes)
                elevenlabs_ms = int(round((time.monotonic() - started) * 1000))
                log(
                    f"stt elevenlabs completed model={self._elevenlabs_model_id} "
                    f"latency_ms={elevenlabs_ms} text={elevenlabs_text}"
                )
                return elevenlabs_text
            except Exception as err:
                log(f"elevenlabs stt failed; falling back to local whisper: {err}")

        if fast_only:
            self._ensure_fast_model()
        else:
            self._ensure_fast_model()
            self._ensure_base_model()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            tmp_path = handle.name
        try:
            with wave.open(tmp_path, "wb") as wav_handle:
                wav_handle.setnchannels(CHANNELS)
                wav_handle.setsampwidth(SAMPLE_WIDTH)
                wav_handle.setframerate(SAMPLE_RATE)
                wav_handle.writeframes(audio_bytes)
            fast_text = ""
            fast_ms = None
            if self._fast_model:
                fast_started = time.monotonic()
                fast_text = self._transcribe_with_model(self._fast_model, tmp_path)
                fast_ms = int(round((time.monotonic() - fast_started) * 1000))
                if fast_only:
                    log(f"stt fast-only completed model={self._fast_model_name} latency_ms={fast_ms} text={fast_text}")
                    return fast_text
                if is_wake_only_text(fast_text, self._phrase_variants):
                    log(f"stt fast-path selected wake-only model={self._fast_model_name} latency_ms={fast_ms} text={fast_text}")
                    return fast_text
                if looks_like_short_fast_turn(fast_text, self._phrase_variants, self._fast_command_max_words):
                    log(f"stt fast-path selected model={self._fast_model_name} latency_ms={fast_ms} text={fast_text}")
                    return fast_text

            base_started = time.monotonic()
            base_text = self._transcribe_with_model(self._model, tmp_path)
            base_ms = int(round((time.monotonic() - base_started) * 1000))
            selected = base_text or fast_text
            if fast_ms is None:
                log(f"stt completed model={self._model_name} latency_ms={base_ms} text={selected}")
            else:
                log(
                    "stt completed "
                    f"fast_model={self._fast_model_name} fast_ms={fast_ms} "
                    f"base_model={self._model_name} base_ms={base_ms} "
                    f"selected={selected}"
                )
            return selected
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(tmp_path)

    def _ensure_local_models(self) -> None:
        self._ensure_fast_model()
        self._ensure_base_model()

    def _ensure_base_model(self) -> None:
        if self._model is None:
            log(f"loading STT model {self._model_name}")
            self._model = WhisperModel(self._model_name, device="cpu", compute_type="int8")

    def _ensure_fast_model(self) -> None:
        if self._fast_model_name and self._fast_model is None:
            log(f"loading fast STT model {self._fast_model_name}")
            self._fast_model = WhisperModel(self._fast_model_name, device="cpu", compute_type="int8")

    def _transcribe_with_model(self, model: WhisperModel, tmp_path: str) -> str:
        segments, _info = model.transcribe(
            tmp_path,
            language="en",
            beam_size=1,
            best_of=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return " ".join(text.split())

    def _transcribe_with_deepgram(self, audio_bytes: bytes) -> str:
        wav_bytes = self._build_wav_bytes(audio_bytes)
        query = urllib.parse.urlencode(self._with_deepgram_keyterms({
            "model": self._deepgram_model,
            "language": self._deepgram_language,
            "smart_format": "true",
        }))
        request = urllib.request.Request(
            f"https://api.deepgram.com/v1/listen?{query}",
            data=wav_bytes,
            headers={
                "Authorization": f"Token {self._deepgram_api_key}",
                "Content-Type": "audio/wav",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._deepgram_timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return self._extract_deepgram_transcript(payload)

    def _transcribe_with_home_assistant(self, audio_bytes: bytes) -> str:
        """HA's speech-to-text REST API takes the turn as raw 16 kHz mono PCM, as its Assist
        pipeline streams it."""
        if self._ha_api is None:
            raise RuntimeError("Home Assistant API is not connected")
        metadata = (
            f"format=wav; codec=pcm; sample_rate={SAMPLE_RATE}; bit_rate={SAMPLE_WIDTH * 8}; "
            f"channel={CHANNELS}; language={self._ha_stt_language}"
        )
        body = self._ha_api.api_request(
            "POST",
            f"stt/{self._ha_stt_entity}",
            body=bytes(audio_bytes),
            headers={"X-Speech-Content": metadata, "Content-Type": "application/octet-stream"},
            timeout=self._deepgram_timeout_seconds,
        )
        payload = json.loads(body.decode("utf-8") or "{}")
        if payload.get("result") != "success":
            raise RuntimeError(f"Home Assistant stt result {payload.get('result')!r}")
        return " ".join(str(payload.get("text") or "").split())

    def _transcribe_with_inworld(self, audio_bytes: bytes) -> str:
        if websocket is None:
            raise RuntimeError("websocket-client package is required for Inworld STT")
        session = self._start_inworld_session()
        try:
            session.feed_audio(audio_bytes)
            text = session.finish()
            log(session.voice_profile_log())
            return text
        finally:
            session.close()

    def _transcribe_with_elevenlabs(self, audio_bytes: bytes) -> str:
        if websocket is None:
            raise RuntimeError("websocket-client package is required for ElevenLabs realtime STT")
        if self._elevenlabs_audio_format != "pcm_16000":
            raise RuntimeError(f"unsupported ElevenLabs audio format: {self._elevenlabs_audio_format}")

        url = self._build_elevenlabs_realtime_url()
        ws = websocket.create_connection(
            url,
            header=[f"xi-api-key: {self._elevenlabs_api_key}"],
            timeout=self._elevenlabs_timeout_seconds,
        )
        committed_texts: list[str] = []
        partial_text = ""
        try:
            ws.settimeout(self._elevenlabs_timeout_seconds)
            payload = {
                "message_type": "input_audio_chunk",
                "audio_base_64": base64.b64encode(audio_bytes).decode("ascii"),
                "commit": True,
                "sample_rate": SAMPLE_RATE,
            }
            ws.send(json.dumps(payload, separators=(",", ":")))
            deadline = time.monotonic() + self._elevenlabs_timeout_seconds
            while time.monotonic() < deadline:
                try:
                    message = ws.recv()
                except Exception:
                    if committed_texts or partial_text:
                        break
                    raise
                if not message:
                    continue
                event = json.loads(message)
                message_type = str(event.get("message_type") or "").strip()
                lower_type = message_type.lower()
                if message_type == "partial_transcript":
                    partial_text = str(event.get("text") or "").strip()
                    continue
                if message_type in {"committed_transcript", "committed_transcript_with_timestamps"}:
                    text = str(event.get("text") or "").strip()
                    if text:
                        committed_texts.append(text)
                        break
                    continue
                if lower_type.startswith("scribe") and "error" in lower_type:
                    detail = event.get("message") or event.get("error") or event
                    raise RuntimeError(f"ElevenLabs {message_type}: {detail}")
            text = " ".join(" ".join(committed_texts).split())
            if text:
                return text
            return " ".join(partial_text.split())
        finally:
            with contextlib.suppress(Exception):
                ws.close()

    def _build_elevenlabs_realtime_url(self) -> str:
        params = {
            "model_id": self._elevenlabs_model_id,
            "audio_format": self._elevenlabs_audio_format,
            "language_code": self._elevenlabs_language_code,
            "commit_strategy": self._elevenlabs_commit_strategy,
            "vad_silence_threshold_secs": self._elevenlabs_vad_silence_threshold_secs,
            "vad_threshold": self._elevenlabs_vad_threshold,
            "min_speech_duration_ms": self._elevenlabs_min_speech_duration_ms,
            "min_silence_duration_ms": self._elevenlabs_min_silence_duration_ms,
            "no_verbatim": str(self._elevenlabs_no_verbatim).lower(),
            "enable_logging": str(self._elevenlabs_enable_logging).lower(),
            "include_timestamps": str(self._elevenlabs_include_timestamps).lower(),
            "include_language_detection": str(self._elevenlabs_include_language_detection).lower(),
        }
        query_items: list[tuple[str, str]] = [(key, str(value)) for key, value in params.items()]
        query_items.extend(("keyterms", keyterm[:20]) for keyterm in self._elevenlabs_keyterms)
        separator = "&" if "?" in self._elevenlabs_realtime_url else "?"
        return f"{self._elevenlabs_realtime_url}{separator}{urllib.parse.urlencode(query_items)}"

    def _build_deepgram_realtime_url(self) -> str:
        query = urllib.parse.urlencode(self._with_deepgram_keyterms({
            "model": self._deepgram_model,
            "language": self._deepgram_language,
            "encoding": "linear16",
            "sample_rate": SAMPLE_RATE,
            "channels": CHANNELS,
            "smart_format": "true",
            "interim_results": "true",
            "endpointing": str(self._deepgram_endpointing_ms),
        }))
        return f"wss://api.deepgram.com/v1/listen?{query}"

    def _build_deepgram_flux_url(self, eot_threshold=None) -> str:
        threshold = self._deepgram_flux_eot_threshold if eot_threshold is None else max(0.5, min(0.9, float(eot_threshold)))
        items = [
            ("model", self._deepgram_flux_model),
            ("encoding", "linear16"),
            ("sample_rate", str(SAMPLE_RATE)),
            ("eot_threshold", f"{threshold:g}"),
        ]
        items.extend(("keyterm", keyterm) for keyterm in self._deepgram_keyterms)
        return f"wss://api.deepgram.com/v2/listen?{urllib.parse.urlencode(items)}"

    def _with_deepgram_keyterms(self, params: dict) -> list[tuple[str, str]]:
        # Keyterm prompting keeps the wake name from fusing into the command
        # ("Housemate, what's" -> "Swats") at the start of wake-attached turns.
        items = [(key, str(value)) for key, value in params.items()]
        if self._deepgram_model.startswith("nova-3"):
            items.extend(("keyterm", keyterm) for keyterm in self._deepgram_keyterms)
        return items

    def _build_wav_bytes(self, audio_bytes: bytes) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_handle:
            wav_handle.setnchannels(CHANNELS)
            wav_handle.setsampwidth(SAMPLE_WIDTH)
            wav_handle.setframerate(SAMPLE_RATE)
            wav_handle.writeframes(audio_bytes)
        return buffer.getvalue()

    def _extract_deepgram_transcript(self, payload: dict) -> str:
        try:
            channels = payload["results"]["channels"]
            alternatives = channels[0]["alternatives"]
            transcript = alternatives[0].get("transcript", "")
        except (KeyError, IndexError, TypeError) as err:
            raise RuntimeError(f"unexpected Deepgram response shape: {err}") from err
        return " ".join(str(transcript).split())


class TtsEngine:
    def __init__(
        self,
        device: str,
        voice: str,
        speed: int,
        pitch: int,
        fish_audio_enabled: bool = False,
        fish_audio_api_key: str = "",
        fish_audio_voice_id: str = "",
        fish_audio_model: str = "s2-pro",
        fish_audio_latency: str = "balanced",
        fish_audio_sample_rate: int = FISH_AUDIO_SAMPLE_RATE,
        fish_tts_speed: float = 1.0,
        fish_tts_volume_db: float = 0.0,
        fish_tts_temperature: float = 0.82,
        fish_tts_top_p: float = 0.88,
        fish_tts_chunk_length: int = 180,
        fish_tts_repetition_penalty: float = 1.15,
        fish_tts_condition_on_previous_chunks: bool = True,
        fish_tts_tone_enabled: bool = True,
        fish_tts_comma_breaks: bool = False,
        fish_tts_tone_tags: dict | None = None,
        fish_tts_night_enabled: bool = True,
        fish_tts_night_start: str = DEFAULT_FISH_TTS_NIGHT_START,
        fish_tts_night_end: str = DEFAULT_FISH_TTS_NIGHT_END,
        fish_tts_night_volume_db: float = DEFAULT_FISH_TTS_NIGHT_VOLUME_DB,
        fish_tts_night_speed: float = DEFAULT_FISH_TTS_NIGHT_SPEED,
        ha_tts_entity: str = "",
    ):
        self._ha_api = None
        self._ha_tts_entity = str(ha_tts_entity or "").strip()
        self._device = device
        self._voice = voice
        self._speed = speed
        self._pitch = pitch
        self._fish_ready = False
        self._fish_client = None
        self._fish_api_key = str(fish_audio_api_key or "").strip()
        self._fish_voice_id = str(fish_audio_voice_id or "").strip()
        self._fish_model = str(fish_audio_model or "s2-pro").strip() or "s2-pro"
        self._fish_latency = str(fish_audio_latency or "balanced").strip() or "balanced"
        self._fish_sample_rate = max(8000, int(fish_audio_sample_rate or FISH_AUDIO_SAMPLE_RATE))
        self._fish_tts_speed = max(0.5, min(2.0, float(fish_tts_speed or 1.0)))
        self._fish_tts_volume_db = max(-20.0, min(20.0, float(fish_tts_volume_db or 0.0)))
        self._fish_tts_temperature = max(0.0, min(1.0, float(fish_tts_temperature)))
        self._fish_tts_top_p = max(0.0, min(1.0, float(fish_tts_top_p)))
        self._fish_tts_chunk_length = max(100, min(300, int(fish_tts_chunk_length)))
        self._fish_tts_repetition_penalty = max(0.1, float(fish_tts_repetition_penalty))
        self._fish_tts_condition_on_previous_chunks = bool(fish_tts_condition_on_previous_chunks)
        self._fish_stream_config = None
        self._playback_event_callback = None
        self._playback_audio_tap = None
        self._fish_worker_proc = None
        self._fish_worker_conn = None
        self._fish_worker_ready = False
        self._fish_worker_lock = threading.Lock()
        self._fish_tone_enabled = bool(fish_tts_tone_enabled)
        self._fish_comma_breaks = bool(fish_tts_comma_breaks)
        self._fish_tone_tags = normalize_fish_tone_tags(fish_tts_tone_tags)
        self._fish_night_enabled = bool(fish_tts_night_enabled)
        self._fish_night_start = parse_clock_minutes(fish_tts_night_start, DEFAULT_FISH_TTS_NIGHT_START)
        self._fish_night_end = parse_clock_minutes(fish_tts_night_end, DEFAULT_FISH_TTS_NIGHT_END)
        self._fish_night_volume_db = max(-20.0, min(20.0, float(fish_tts_night_volume_db)))
        self._fish_night_speed = max(0.5, min(2.0, float(fish_tts_night_speed or 1.0)))
        self._clock = lambda: datetime.now(LOCAL_GREETING_TIMEZONE)

        if fish_audio_enabled:
            if FishAudio is None or TTSConfig is None or Prosody is None:
                log("Fish Audio requested but SDK is unavailable; falling back to espeak")
            elif not self._fish_api_key or not self._fish_voice_id:
                log("Fish Audio requested but API key or voice id is missing; falling back to espeak")
            else:
                self._fish_client = FishAudio(api_key=self._fish_api_key)
                self._fish_stream_config = build_fish_stream_config(
                    sample_rate=self._fish_sample_rate,
                    latency=self._fish_latency,
                    chunk_length=self._fish_tts_chunk_length,
                    speed=self._fish_tts_speed,
                    volume_db=self._fish_tts_volume_db,
                    top_p=self._fish_tts_top_p,
                    temperature=self._fish_tts_temperature,
                    repetition_penalty=self._fish_tts_repetition_penalty,
                    condition_on_previous_chunks=self._fish_tts_condition_on_previous_chunks,
                )
                self._fish_ready = True
                self._launch_fish_stream_worker()
                log(
                    "Fish Audio streaming enabled "
                    f"({self._fish_model}, {self._fish_latency}, {self._fish_sample_rate}Hz)"
                )

    def set_playback_event_callback(self, callback) -> None:
        self._playback_event_callback = callback

    def set_home_assistant(self, api) -> None:
        """api is the HomeAssistantStatePublisher (its api_request reaches HA's REST API)."""
        self._ha_api = api

    def set_playback_audio_tap(self, tap) -> None:
        self._playback_audio_tap = tap

    def _emit_playback_event(self, event_type: str, **fields) -> None:
        callback = getattr(self, "_playback_event_callback", None)
        if not callback:
            return
        try:
            callback(event_type, **fields)
        except Exception:
            pass

    def _emit_fish_request_event(
        self,
        spoken: str,
        phase: str = "",
        prepared: bool = False,
        tone: str = "",
        tone_tag: str = "",
    ) -> None:
        payload = {
            "phase": str(phase or "").strip() or None,
            "utterance": spoken,
            "prepared": bool(prepared),
        }
        if tone:
            payload["tone"] = tone
        if tone_tag:
            payload["tone_tag"] = tone_tag
        if self.night_quiet_now():
            payload["night_quiet"] = True
        self._emit_playback_event("fish_tts_request", **payload)

    def _tag_fish_text(self, text: str, phase: str = "", tone: object = "", kind: str = "") -> tuple[str, str]:
        """Returns the Fish text and the one tag added for the assistant's tone, if any.
        No tone, neutral, or tone switched off means no tag. Every Fish path comes through here."""
        spoken = str(text or "")
        if getattr(self, "_fish_comma_breaks", False):
            spoken = fish_comma_breaks(spoken)
        if not getattr(self, "_fish_tone_enabled", False):
            return spoken, ""
        return apply_fish_tone(spoken, tone, getattr(self, "_fish_tone_tags", {}), kind=kind, phase=phase)

    def night_quiet_now(self) -> bool:
        if not getattr(self, "_fish_night_enabled", False):
            return False
        return night_quiet_active(self._clock(), self._fish_night_start, self._fish_night_end)

    def speak(self, text: str, speech: dict | None = None, phase: str = "") -> None:
        self._speak_internal(text, speech=speech, phase=phase)

    def start_progressive_speech(
        self,
        phase: str = "progressive_reply",
        turn_complete_at: float | None = None,
        output_start_callback=None,
        output_chunk_callback=None,
        output_close_callback=None,
    ) -> "ProgressiveTtsSession":
        if not self._fish_ready or not self._fish_client or not self._fish_stream_config:
            raise RuntimeError("Fish Audio progressive streaming is unavailable")
        return ProgressiveTtsSession(
            self,
            phase=phase,
            turn_complete_at=turn_complete_at,
            output_start_callback=output_start_callback,
            output_chunk_callback=output_chunk_callback,
            output_close_callback=output_close_callback,
        )

    def speak_with_local_fallback(
        self,
        text: str,
        local_fallback_text: str,
        speech: dict | None = None,
        phase: str = "",
    ) -> None:
        self._speak_internal(
            text,
            speech=speech,
            phase=phase,
            startup_fallback_text=local_fallback_text,
        )

    def _speak_internal(
        self,
        text: str,
        speech: dict | None = None,
        phase: str = "",
        startup_fallback_text: str = "",
    ) -> None:
        spoken = str(text or "").strip()
        if not spoken:
            return
        fallback_spoken = str(startup_fallback_text or "").strip()
        voice_override = self._normalize_fish_voice_override(speech)
        fish_spoken = self._normalize_fish_text_override(speech) or spoken
        tone = speech.get("tone") if isinstance(speech, dict) else ""
        fish_spoken, tone_tag = self._tag_fish_text(fish_spoken, phase=phase, tone=tone)
        fish_config = self._normalize_fish_config_override(speech)
        if self._fish_ready:
            try:
                self._emit_fish_request_event(fish_spoken, phase=phase, prepared=False, tone=str(tone or ""), tone_tag=tone_tag)
                self._speak_with_fish(fish_spoken, voice_override=voice_override, config_override=fish_config, phase=phase)
                return
            except TTSPlaybackError as err:
                if err.partial_audio:
                    self._emit_playback_event(
                        "tts_playback_failed",
                        backend="fish",
                        fallback_backend=None,
                        phase=str(phase or "").strip() or None,
                        utterance=fish_spoken,
                        reason=str(err),
                    )
                    log(f"Fish Audio streaming failed after audio started; skipping native fallback: {err}")
                    return
                if err.startup_timeout and fallback_spoken:
                    self._emit_playback_event(
                        "tts_fallback",
                        backend="fish",
                        fallback_backend="espeak",
                        phase=str(phase or "").strip() or None,
                        utterance=fish_spoken,
                        reason="fish_startup_timeout",
                    )
                    log(f"Fish Audio timed out before audio started; using local fallback: {err}")
                    self._speak_with_espeak(fallback_spoken, phase=phase)
                    return
                self._emit_playback_event(
                    "tts_fallback",
                    backend="fish",
                    fallback_backend="espeak",
                    phase=str(phase or "").strip() or None,
                    utterance=fish_spoken,
                    reason=str(err),
                )
                log(f"Fish Audio streaming failed before audio started; falling back to espeak: {err}")
            except Exception as err:
                self._emit_playback_event(
                    "tts_fallback",
                    backend="fish",
                    fallback_backend="espeak",
                    phase=str(phase or "").strip() or None,
                    utterance=fish_spoken,
                    reason=str(err),
                )
                log(f"Fish Audio streaming failed; falling back to espeak: {err}")
        self._speak_with_espeak(spoken, phase=phase)

    def prepare_speech(self, text: str, speech: dict | None = None, phase: str = "") -> PreparedSpeech:
        spoken = str(text or "").strip()
        if not spoken:
            raise ValueError("speech text is empty")
        voice_override = self._normalize_fish_voice_override(speech)
        fish_spoken = self._normalize_fish_text_override(speech) or spoken
        tone = speech.get("tone") if isinstance(speech, dict) else ""
        fish_spoken, tone_tag = self._tag_fish_text(fish_spoken, phase=phase, tone=tone)
        fish_config = self._normalize_fish_config_override(speech)
        if self._fish_ready:
            try:
                self._emit_fish_request_event(fish_spoken, phase=phase, prepared=True, tone=str(tone or ""), tone_tag=tone_tag)
                return self._prepare_with_fish(
                    fish_spoken,
                    voice_override=voice_override,
                    config_override=fish_config,
                    phase=phase,
                )
            except Exception as err:
                self._emit_playback_event(
                    "tts_fallback",
                    backend="fish_prepared",
                    fallback_backend="espeak",
                    phase=str(phase or "").strip() or None,
                    utterance=fish_spoken,
                    reason=str(err),
                )
                log(f"Fish Audio preparation failed; falling back to espeak: {err}")
        return self._prepare_without_fish(spoken, phase=phase)

    def cached_speech_available(self, text: str, speech: dict | None = None, phase: str = "") -> bool:
        """True when this exact Fish request is already on disk."""
        try:
            return self.prepare_cached_speech(text, speech=speech, phase=phase, cache_only=True, emit=False) is not None
        except Exception:
            return False

    def prepare_cached_speech(
        self,
        text: str,
        speech: dict | None = None,
        phase: str = "",
        cache_only: bool = False,
        emit: bool = True,
    ) -> PreparedSpeech | None:
        """Fixed lines render once through Fish and replay from disk. The key is
        the whole Fish request except the API key, so a new voice, model, tone
        tag, night pace or wording renders afresh. Anything else falls back to
        prepare_speech, and a failed cache never blocks speech. cache_only
        returns None on a miss instead of rendering."""
        spoken = str(text or "").strip()
        if not spoken:
            raise ValueError("speech text is empty")
        if not getattr(self, "_fish_ready", False) or not self._fish_client or not self._fish_stream_config:
            if cache_only:
                return None
            return self.prepare_speech(text, speech=speech, phase=phase)
        try:
            fish_spoken = self._normalize_fish_text_override(speech) or spoken
            tone = speech.get("tone") if isinstance(speech, dict) else ""
            fish_spoken, _tone_tag = self._tag_fish_text(fish_spoken, phase=phase, tone=tone)
            request = self._build_fish_stream_request(
                fish_spoken,
                voice_override=self._normalize_fish_voice_override(speech),
                config_override=self._normalize_fish_config_override(speech),
            )
            cache_path = self._speech_cache_path(request)
            if os.path.isfile(cache_path):
                if cache_only and not emit:
                    return PreparedSpeech(
                        path=cache_path,
                        backend="fish_cached",
                        utterance=fish_spoken,
                        phase=phase,
                        sample_rate=int(request["sample_rate"]),
                        raw_pcm=True,
                    )
                handle = tempfile.NamedTemporaryFile(suffix=".raw", delete=False)
                with handle, open(cache_path, "rb") as cached:
                    shutil.copyfileobj(cached, handle)
                self._emit_playback_event(
                    "tts_cache_hit",
                    backend="fish_cached",
                    phase=str(phase or "").strip() or None,
                    utterance=fish_spoken,
                )
                return PreparedSpeech(
                    path=handle.name,
                    backend="fish_cached",
                    utterance=fish_spoken,
                    phase=phase,
                    sample_rate=int(request["sample_rate"]),
                    raw_pcm=True,
                )
        except Exception as err:
            if cache_only:
                return None
            log(f"speech cache lookup failed; rendering live: {err}")
            return self.prepare_speech(text, speech=speech, phase=phase)
        if cache_only:
            return None
        prepared = self.prepare_speech(text, speech=speech, phase=phase)
        if prepared.backend == "fish_prepared":
            try:
                self._store_cached_speech(cache_path, prepared.path)
            except Exception as err:
                log(f"speech cache store failed: {err}")
        return prepared

    def warm_speech_cache(
        self,
        lines: list[str],
        speech: dict | None = None,
        phase: str = "",
        pause_seconds: float = SPEECH_CACHE_WARM_PAUSE_SECONDS,
    ) -> int:
        """Renders any line not cached yet, one at a time with a pause so live
        speech is never starved. A failed line is retried once; three failed
        lines in a row means Fish is down, so warm-up stops and later wakes
        render on demand. Returns how many lines were rendered."""
        rendered = 0
        failures_in_row = 0
        for line in lines:
            backend = ""
            for attempt in range(2):
                if attempt:
                    time.sleep(pause_seconds * 3)
                try:
                    prepared = self.prepare_cached_speech(line, speech=speech, phase=phase)
                except Exception as err:
                    log(f"speech cache warm-up failed for {line!r}: {err}")
                    continue
                backend = prepared.backend
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(prepared.path)
                if backend in {"fish_prepared", "fish_cached"}:
                    break
            if backend == "fish_cached":
                failures_in_row = 0
                continue
            if backend == "fish_prepared":
                rendered += 1
                failures_in_row = 0
                time.sleep(pause_seconds)
                continue
            failures_in_row += 1
            if failures_in_row >= 3:
                log("speech cache warm-up stopped after 3 failed lines; later wakes render on demand")
                break
        return rendered

    def warm_speech_cache_isolated(
        self,
        lines: list[str],
        speech: dict | None = None,
        phase: str = "",
        night: bool = False,
    ) -> int:
        """Warms the cache on a copy of this engine with its own Fish worker,
        so a warm-up never shares the live worker's pipe (two renders on one
        pipe can cross and a wake greeting falls back to espeak).
        The copy's clock is pinned inside or outside the night window, so the
        night set renders during the day and the other way round."""
        warm = copy.copy(self)
        warm._fish_worker_proc = None
        warm._fish_worker_conn = None
        warm._fish_worker_ready = False
        warm._fish_worker_lock = threading.Lock()
        pinned = night_or_day_moment(
            self._clock(),
            night,
            getattr(self, "_fish_night_start", parse_clock_minutes(DEFAULT_FISH_TTS_NIGHT_START, DEFAULT_FISH_TTS_NIGHT_START)),
            getattr(self, "_fish_night_end", parse_clock_minutes(DEFAULT_FISH_TTS_NIGHT_END, DEFAULT_FISH_TTS_NIGHT_END)),
        )
        warm._clock = lambda: pinned
        try:
            return warm.warm_speech_cache(lines, speech=speech, phase=phase)
        finally:
            warm._close_fish_stream_worker()

    def _speech_cache_path(self, request: dict) -> str:
        key_fields = {key: value for key, value in request.items() if key != "api_key"}
        digest = hashlib.sha256(json.dumps(key_fields, sort_keys=True).encode("utf-8")).hexdigest()[:32]
        directory = os.path.expanduser(getattr(self, "_speech_cache_dir", "") or DEFAULT_SPEECH_CACHE_DIR)
        return os.path.join(directory, f"{digest}.raw")

    def _store_cached_speech(self, cache_path: str, source_path: str) -> None:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        partial = f"{cache_path}.{uuid.uuid4().hex[:8]}.partial"
        shutil.copyfile(source_path, partial)
        os.replace(partial, cache_path)

    def stream_browser_speech(
        self,
        text: str,
        speech: dict | None = None,
        phase: str = "",
        chunk_callback=None,
        start_callback=None,
    ) -> dict:
        spoken = str(text or "").strip()
        if not spoken:
            raise ValueError("speech text is empty")
        if not callable(chunk_callback):
            raise ValueError("chunk_callback required")
        voice_override = self._normalize_fish_voice_override(speech)
        fish_spoken = self._normalize_fish_text_override(speech) or spoken
        tone = speech.get("tone") if isinstance(speech, dict) else ""
        fish_spoken, tone_tag = self._tag_fish_text(fish_spoken, phase=phase, tone=tone)
        fish_config = self._normalize_fish_config_override(speech)
        if self._fish_ready:
            try:
                self._emit_fish_request_event(fish_spoken, phase=phase, prepared=False, tone=str(tone or ""), tone_tag=tone_tag)
                return self._stream_fish_to_browser(
                    fish_spoken,
                    chunk_callback=chunk_callback,
                    start_callback=start_callback,
                    voice_override=voice_override,
                    config_override=fish_config,
                    phase=phase,
                )
            except Exception as err:
                if is_browser_voice_client_disconnected(err):
                    raise BrowserVoiceClientDisconnected("browser voice client disconnected") from err
                self._emit_playback_event(
                    "tts_fallback",
                    backend="fish_stream",
                    fallback_backend="espeak",
                    phase=str(phase or "").strip() or None,
                    utterance=fish_spoken,
                    reason=str(err),
                )
                log(f"Fish Audio browser stream failed; falling back to espeak clip: {err}")
        prepared = self._prepare_without_fish(spoken, phase=phase)
        return self._stream_prepared_to_browser(
            prepared,
            chunk_callback=chunk_callback,
            start_callback=start_callback,
            phase=phase,
            text=spoken,
        )

    def play_prepared_speech(self, prepared: PreparedSpeech) -> None:
        started = time.monotonic()
        try:
            self._emit_playback_event(
                "tts_playback_started",
                backend=prepared.backend,
                phase=str(prepared.phase or "").strip() or None,
                utterance=prepared.utterance,
                first_audio_ms=int(round((time.monotonic() - started) * 1000)),
            )
            tap = getattr(self, "_playback_audio_tap", None)
            if tap is not None:
                tap.mirror_prepared(prepared)
            if prepared.raw_pcm:
                command = [
                    "aplay",
                    "-q",
                    "-D",
                    self._device,
                    "-f",
                    "S16_LE",
                    "-r",
                    str(prepared.sample_rate),
                    "-c",
                    "1",
                    "-t",
                    "raw",
                    prepared.path,
                ]
            else:
                command = ["aplay", "-D", self._device, prepared.path]
            subprocess.run(
                command,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self._emit_playback_event(
                "tts_playback_finished",
                backend=prepared.backend,
                phase=str(prepared.phase or "").strip() or None,
                utterance=prepared.utterance,
                total_ms=int(round((time.monotonic() - started) * 1000)),
            )
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(prepared.path)

    def speak_local(self, text: str, phase: str = "") -> None:
        spoken = str(text or "").strip()
        if not spoken:
            return
        self._speak_with_espeak(spoken, phase=phase)

    def _build_fish_stream_request(self, spoken: str, voice_override: str = "", config_override: "TTSConfig | None" = None) -> dict:
        config = config_override or self._fish_stream_config
        if config is None:
            raise RuntimeError("Fish Audio config is not ready")
        prosody = getattr(config, "prosody", None)
        speed = float(getattr(prosody, "speed", self._fish_tts_speed) or self._fish_tts_speed)
        volume_db = float(getattr(prosody, "volume", self._fish_tts_volume_db) or self._fish_tts_volume_db)
        # Night is volume and pace only, never tone. An explicit per-speech override still wins.
        if config_override is None and self.night_quiet_now():
            speed = self._fish_night_speed
            volume_db = self._fish_night_volume_db
        return {
            "api_key": self._fish_api_key,
            "voice_id": voice_override or self._fish_voice_id,
            "model": self._fish_model,
            "latency": self._fish_latency,
            "sample_rate": int(getattr(config, "sample_rate", self._fish_sample_rate) or self._fish_sample_rate),
            "chunk_length": int(getattr(config, "chunk_length", self._fish_tts_chunk_length) or self._fish_tts_chunk_length),
            "speed": speed,
            "volume_db": volume_db,
            "top_p": float(getattr(config, "top_p", self._fish_tts_top_p) or self._fish_tts_top_p),
            "temperature": float(getattr(config, "temperature", self._fish_tts_temperature) or self._fish_tts_temperature),
            "repetition_penalty": float(
                getattr(config, "repetition_penalty", self._fish_tts_repetition_penalty) or self._fish_tts_repetition_penalty
            ),
            "condition_on_previous_chunks": bool(
                getattr(config, "condition_on_previous_chunks", self._fish_tts_condition_on_previous_chunks)
            ),
            "spoken": spoken,
        }

    def _log_fish_stream_request(self, action: str, request: dict, phase: str = "") -> None:
        spoken = " ".join(str(request.get("spoken") or "").split()).strip()
        preview = spoken[:120]
        if len(spoken) > 120:
            preview += "..."
        log(
            "Fish Audio "
            f"{action} started phase={str(phase or '').strip() or 'unknown'} "
            f"model={request.get('model')} latency={request.get('latency')} "
            f"sample_rate={request.get('sample_rate')} chunk_length={request.get('chunk_length')} "
            f"chars={len(spoken)} preview={preview!r}"
        )

    def _start_fish_stream_process(self, request: dict):
        worker_lock = self._fish_worker_lock_for_use()
        worker_lock.acquire()
        try:
            self._ensure_fish_stream_worker_ready()
            stream_proc = self._fish_worker_proc
            recv_conn = self._fish_worker_conn
            if stream_proc is None or recv_conn is None:
                raise RuntimeError("Fish Audio worker is unavailable")
            recv_conn.send(("stream", request))
            return stream_proc, recv_conn
        except Exception:
            worker_lock.release()
            raise

    def _start_fish_live_process(self, request: dict, stream_id: str):
        worker_lock = self._fish_worker_lock_for_use()
        worker_lock.acquire()
        try:
            self._ensure_fish_stream_worker_ready()
            stream_proc = self._fish_worker_proc
            recv_conn = self._fish_worker_conn
            if stream_proc is None or recv_conn is None:
                raise RuntimeError("Fish Audio worker is unavailable")
            recv_conn.send(("live_start", {
                **request,
                "stream_id": stream_id,
            }))
            return stream_proc, recv_conn
        except Exception:
            worker_lock.release()
            raise

    def _fish_worker_lock_for_use(self):
        worker_lock = getattr(self, "_fish_worker_lock", None)
        if worker_lock is None:
            worker_lock = threading.Lock()
            self._fish_worker_lock = worker_lock
        return worker_lock

    def _launch_fish_stream_worker(self) -> None:
        current_proc = getattr(self, "_fish_worker_proc", None)
        if current_proc is not None and current_proc.is_alive():
            return
        self._close_fish_stream_worker()
        context = multiprocessing.get_context()
        recv_conn, send_conn = context.Pipe(duplex=True)
        stream_proc = context.Process(
            target=fish_stream_worker,
            args=(send_conn, self._fish_api_key),
            daemon=True,
        )
        stream_proc.start()
        send_conn.close()
        self._fish_worker_proc = stream_proc
        self._fish_worker_conn = recv_conn
        self._fish_worker_ready = False

    def _ensure_fish_stream_worker_ready(self) -> None:
        stream_proc = getattr(self, "_fish_worker_proc", None)
        recv_conn = getattr(self, "_fish_worker_conn", None)
        if stream_proc is None or recv_conn is None or not stream_proc.is_alive():
            self._launch_fish_stream_worker()
            stream_proc = self._fish_worker_proc
            recv_conn = self._fish_worker_conn
        if self._fish_worker_ready:
            return
        started = time.monotonic()
        if not recv_conn.poll(FISH_WORKER_READY_TIMEOUT_SECONDS):
            self._close_fish_stream_worker()
            raise RuntimeError(
                f"Fish Audio worker did not become ready within {FISH_WORKER_READY_TIMEOUT_SECONDS:.1f}s"
            )
        message_type, payload = recv_conn.recv()
        if message_type != "worker_ready":
            self._close_fish_stream_worker()
            detail = str(payload or message_type)
            raise RuntimeError(f"Fish Audio worker failed during startup: {detail}")
        self._fish_worker_ready = True
        log(f"Fish Audio worker ready startup_ms={int(round((time.monotonic() - started) * 1000))}")

    def _stop_fish_stream_process(self, stream_proc, recv_conn, reusable: bool = False) -> None:
        persistent = (
            stream_proc is not None
            and stream_proc is getattr(self, "_fish_worker_proc", None)
            and recv_conn is getattr(self, "_fish_worker_conn", None)
        )
        if persistent and reusable and stream_proc.is_alive():
            worker_lock = self._fish_worker_lock_for_use()
            if worker_lock.locked():
                worker_lock.release()
            return
        if persistent:
            self._close_fish_stream_worker()
            worker_lock = self._fish_worker_lock_for_use()
            if worker_lock.locked():
                worker_lock.release()
            return
        with contextlib.suppress(Exception):
            if recv_conn is not None:
                recv_conn.close()
        if stream_proc is None:
            return
        with contextlib.suppress(Exception):
            if stream_proc.is_alive():
                stream_proc.terminate()
        with contextlib.suppress(Exception):
            stream_proc.join(timeout=2)
        with contextlib.suppress(Exception):
            if stream_proc.is_alive():
                stream_proc.kill()
        with contextlib.suppress(Exception):
            if stream_proc.is_alive():
                stream_proc.join(timeout=2)

    def _close_fish_stream_worker(self) -> None:
        stream_proc = getattr(self, "_fish_worker_proc", None)
        recv_conn = getattr(self, "_fish_worker_conn", None)
        if recv_conn is not None and stream_proc is not None and stream_proc.is_alive():
            with contextlib.suppress(Exception):
                recv_conn.send(("stop", None))
        with contextlib.suppress(Exception):
            if recv_conn is not None:
                recv_conn.close()
        if stream_proc is not None:
            with contextlib.suppress(Exception):
                stream_proc.join(timeout=1)
            with contextlib.suppress(Exception):
                if stream_proc.is_alive():
                    stream_proc.terminate()
            with contextlib.suppress(Exception):
                stream_proc.join(timeout=2)
            with contextlib.suppress(Exception):
                if stream_proc.is_alive():
                    stream_proc.kill()
            with contextlib.suppress(Exception):
                if stream_proc.is_alive():
                    stream_proc.join(timeout=2)
        self._fish_worker_proc = None
        self._fish_worker_conn = None
        self._fish_worker_ready = False

    def close(self) -> None:
        self._close_fish_stream_worker()

    def _prepare_with_espeak(self, spoken: str, phase: str = "") -> PreparedSpeech:
        spoken = strip_fish_tags(spoken) or spoken
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            wav_path = handle.name
        started = time.monotonic()
        try:
            subprocess.run(
                [
                    "espeak-ng",
                    "-v",
                    self._voice,
                    "-s",
                    str(self._speed),
                    "-p",
                    str(self._pitch),
                    "-w",
                    wav_path,
                    spoken,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
            )
            total_ms = int(round((time.monotonic() - started) * 1000))
            self._emit_playback_event(
                "tts_prepare_finished",
                backend="espeak",
                phase=str(phase or "").strip() or None,
                utterance=spoken,
                first_audio_ms=total_ms,
                total_ms=total_ms,
            )
            return PreparedSpeech(
                path=wav_path,
                backend="espeak",
                utterance=spoken,
                phase=phase,
                sample_rate=SAMPLE_RATE,
                raw_pcm=False,
            )
        except Exception:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(wav_path)
            raise

    def _speak_with_espeak(self, spoken: str, phase: str = "") -> None:
        prepared = self._prepare_without_fish(spoken, phase=phase)
        self.play_prepared_speech(prepared)

    def _prepare_without_fish(self, spoken: str, phase: str = "") -> PreparedSpeech:
        """The voice when Fish is off or fails: the house's Home Assistant voice when one is set
        else espeak."""
        if getattr(self, "_ha_tts_entity", "") and getattr(self, "_ha_api", None) is not None:
            try:
                return self._prepare_with_home_assistant(spoken, phase=phase)
            except Exception as err:
                log(f"Home Assistant voice failed; falling back to espeak: {err}")
        return self._prepare_with_espeak(spoken, phase=phase)

    def _prepare_with_home_assistant(self, spoken: str, phase: str = "") -> PreparedSpeech:
        """HA renders the line (tts_get_url, then its tts_proxy file); ffmpeg turns it into a WAV."""
        spoken = strip_fish_tags(spoken) or spoken
        started = time.monotonic()
        reply = json.loads(self._ha_api.api_request(
            "POST",
            "tts_get_url",
            body=json.dumps({"engine_id": self._ha_tts_entity, "message": spoken}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        ).decode("utf-8") or "{}")
        path = str(reply.get("path") or urllib.parse.urlparse(str(reply.get("url") or "")).path)
        if not path.startswith("/api/"):
            raise RuntimeError(f"Home Assistant gave no audio path for {self._ha_tts_entity}")
        audio = self._ha_api.api_request("GET", path[len("/api/"):])
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            wav_path = handle.name
        try:
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0",
                 "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", wav_path],
                input=audio,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(wav_path)
            raise
        total_ms = int(round((time.monotonic() - started) * 1000))
        self._emit_playback_event(
            "tts_prepare_finished",
            backend="home_assistant",
            phase=str(phase or "").strip() or None,
            utterance=spoken,
            first_audio_ms=total_ms,
            total_ms=total_ms,
        )
        return PreparedSpeech(
            path=wav_path,
            backend="home_assistant",
            utterance=spoken,
            phase=phase,
            sample_rate=SAMPLE_RATE,
            raw_pcm=False,
        )

    def _prepare_with_fish(
        self,
        spoken: str,
        voice_override: str = "",
        config_override: "TTSConfig | None" = None,
        phase: str = "",
    ) -> PreparedSpeech:
        if not self._fish_client or not self._fish_stream_config:
            raise RuntimeError("Fish Audio client is not ready")

        handle = tempfile.NamedTemporaryFile(suffix=".raw", delete=False)
        raw_path = handle.name
        wrote_audio = False
        first_chunk_ms = None
        total_bytes = 0
        stream_proc = None
        recv_conn = None
        stream_reusable = False
        prepare_started = time.monotonic()
        request = self._build_fish_stream_request(spoken, voice_override=voice_override, config_override=config_override)
        self._log_fish_stream_request("prepare", request, phase=phase)
        try:
            stream_proc, recv_conn = self._start_fish_stream_process(request)
            while True:
                timeout_seconds = FISH_FIRST_AUDIO_TIMEOUT_SECONDS if not wrote_audio else FISH_STREAM_IDLE_TIMEOUT_SECONDS
                if not recv_conn.poll(timeout_seconds):
                    if not wrote_audio:
                        elapsed_ms = int(round((time.monotonic() - prepare_started) * 1000))
                        log(
                            "Fish Audio prepare startup timeout "
                            f"phase={str(phase or '').strip() or 'unknown'} elapsed_ms={elapsed_ms}"
                        )
                        raise FishStartupTimeoutError(
                            f"Fish Audio produced no startup audio within {FISH_FIRST_AUDIO_TIMEOUT_SECONDS:.1f}s"
                        )
                    elapsed_ms = int(round((time.monotonic() - prepare_started) * 1000))
                    log(
                        "Fish Audio prepare stalled after audio started "
                        f"phase={str(phase or '').strip() or 'unknown'} elapsed_ms={elapsed_ms}"
                    )
                    raise RuntimeError(f"Fish Audio stalled for {FISH_STREAM_IDLE_TIMEOUT_SECONDS:.1f}s during preparation")
                message_type, payload = recv_conn.recv()
                if message_type == "done":
                    stream_reusable = True
                    break
                if message_type == "error":
                    stream_reusable = True
                    raise RuntimeError(f"Fish Audio worker failed: {payload}")
                if message_type != "chunk" or not payload:
                    continue
                chunk = bytes(payload)
                handle.write(chunk)
                total_bytes += len(chunk)
                if first_chunk_ms is None:
                    first_chunk_ms = int(round((time.monotonic() - prepare_started) * 1000))
                    log(
                        "Fish Audio prepare first audio "
                        f"phase={str(phase or '').strip() or 'unknown'} first_chunk_ms={first_chunk_ms} "
                        f"chunk_bytes={len(chunk)}"
                    )
                wrote_audio = True
            handle.close()
            if not wrote_audio:
                raise RuntimeError("Fish Audio returned no audio")
            total_ms = int(round((time.monotonic() - prepare_started) * 1000))
            log(
                "Fish Audio prepare finished "
                f"phase={str(phase or '').strip() or 'unknown'} total_ms={total_ms} "
                f"first_chunk_ms={first_chunk_ms} total_bytes={total_bytes}"
            )
            self._emit_playback_event(
                "tts_prepare_finished",
                backend="fish_prepared",
                phase=str(phase or "").strip() or None,
                utterance=spoken,
                first_audio_ms=first_chunk_ms,
                total_ms=total_ms,
                total_bytes=total_bytes,
            )
            return PreparedSpeech(
                path=raw_path,
                backend="fish_prepared",
                utterance=spoken,
                phase=phase,
                sample_rate=self._fish_sample_rate,
                raw_pcm=True,
            )
        except Exception:
            with contextlib.suppress(Exception):
                handle.close()
            with contextlib.suppress(FileNotFoundError):
                os.unlink(raw_path)
            raise
        finally:
            self._stop_fish_stream_process(stream_proc, recv_conn, reusable=stream_reusable)

    def _speak_with_fish(
        self,
        spoken: str,
        voice_override: str = "",
        config_override: "TTSConfig | None" = None,
        phase: str = "",
    ) -> None:
        if not self._fish_client or not self._fish_stream_config:
            raise RuntimeError("Fish Audio client is not ready")

        aplay_proc = subprocess.Popen(
            [
                "aplay",
                "-q",
                "-D",
                self._device,
                "-f",
                "S16_LE",
                "-r",
                str(self._fish_sample_rate),
                "-c",
                "1",
                "-t",
                "raw",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        wrote_audio = False
        first_chunk_ms = None
        total_bytes = 0
        stream_proc = None
        recv_conn = None
        stream_reusable = False
        request = self._build_fish_stream_request(spoken, voice_override=voice_override, config_override=config_override)
        try:
            tap = getattr(self, "_playback_audio_tap", None)
            tap_stream = (
                tap.begin_stream(
                    sample_rate=self._fish_sample_rate,
                    channels=1,
                    sample_width=SAMPLE_WIDTH,
                    phase=phase,
                )
                if tap is not None
                else None
            )
            stream_started = time.monotonic()
            self._log_fish_stream_request("speak", request, phase=phase)
            stream_proc, recv_conn = self._start_fish_stream_process(request)
            while True:
                timeout_seconds = FISH_FIRST_AUDIO_TIMEOUT_SECONDS if not wrote_audio else FISH_STREAM_IDLE_TIMEOUT_SECONDS
                if not recv_conn.poll(timeout_seconds):
                    if not wrote_audio:
                        elapsed_ms = int(round((time.monotonic() - stream_started) * 1000))
                        log(
                            "Fish Audio speak startup timeout "
                            f"phase={str(phase or '').strip() or 'unknown'} elapsed_ms={elapsed_ms}"
                        )
                        raise FishStartupTimeoutError(
                            f"Fish Audio produced no startup audio within {FISH_FIRST_AUDIO_TIMEOUT_SECONDS:.1f}s"
                        )
                    elapsed_ms = int(round((time.monotonic() - stream_started) * 1000))
                    log(
                        "Fish Audio speak stalled after audio started "
                        f"phase={str(phase or '').strip() or 'unknown'} elapsed_ms={elapsed_ms}"
                    )
                    raise RuntimeError(f"Fish Audio stalled for {FISH_STREAM_IDLE_TIMEOUT_SECONDS:.1f}s after audio started")
                message_type, payload = recv_conn.recv()
                if message_type == "done":
                    stream_reusable = True
                    break
                if message_type == "error":
                    stream_reusable = True
                    raise RuntimeError(f"Fish Audio worker failed: {payload}")
                if message_type != "chunk" or not payload:
                    continue
                chunk = bytes(payload)
                if not aplay_proc.stdin:
                    raise RuntimeError("aplay stdin was unavailable")
                if tap_stream is not None:
                    tap_stream.append(chunk)
                aplay_proc.stdin.write(chunk)
                aplay_proc.stdin.flush()
                total_bytes += len(chunk)
                if not wrote_audio:
                    first_chunk_ms = int(round((time.monotonic() - stream_started) * 1000))
                    log(
                        "Fish Audio speak first audio "
                        f"phase={str(phase or '').strip() or 'unknown'} first_chunk_ms={first_chunk_ms} "
                        f"chunk_bytes={len(chunk)}"
                    )
                    self._emit_playback_event(
                        "tts_playback_started",
                        backend="fish",
                        phase=str(phase or "").strip() or None,
                        utterance=spoken,
                        first_audio_ms=first_chunk_ms,
                    )
                wrote_audio = True
            if aplay_proc.stdin:
                aplay_proc.stdin.close()
            if tap_stream is not None:
                tap_stream.finish()
            stderr = aplay_proc.stderr.read() if aplay_proc.stderr else b""
            if aplay_proc.wait() != 0:
                detail = stderr.decode("utf-8", errors="ignore").strip()
                raise RuntimeError(f"aplay failed for Fish Audio stream: {detail}")
            total_ms = int(round((time.monotonic() - stream_started) * 1000))
            log(
                "Fish Audio speak finished "
                f"phase={str(phase or '').strip() or 'unknown'} total_ms={total_ms} "
                f"first_chunk_ms={first_chunk_ms} total_bytes={total_bytes}"
            )
            self._emit_playback_event(
                "tts_playback_finished",
                backend="fish",
                phase=str(phase or "").strip() or None,
                utterance=spoken,
                first_audio_ms=first_chunk_ms,
                total_ms=total_ms,
                total_bytes=total_bytes,
            )
        except Exception as err:
            startup_timeout = isinstance(err, FishStartupTimeoutError) and not wrote_audio
            if startup_timeout:
                self._emit_playback_event(
                    "fish_tts_start_timeout",
                    backend="fish",
                    phase=str(phase or "").strip() or None,
                    utterance=spoken,
                    timeout_ms=int(round(FISH_FIRST_AUDIO_TIMEOUT_SECONDS * 1000)),
                )
            self._emit_playback_event(
                "tts_playback_failed",
                backend="fish",
                fallback_backend=None,
                phase=str(phase or "").strip() or None,
                utterance=spoken,
                reason=str(err),
            )
            with contextlib.suppress(Exception):
                if aplay_proc.stdin:
                    aplay_proc.stdin.close()
            with contextlib.suppress(Exception):
                if 'tap_stream' in locals() and tap_stream is not None:
                    tap_stream.finish()
            with contextlib.suppress(Exception):
                aplay_proc.kill()
            with contextlib.suppress(Exception):
                aplay_proc.wait(timeout=2)
            raise TTSPlaybackError(
                str(err),
                partial_audio=wrote_audio,
                startup_timeout=startup_timeout,
            ) from err
        finally:
            self._stop_fish_stream_process(stream_proc, recv_conn, reusable=stream_reusable)

    def _stream_fish_to_browser(
        self,
        spoken: str,
        *,
        chunk_callback,
        start_callback=None,
        voice_override: str = "",
        config_override: "TTSConfig | None" = None,
        phase: str = "",
    ) -> dict:
        if not self._fish_client or not self._fish_stream_config:
            raise RuntimeError("Fish Audio client is not ready")
        wrote_audio = False
        first_chunk_ms = None
        total_bytes = 0
        stream_proc = None
        recv_conn = None
        stream_reusable = False
        stream_started = time.monotonic()
        request = self._build_fish_stream_request(spoken, voice_override=voice_override, config_override=config_override)
        self._log_fish_stream_request("browser-stream", request, phase=phase)
        try:
            stream_proc, recv_conn = self._start_fish_stream_process(request)
            stream_info = {
                "backend": "fish_stream",
                "sample_rate": self._fish_sample_rate,
                "channels": 1,
                "sample_width": SAMPLE_WIDTH,
                "phase": str(phase or "").strip() or None,
                "text": spoken,
            }
            if callable(start_callback):
                start_callback(stream_info)
            while True:
                timeout_seconds = FISH_FIRST_AUDIO_TIMEOUT_SECONDS if not wrote_audio else FISH_STREAM_IDLE_TIMEOUT_SECONDS
                if not recv_conn.poll(timeout_seconds):
                    if not wrote_audio:
                        elapsed_ms = int(round((time.monotonic() - stream_started) * 1000))
                        log(
                            "Fish Audio browser stream startup timeout "
                            f"phase={str(phase or '').strip() or 'unknown'} elapsed_ms={elapsed_ms}"
                        )
                        raise FishStartupTimeoutError(
                            f"Fish Audio produced no startup audio within {FISH_FIRST_AUDIO_TIMEOUT_SECONDS:.1f}s"
                        )
                    elapsed_ms = int(round((time.monotonic() - stream_started) * 1000))
                    log(
                        "Fish Audio browser stream stalled after audio started "
                        f"phase={str(phase or '').strip() or 'unknown'} elapsed_ms={elapsed_ms}"
                    )
                    raise RuntimeError(f"Fish Audio stalled for {FISH_STREAM_IDLE_TIMEOUT_SECONDS:.1f}s during browser streaming")
                message_type, payload = recv_conn.recv()
                if message_type == "done":
                    stream_reusable = True
                    break
                if message_type == "error":
                    stream_reusable = True
                    raise RuntimeError(f"Fish Audio worker failed: {payload}")
                if message_type != "chunk" or not payload:
                    continue
                chunk = bytes(payload)
                chunk_callback(chunk)
                total_bytes += len(chunk)
                if first_chunk_ms is None:
                    first_chunk_ms = int(round((time.monotonic() - stream_started) * 1000))
                    log(
                        "Fish Audio browser stream first audio "
                        f"phase={str(phase or '').strip() or 'unknown'} first_chunk_ms={first_chunk_ms} "
                        f"chunk_bytes={len(chunk)}"
                    )
                wrote_audio = True
            if not wrote_audio:
                raise RuntimeError("Fish Audio returned no audio")
            total_ms = int(round((time.monotonic() - stream_started) * 1000))
            log(
                "Fish Audio browser stream finished "
                f"phase={str(phase or '').strip() or 'unknown'} total_ms={total_ms} "
                f"first_chunk_ms={first_chunk_ms} total_bytes={total_bytes}"
            )
            self._emit_playback_event(
                "tts_stream_finished",
                backend="fish_stream",
                phase=str(phase or "").strip() or None,
                utterance=spoken,
                first_audio_ms=first_chunk_ms,
                total_ms=total_ms,
                total_bytes=total_bytes,
            )
            return stream_info
        finally:
            self._stop_fish_stream_process(stream_proc, recv_conn, reusable=stream_reusable)

    def _stream_prepared_to_browser(
        self,
        prepared: PreparedSpeech,
        *,
        chunk_callback,
        start_callback=None,
        phase: str = "",
        text: str = "",
    ) -> dict:
        spoken = " ".join(str(text or prepared.utterance or "").split()).strip()
        payload = b""
        sample_rate = prepared.sample_rate
        channels = 1
        sample_width = SAMPLE_WIDTH
        try:
            if prepared.raw_pcm:
                with open(prepared.path, "rb") as handle:
                    payload = handle.read()
            else:
                with wave.open(prepared.path, "rb") as wav_handle:
                    payload = wav_handle.readframes(wav_handle.getnframes())
                    sample_rate = wav_handle.getframerate()
                    channels = wav_handle.getnchannels()
                    sample_width = wav_handle.getsampwidth()
            stream_info = {
                "backend": prepared.backend,
                "sample_rate": sample_rate,
                "channels": channels,
                "sample_width": sample_width,
                "phase": str(phase or prepared.phase or "").strip() or None,
                "text": spoken or None,
            }
            if callable(start_callback):
                start_callback(stream_info)
            chunk_size = max(FRAME_BYTES * 8, 4096)
            for index in range(0, len(payload), chunk_size):
                chunk_callback(payload[index:index + chunk_size])
            return stream_info
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(prepared.path)

    def _normalize_fish_voice_override(self, speech: dict | None = None) -> str:
        if not isinstance(speech, dict):
            return ""
        return str(speech.get("voice_id") or "").strip()

    def _normalize_fish_text_override(self, speech: dict | None = None) -> str:
        if not isinstance(speech, dict):
            return ""
        value = str(speech.get("fish_text") or "").strip()
        if not value:
            return ""
        return " ".join(value.split())[:1000].strip()

    def _normalize_fish_config_override(self, speech: dict | None = None) -> "TTSConfig | None":
        if not isinstance(speech, dict) or not self._fish_stream_config or Prosody is None:
            return None
        speed_value = speech.get("speed")
        volume_value = speech.get("volume_db")
        if speed_value in (None, "") and volume_value in (None, ""):
            return None
        try:
            speed = self._fish_tts_speed if speed_value in (None, "") else max(0.5, min(2.0, float(speed_value)))
            volume = self._fish_tts_volume_db if volume_value in (None, "") else max(-20.0, min(20.0, float(volume_value)))
        except (TypeError, ValueError):
            return None
        return self._fish_stream_config.model_copy(
            update={
                "prosody": Prosody(speed=speed, volume=volume),
            }
        )

    def beep(
        self,
        duration_ms: int = BEEP_DURATION_MS,
        frequency_hz: int = BEEP_FREQUENCY_HZ,
        amplitude: float = BEEP_AMPLITUDE,
    ) -> None:
        frame_count = max(1, int(SAMPLE_RATE * max(1, int(duration_ms)) / 1000))
        level = int(32767 * max(0.0, min(1.0, float(amplitude))))
        frames = bytearray()
        for index in range(frame_count):
            sample = int(level * math.sin(2.0 * math.pi * frequency_hz * index / SAMPLE_RATE))
            frames.extend(sample.to_bytes(2, byteorder="little", signed=True))

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            wav_path = handle.name
        try:
            with wave.open(wav_path, "wb") as wav_handle:
                wav_handle.setnchannels(CHANNELS)
                wav_handle.setsampwidth(SAMPLE_WIDTH)
                wav_handle.setframerate(SAMPLE_RATE)
                wav_handle.writeframes(bytes(frames))
            subprocess.run(
                ["aplay", "-D", self._device, wav_path],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(wav_path)


class ProgressiveTtsSession:
    def __init__(
        self,
        engine: TtsEngine,
        phase: str = "progressive_reply",
        turn_complete_at: float | None = None,
        output_start_callback=None,
        output_chunk_callback=None,
        output_close_callback=None,
    ):
        self._engine = engine
        self.stream_id = uuid.uuid4().hex
        self._phase = str(phase or "progressive_reply").strip() or "progressive_reply"
        self._turn_complete_at = float(turn_complete_at) if turn_complete_at else None
        self._output_start_callback = output_start_callback if callable(output_start_callback) else None
        self._output_chunk_callback = output_chunk_callback if callable(output_chunk_callback) else None
        self._output_close_callback = output_close_callback if callable(output_close_callback) else None
        self._started_at = time.monotonic()
        self._send_lock = threading.Lock()
        self._condition = threading.Condition()
        self._pcm_chunks = collections.deque()
        self._buffered_bytes = 0
        self._aplay_unplayed_bytes = 0.0
        self._aplay_accounted_at: float | None = None
        self._synthesis_done = False
        self._lead_input_complete = False
        self._finish_sent = False
        self._closed = False
        self._error: Exception | None = None
        self._segments: list[str] = []
        self._total_bytes = 0
        self._first_audio_ms: int | None = None
        self._question_to_first_audio_ms: int | None = None
        self._playback_started_at: float | None = None
        self._playback_finished_at: float | None = None
        self._underruns = 0
        self._partial_audio = False
        self._stream_reusable = False
        self._source_cancel = None
        self._source_cancelled = False
        self._fish_input_started = False
        # True while Fish holds text it has not yet answered with audio. Waiting
        # on the assistant for the next sentence is not a Fish stall.
        self._fish_owes_audio = False
        self._last_fish_activity_at = self._started_at
        request = engine._build_fish_stream_request("")
        engine._log_fish_stream_request("progressive", request, phase=self._phase)
        self._stream_proc, self._conn = engine._start_fish_live_process(request, self.stream_id)
        self._reader_thread = threading.Thread(
            target=self._read_fish_audio,
            name=f"fish-progressive-reader-{self.stream_id[:8]}",
            daemon=True,
        )
        self._player_thread = threading.Thread(
            target=self._play_pcm,
            name=f"fish-progressive-player-{self.stream_id[:8]}",
            daemon=True,
        )
        self._reader_thread.start()
        self._player_thread.start()

    @property
    def partial_audio(self) -> bool:
        return bool(self._partial_audio)

    @property
    def segment_count(self) -> int:
        return len(self._segments)

    @property
    def utterance(self) -> str:
        return " ".join(self._segments).strip()

    @property
    def played_ms(self) -> int:
        if self._playback_started_at is None:
            return 0
        finished_at = self._playback_finished_at or time.monotonic()
        return int(round(max(0.0, finished_at - self._playback_started_at) * 1000))

    def set_source_cancel(self, callback) -> None:
        cancel_now = False
        with self._condition:
            self._source_cancel = callback if callable(callback) else None
            cancel_now = bool(self._source_cancel and (self._closed or self._error))
        if cancel_now:
            self._cancel_source()

    def append(
        self,
        text: str,
        canonical_text: str = "",
        flush_immediately: bool = False,
        tone: object = "",
        kind: str = "",
    ) -> None:
        spoken = " ".join(str(text or "").split()).strip()
        canonical = " ".join(str(canonical_text or spoken).split()).strip()
        if not spoken or not canonical:
            raise ValueError("progressive speech segment is empty")
        with self._condition:
            if self._closed or self._finish_sent:
                raise RuntimeError("progressive speech session is closed")
            if self._error:
                raise self._error
        fish_spoken, tone_tag = self._engine._tag_fish_text(spoken, phase=self._phase, tone=tone, kind=kind)
        self._engine._emit_fish_request_event(
            fish_spoken,
            phase=self._phase,
            prepared=False,
            tone=str(tone or ""),
            tone_tag=tone_tag,
        )
        self._send(
            "live_text",
            {
                "text": fish_spoken,
                "flush_immediately": bool(flush_immediately),
            },
        )
        self._segments.append(canonical)
        with self._condition:
            self._fish_input_started = True
            self._fish_owes_audio = True
            self._last_fish_activity_at = time.monotonic()
            buffered_ms = self._buffered_ahead_ms_locked()
        self._engine._emit_playback_event(
            "progressive_segment_queued",
            stream_id=self.stream_id,
            sequence=len(self._segments),
            phase=self._phase,
            utterance=canonical,
            buffered_audio_ms=buffered_ms,
        )

    def mark_lead_complete(self) -> None:
        with self._condition:
            self._lead_input_complete = True
            self._condition.notify_all()

    def _startup_buffer_ready_locked(self, startup_bytes: int) -> bool:
        return self._buffered_bytes > 0 and (
            self._buffered_bytes >= startup_bytes
            or self._lead_input_complete
            or self._synthesis_done
        )

    def finish(self, timeout_seconds: float = 60.0) -> ProgressivePlaybackResult:
        with self._condition:
            if not self._finish_sent:
                self._finish_sent = True
                self._send("live_end", {})
        deadline = time.monotonic() + max(1.0, float(timeout_seconds or 60.0))
        for thread in (self._reader_thread, self._player_thread):
            remaining = max(0.0, deadline - time.monotonic())
            thread.join(timeout=remaining)
        if self._reader_thread.is_alive() or self._player_thread.is_alive():
            self.abort()
            raise RuntimeError("progressive Fish playback did not finish before its deadline")
        with self._condition:
            error = self._error
        if error:
            raise TTSPlaybackError(
                str(error),
                partial_audio=self._partial_audio,
                startup_timeout=not self._partial_audio,
            ) from error
        self._closed = True
        total_ms = int(round((time.monotonic() - self._started_at) * 1000))
        played_ms = int(round(
            max(0.0, (self._playback_finished_at or time.monotonic()) - self._playback_started_at) * 1000
        )) if self._playback_started_at is not None else 0
        utterance = " ".join(self._segments).strip()
        result = ProgressivePlaybackResult(
            stream_id=self.stream_id,
            utterance=utterance,
            segment_count=len(self._segments),
            first_audio_ms=self._first_audio_ms,
            question_to_first_audio_ms=self._question_to_first_audio_ms,
            total_ms=total_ms,
            total_bytes=self._total_bytes,
            played_ms=played_ms,
            underruns=self._underruns,
            partial_audio=self._partial_audio,
        )
        self._engine._emit_playback_event(
            "progressive_playback_finished",
            stream_id=self.stream_id,
            phase=self._phase,
            utterance=utterance,
            segment_count=result.segment_count,
            first_audio_ms=result.first_audio_ms,
            question_to_first_audio_ms=result.question_to_first_audio_ms,
            total_ms=result.total_ms,
            total_bytes=result.total_bytes,
            underruns=result.underruns,
        )
        return result

    def wait_for_future_before_playback_end(self, future, timeout_seconds: float) -> bool:
        if future is None:
            return False
        deadline = time.monotonic() + max(0.0, float(timeout_seconds or 0.0))
        drained_since = None
        while True:
            if future.done():
                return True
            now = time.monotonic()
            if now >= deadline:
                return future.done()
            with self._condition:
                if self._error or self._closed:
                    return False
                buffered_ahead_ms = self._buffered_ahead_ms_locked(now=now)
                playback_started = self._partial_audio and self._playback_started_at is not None
                drained = playback_started and buffered_ahead_ms <= 0 and not self._pcm_chunks
                if drained:
                    drained_since = drained_since or now
                    # Two observations avoid mistaking the tiny queue-pop/write
                    # handoff for the end of audible lead playback.
                    if now - drained_since >= 0.02:
                        return future.done()
                else:
                    drained_since = None
                self._condition.wait(timeout=min(0.02, max(0.0, deadline - now)))

    def abort(self) -> None:
        with self._condition:
            self._closed = True
            self._finish_sent = True
            self._synthesis_done = True
            self._condition.notify_all()
        self._cancel_source()
        with contextlib.suppress(Exception):
            self._send("live_abort", {})
        with contextlib.suppress(Exception):
            self._engine._stop_fish_stream_process(self._stream_proc, self._conn, reusable=False)

    def _send(self, command: str, payload: dict) -> None:
        with self._send_lock:
            self._conn.send((command, {
                **payload,
                "stream_id": self.stream_id,
            }))

    def _cancel_source(self) -> None:
        callback = None
        with self._condition:
            if self._source_cancelled:
                return
            callback = self._source_cancel
            if callback is None:
                return
            self._source_cancelled = True
        with contextlib.suppress(Exception):
            callback()

    def _read_fish_audio(self) -> None:
        try:
            while True:
                if not self._conn.poll(1.0):
                    with self._condition:
                        if self._closed:
                            return
                        fish_stalled = (
                            self._fish_input_started
                            and (self._fish_owes_audio or self._finish_sent)
                            and time.monotonic() - self._last_fish_activity_at
                            >= FISH_STREAM_IDLE_TIMEOUT_SECONDS
                        )
                    if fish_stalled:
                        raise RuntimeError(
                            f"Fish Audio progressive stream was idle for {FISH_STREAM_IDLE_TIMEOUT_SECONDS:.0f}s"
                        )
                    continue
                message_type, payload = self._conn.recv()
                with self._condition:
                    self._last_fish_activity_at = time.monotonic()
                if message_type == "live_ready":
                    self._engine._emit_playback_event(
                        "progressive_fish_ready",
                        stream_id=self.stream_id,
                        phase=self._phase,
                        latency_ms=int(round((time.monotonic() - self._started_at) * 1000)),
                    )
                    continue
                if message_type == "done":
                    self._stream_reusable = True
                    with self._condition:
                        self._synthesis_done = True
                        self._condition.notify_all()
                    return
                if message_type in {"error", "worker_error"}:
                    raise RuntimeError(f"Fish Audio progressive worker failed: {payload}")
                if message_type != "chunk" or not payload:
                    continue
                chunk = bytes(payload)
                with self._condition:
                    self._fish_owes_audio = False
                    max_bytes = self._pcm_bytes_for_ms(PROGRESSIVE_PCM_MAX_MS)
                    while self._buffered_bytes >= max_bytes and not self._closed:
                        self._condition.wait(timeout=0.25)
                    if self._closed:
                        return
                    self._pcm_chunks.append(chunk)
                    self._buffered_bytes += len(chunk)
                    self._total_bytes += len(chunk)
                    self._condition.notify_all()
        except Exception as err:
            with self._condition:
                self._error = err
                self._synthesis_done = True
                self._condition.notify_all()
            self._cancel_source()
        finally:
            self._engine._stop_fish_stream_process(
                self._stream_proc,
                self._conn,
                reusable=self._stream_reusable,
            )

    def _play_pcm(self) -> None:
        if callable(getattr(self, "_output_chunk_callback", None)):
            self._stream_pcm_to_output()
            return
        aplay_proc = None
        tap_stream = None
        try:
            startup_bytes = self._pcm_bytes_for_ms(PROGRESSIVE_PCM_STARTUP_MS)
            with self._condition:
                while (
                    not self._startup_buffer_ready_locked(startup_bytes)
                    and not self._synthesis_done
                    and not self._error
                    and not self._closed
                ):
                    self._condition.wait(timeout=0.25)
                if self._error or self._closed:
                    return
                if self._buffered_bytes <= 0 and self._synthesis_done:
                    return
            aplay_proc = subprocess.Popen(
                [
                    "aplay",
                    "-q",
                    "-D",
                    self._engine._device,
                    "-f",
                    "S16_LE",
                    "-r",
                    str(self._engine._fish_sample_rate),
                    "-c",
                    "1",
                    "-t",
                    "raw",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            tap = getattr(self._engine, "_playback_audio_tap", None)
            tap_stream = (
                tap.begin_stream(
                    sample_rate=self._engine._fish_sample_rate,
                    channels=1,
                    sample_width=SAMPLE_WIDTH,
                    phase=self._phase,
                )
                if tap is not None
                else None
            )
            gap_open = False
            while True:
                with self._condition:
                    while not self._pcm_chunks and not self._synthesis_done and not self._error and not self._closed:
                        buffered_ahead_ms = self._buffered_ahead_ms_locked()
                        if self._partial_audio and buffered_ahead_ms <= 0 and not gap_open:
                            self._underruns += 1
                            gap_open = True
                            self._engine._emit_playback_event(
                                "progressive_buffer_underrun",
                                stream_id=self.stream_id,
                                phase=self._phase,
                                underruns=self._underruns,
                                buffered_audio_ms=buffered_ahead_ms,
                            )
                        wait_seconds = 0.1
                        if self._partial_audio and buffered_ahead_ms > 0:
                            wait_seconds = min(0.1, max(0.01, buffered_ahead_ms / 1000.0))
                        self._condition.wait(timeout=wait_seconds)
                    if self._error:
                        raise self._error
                    if self._closed:
                        return
                    if not self._pcm_chunks and self._synthesis_done:
                        break
                    chunk = self._pcm_chunks.popleft()
                    self._buffered_bytes = max(0, self._buffered_bytes - len(chunk))
                    self._condition.notify_all()
                gap_open = False
                if not aplay_proc.stdin:
                    raise RuntimeError("aplay stdin was unavailable for progressive speech")
                if tap_stream is not None:
                    tap_stream.append(chunk)
                write_started_at = time.monotonic()
                with self._condition:
                    self._record_aplay_write_locked(len(chunk), now=write_started_at)
                first_audio = not self._partial_audio
                if first_audio:
                    # Treat the first external write as committed before making it.
                    # A short/partial write can still raise after PCM reached the
                    # device, and replaying the legacy answer then would duplicate
                    # speech the listener may already have heard.
                    self._partial_audio = True
                    self._playback_started_at = write_started_at
                    self._first_audio_ms = int(round((write_started_at - self._started_at) * 1000))
                    self._question_to_first_audio_ms = (
                        int(round((write_started_at - self._turn_complete_at) * 1000))
                        if self._turn_complete_at is not None
                        else None
                    )
                aplay_proc.stdin.write(chunk)
                aplay_proc.stdin.flush()
                now = time.monotonic()
                with self._condition:
                    buffered_ms = self._buffered_ahead_ms_locked(now=now)
                if first_audio:
                    self._engine._emit_playback_event(
                        "tts_playback_started",
                        backend="fish_progressive",
                        stream_id=self.stream_id,
                        phase=self._phase,
                        utterance=" ".join(self._segments).strip(),
                        first_audio_ms=self._first_audio_ms,
                        question_to_first_audio_ms=self._question_to_first_audio_ms,
                        buffered_audio_ms=buffered_ms,
                    )
                elif buffered_ms < PROGRESSIVE_PCM_TARGET_MS:
                    self._engine._emit_playback_event(
                        "progressive_buffer_low",
                        stream_id=self.stream_id,
                        phase=self._phase,
                        buffered_audio_ms=buffered_ms,
                    )
            if aplay_proc.stdin:
                aplay_proc.stdin.close()
            if tap_stream is not None:
                tap_stream.finish()
                tap_stream = None
            stderr = aplay_proc.stderr.read() if aplay_proc.stderr else b""
            if aplay_proc.wait() != 0:
                detail = stderr.decode("utf-8", errors="ignore").strip()
                raise RuntimeError(f"aplay failed for progressive Fish stream: {detail}")
            self._playback_finished_at = time.monotonic()
        except Exception as err:
            with self._condition:
                self._error = err
                self._closed = True
                self._condition.notify_all()
            self._cancel_source()
            with contextlib.suppress(Exception):
                self._send("live_abort", {})
        finally:
            if tap_stream is not None:
                with contextlib.suppress(Exception):
                    tap_stream.finish()
            if aplay_proc is not None and aplay_proc.poll() is None:
                with contextlib.suppress(Exception):
                    if aplay_proc.stdin:
                        aplay_proc.stdin.close()
                with contextlib.suppress(Exception):
                    aplay_proc.terminate()
                with contextlib.suppress(Exception):
                    aplay_proc.wait(timeout=2)

    def _stream_pcm_to_output(self) -> None:
        output_opened = False
        try:
            startup_bytes = self._pcm_bytes_for_ms(PROGRESSIVE_PCM_STARTUP_MS)
            with self._condition:
                while (
                    not self._startup_buffer_ready_locked(startup_bytes)
                    and not self._synthesis_done
                    and not self._error
                    and not self._closed
                ):
                    self._condition.wait(timeout=0.25)
                if self._error or self._closed:
                    return
                if self._buffered_bytes <= 0 and self._synthesis_done:
                    return
            while True:
                with self._condition:
                    while not self._pcm_chunks and not self._synthesis_done and not self._error and not self._closed:
                        self._condition.wait(timeout=0.1)
                    if self._error:
                        raise self._error
                    if self._closed:
                        return
                    if not self._pcm_chunks and self._synthesis_done:
                        break
                    chunk = self._pcm_chunks.popleft()
                    self._buffered_bytes = max(0, self._buffered_bytes - len(chunk))
                    self._condition.notify_all()
                if not output_opened:
                    start_callback = getattr(self, "_output_start_callback", None)
                    if callable(start_callback):
                        start_callback({
                            "backend": "fish_progressive",
                            "stream_id": self.stream_id,
                            "phase": self._phase,
                            "sample_rate": self._engine._fish_sample_rate,
                            "channels": 1,
                            "sample_width": SAMPLE_WIDTH,
                            "text": self.utterance,
                        })
                    output_opened = True
                write_started_at = time.monotonic()
                with self._condition:
                    self._record_aplay_write_locked(len(chunk), now=write_started_at)
                    self._condition.notify_all()
                first_audio = not self._partial_audio
                if first_audio:
                    # The callback writes to the HTTP client. Mark the answer as
                    # committed first because a broken socket may report failure
                    # only after accepting part of this PCM chunk.
                    self._partial_audio = True
                    self._playback_started_at = write_started_at
                    self._first_audio_ms = int(round((write_started_at - self._started_at) * 1000))
                    self._question_to_first_audio_ms = (
                        int(round((write_started_at - self._turn_complete_at) * 1000))
                        if self._turn_complete_at is not None
                        else None
                    )
                self._output_chunk_callback(chunk)
                if first_audio:
                    self._engine._emit_playback_event(
                        "tts_playback_started",
                        backend="fish_progressive_browser",
                        stream_id=self.stream_id,
                        phase=self._phase,
                        utterance=self.utterance,
                        first_audio_ms=self._first_audio_ms,
                        question_to_first_audio_ms=self._question_to_first_audio_ms,
                    )
            self._playback_finished_at = time.monotonic()
        except Exception as err:
            with self._condition:
                self._error = err
                self._closed = True
                self._condition.notify_all()
            self._cancel_source()
            with contextlib.suppress(Exception):
                self._send("live_abort", {})
        finally:
            if output_opened:
                close_callback = getattr(self, "_output_close_callback", None)
                if callable(close_callback):
                    with contextlib.suppress(Exception):
                        close_callback({
                            "backend": "fish_progressive",
                            "phase": self._phase,
                            "sample_rate": self._engine._fish_sample_rate,
                        })

    def _pcm_bytes_for_ms(self, milliseconds: int) -> int:
        return max(
            SAMPLE_WIDTH,
            int(self._engine._fish_sample_rate * SAMPLE_WIDTH * max(0, int(milliseconds)) / 1000),
        )

    def _buffer_ms_locked(self) -> int:
        bytes_per_second = max(1, self._engine._fish_sample_rate * SAMPLE_WIDTH)
        return int(round(self._buffered_bytes * 1000 / bytes_per_second))

    def _advance_aplay_clock_locked(self, now: float | None = None) -> None:
        current = time.monotonic() if now is None else float(now)
        if self._aplay_accounted_at is not None:
            elapsed_seconds = max(0.0, current - self._aplay_accounted_at)
            bytes_per_second = max(1, self._engine._fish_sample_rate * SAMPLE_WIDTH)
            self._aplay_unplayed_bytes = max(
                0.0,
                self._aplay_unplayed_bytes - (elapsed_seconds * bytes_per_second),
            )
        self._aplay_accounted_at = current

    def _record_aplay_write_locked(self, byte_count: int, now: float | None = None) -> None:
        self._advance_aplay_clock_locked(now=now)
        self._aplay_unplayed_bytes += max(0, int(byte_count))

    def _buffered_ahead_ms_locked(self, now: float | None = None) -> int:
        self._advance_aplay_clock_locked(now=now)
        bytes_per_second = max(1, self._engine._fish_sample_rate * SAMPLE_WIDTH)
        total_bytes = float(self._buffered_bytes) + self._aplay_unplayed_bytes
        return int(round(total_bytes * 1000 / bytes_per_second))


class JarvisClient:
    def __init__(self, url: str, token: str, room: str, channel: str, source_via: str):
        self._url = url
        self._token = token
        self._room = room
        self._channel = channel
        self._source_via = source_via

    def ask(
        self,
        utterance: str,
        speaker_name: str = "",
        speaker_confidence: float = 0.0,
        session_id: str = "",
        endpoint: dict | None = None,
    ) -> JarvisReply:
        payload = json.dumps(
            self._payload_data(
                utterance,
                speaker_name=speaker_name,
                speaker_confidence=speaker_confidence,
                session_id=session_id,
                endpoint=endpoint,
            )
        ).encode("utf-8")
        request = urllib.request.Request(
            self._url,
            data=payload,
            headers={
                "content-type": "application/json",
                "x-jarvis-token": self._token,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                body = response.read().decode("utf-8")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, socket.timeout, OSError) as err:
            raise RuntimeError(f"brain chat request failed: {err}") from err
        return self._reply_from_data(json.loads(body))

    def ask_stream(
        self,
        utterance: str,
        speaker_name: str = "",
        speaker_confidence: float = 0.0,
        session_id: str = "",
        on_start=None,
        on_speech=None,
        on_open=None,
        endpoint: dict | None = None,
    ) -> JarvisReply:
        payload = json.dumps(
            self._payload_data(
                utterance,
                speaker_name=speaker_name,
                speaker_confidence=speaker_confidence,
                session_id=session_id,
                endpoint=endpoint,
            )
        ).encode("utf-8")
        request = urllib.request.Request(
            self._progressive_url(),
            data=payload,
            headers={
                "accept": "application/x-ndjson",
                "content-type": "application/json",
                "x-jarvis-token": self._token,
            },
            method="POST",
        )
        opened = False
        start_seen = False
        terminal_seen = False
        stream_id = ""
        max_words = 100
        event_count = 0
        total_bytes = 0
        speech_texts: list[str] = []
        speech_comparisons: list[str] = []
        final_response = None
        final_spoken_text = ""
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                opened = True
                if callable(on_open):
                    on_open(response.close)
                content_type = str(response.headers.get("content-type", "")).lower()
                if "application/x-ndjson" not in content_type:
                    raise ProgressiveStreamUnavailable(
                        f"brain progressive endpoint returned {content_type or 'an unknown content type'}"
                    )
                while True:
                    raw_line = response.readline(PROGRESSIVE_EVENT_LINE_MAX_BYTES + 1)
                    if not raw_line:
                        break
                    if len(raw_line) > PROGRESSIVE_EVENT_LINE_MAX_BYTES:
                        raise RuntimeError("brain progressive event exceeded its line limit")
                    total_bytes += len(raw_line)
                    if total_bytes > PROGRESSIVE_EVENT_TOTAL_MAX_BYTES:
                        raise RuntimeError("brain progressive response exceeded its byte limit")
                    event_count += 1
                    if event_count > PROGRESSIVE_EVENT_MAX_COUNT:
                        raise RuntimeError("brain progressive response emitted too many events")
                    try:
                        event = json.loads(raw_line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as err:
                        raise RuntimeError(f"brain progressive event was invalid JSON: {err}") from err
                    if not isinstance(event, dict):
                        raise RuntimeError("brain progressive event was not an object")
                    event_type = str(event.get("event") or "").strip()
                    if terminal_seen:
                        raise RuntimeError("brain progressive response emitted data after its terminal event")
                    if not start_seen:
                        if event_type != "start" or int(event.get("protocol") or 0) != 1:
                            raise RuntimeError("brain progressive response did not begin with protocol 1")
                        stream_id = str(event.get("stream_id") or "").strip()
                        if not stream_id:
                            raise RuntimeError("brain progressive start event omitted stream_id")
                        try:
                            max_words = int(event.get("max_words") or 0)
                        except (TypeError, ValueError) as err:
                            raise RuntimeError("brain progressive start event had invalid max_words") from err
                        if max_words < 1 or max_words > 100:
                            raise RuntimeError("brain progressive max_words exceeded the client contract")
                        start_seen = True
                        if callable(on_start):
                            on_start(event)
                        continue
                    if event_type == "error":
                        terminal_seen = True
                        message = " ".join(str(event.get("message") or "progressive turn failed").split()).strip()
                        raise ProgressiveTurnError(
                            message,
                            fallback_allowed=bool(event.get("fallback_allowed", not speech_texts)),
                        )
                    if str(event.get("stream_id") or "").strip() != stream_id:
                        raise RuntimeError("brain progressive event changed stream_id")
                    if event_type == "speech":
                        expected_sequence = len(speech_texts) + 1
                        try:
                            sequence = int(event.get("seq") or 0)
                        except (TypeError, ValueError) as err:
                            raise RuntimeError("brain progressive speech sequence was invalid") from err
                        if sequence != expected_sequence:
                            raise RuntimeError("brain progressive speech sequence was not contiguous")
                        text = " ".join(str(event.get("text") or "").split()).strip()
                        fish_text = " ".join(str(event.get("fish_text") or text).split()).strip()
                        if not text or not fish_text or len(text) > 4096 or len(fish_text) > 8192:
                            raise RuntimeError("brain progressive speech event contained invalid text")
                        comparison = re.sub(r"[^\w]+", " ", text.lower(), flags=re.UNICODE).strip()
                        if any(
                            comparison == existing
                            or (len(comparison) >= 24 and comparison in existing)
                            or (len(existing) >= 24 and existing in comparison)
                            for existing in speech_comparisons
                        ):
                            raise RuntimeError("brain progressive speech repeated committed text")
                        candidate_words = sum(len(re.findall(r"\S+", item)) for item in [*speech_texts, text])
                        if candidate_words > max_words or candidate_words > 100:
                            raise RuntimeError("brain progressive speech exceeded its word budget")
                        speech_texts.append(text)
                        speech_comparisons.append(comparison)
                        if callable(on_speech):
                            on_speech({**event, "text": text, "fish_text": fish_text})
                        continue
                    if event_type == "final":
                        try:
                            segment_count = int(event.get("segment_count") or 0)
                        except (TypeError, ValueError) as err:
                            raise RuntimeError("brain progressive final segment_count was invalid") from err
                        final_spoken_text = " ".join(str(event.get("spoken_text") or "").split()).strip()
                        if segment_count != len(speech_texts) or final_spoken_text != " ".join(speech_texts):
                            raise RuntimeError("brain progressive final did not match committed speech")
                        final_response = event.get("response")
                        if not isinstance(final_response, dict):
                            raise RuntimeError("brain progressive final omitted its response")
                        terminal_seen = True
                        continue
                    raise RuntimeError(f"brain progressive event type was unsupported: {event_type or 'missing'}")
        except urllib.error.HTTPError as err:
            if err.code in {404, 405, 406}:
                raise ProgressiveStreamUnavailable(
                    f"brain progressive endpoint is unavailable (HTTP {err.code})"
                ) from err
            raise ProgressiveTurnError(
                f"brain progressive request failed: HTTP {err.code}",
                fallback_allowed=not speech_texts,
            ) from err
        except ProgressiveStreamUnavailable:
            raise
        except ProgressiveTurnError:
            raise
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as err:
            if not opened:
                raise ProgressiveStreamUnavailable(f"brain progressive request failed: {err}") from err
            raise ProgressiveTurnError(
                f"brain progressive stream failed: {err}",
                fallback_allowed=not speech_texts,
            ) from err
        except Exception as err:
            raise ProgressiveTurnError(
                f"brain progressive protocol failed: {err}",
                fallback_allowed=not speech_texts,
            ) from err
        finally:
            if callable(on_open):
                with contextlib.suppress(Exception):
                    on_open(None)
        if not start_seen or not terminal_seen or not isinstance(final_response, dict):
            raise ProgressiveTurnError(
                "brain progressive response ended before its final event",
                fallback_allowed=not speech_texts,
            )
        reply = self._reply_from_data(final_response)
        reply.text = final_spoken_text or reply.text
        return reply

    def _payload_data(
        self,
        utterance: str,
        speaker_name: str = "",
        speaker_confidence: float = 0.0,
        session_id: str = "",
        endpoint: dict | None = None,
    ) -> dict:
        payload_data = {
            "utterance": utterance,
            "room": self._room,
            "channel": self._channel,
            "source_via": self._source_via,
            "conversation_mode": True,
        }
        # The speaker the turn came from and its Music Assistant player.
        if isinstance(endpoint, dict) and endpoint.get("id"):
            payload_data["endpoint"] = endpoint
        normalized_session_id = str(session_id or "").strip()
        if normalized_session_id:
            payload_data["session_id"] = normalized_session_id
        speaker = str(speaker_name or "").strip()
        if speaker:
            payload_data["voice_id"] = speaker_person_ids().get(speaker, speaker)
            payload_data["speaker_name"] = speaker
            payload_data["speaker_confidence"] = max(0.0, float(speaker_confidence or 0.0))
        return payload_data

    def _progressive_url(self) -> str:
        parsed = urllib.parse.urlparse(self._url)
        path = parsed.path.rstrip("/")
        if path.endswith("/voice/brain"):
            path = f"{path}/stream"
        elif path.endswith("/chat"):
            path = f"{path[:-len('/chat')]}/voice/brain/stream"
        else:
            path = "/voice/brain/stream"
        return urllib.parse.urlunparse(parsed._replace(path=path, query="", fragment=""))

    def _reply_from_data(self, data: dict) -> JarvisReply:
        if not isinstance(data, dict):
            raise RuntimeError("brain response was not an object")
        text = " ".join(str(data.get("response", data.get("text", ""))).split()).strip()
        speech = data.get("speech") if isinstance(data.get("speech"), dict) else None
        voice_response = data.get("voice_response") if isinstance(data.get("voice_response"), dict) else None
        normalized_speech = self._normalize_speech_metadata(speech)
        tail = self._extract_tail_metadata(data, normalized_speech)
        return JarvisReply(
            text=text,
            model_used=data.get("modelUsed") is True,
            usage=data.get("usage") if isinstance(data.get("usage"), dict) else None,
            failure=self._extract_failure_metadata(data, fallback_text=text),
            speech=normalized_speech,
            voice_response={
                key: value
                for key, value in (voice_response or {}).items()
                if value is not None
            } or None,
            tail=tail,
        )

    def poll_tail(self, tail: dict | None, timeout_seconds: float = 1.2, interval_seconds: float = 0.08) -> JarvisTail:
        metadata = tail if isinstance(tail, dict) else {}
        poll_url = self._tail_poll_url(metadata)
        if not poll_url:
            return JarvisTail(status="skipped", reason="tail_poll_missing")
        deadline = time.monotonic() + max(0.0, float(timeout_seconds or 0.0))
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    self.cancel_tail(metadata)
                    return JarvisTail(status="timeout", reason="tail_poll_timeout")
                snapshot = self._fetch_tail_snapshot(
                    poll_url,
                    timeout_seconds=min(0.5, max(0.05, remaining)),
                )
                status = str(snapshot.get("status") or "").strip().lower()
                if status and status != "pending":
                    return self._tail_from_snapshot(snapshot)
                time.sleep(min(max(0.02, float(interval_seconds or 0.08)), max(0.0, deadline - time.monotonic())))
        except Exception:
            self.cancel_tail(metadata)
            raise

    def cancel_tail(self, tail: dict | None) -> bool:
        metadata = tail if isinstance(tail, dict) else {}
        poll_url = self._tail_poll_url(metadata)
        if not poll_url:
            return False
        request = urllib.request.Request(
            poll_url,
            headers={"x-jarvis-token": self._token},
            method="DELETE",
        )
        try:
            with urllib.request.urlopen(request, timeout=0.5) as response:
                response.read()
            return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, socket.timeout, OSError):
            return False

    def _tail_poll_url(self, tail: dict) -> str:
        explicit = str(tail.get("poll_url") or tail.get("url") or "").strip()
        if explicit:
            return explicit
        path = str(tail.get("poll_path") or "").strip()
        if not path:
            return ""
        return urllib.parse.urljoin(self._url, path)

    def _fetch_tail_snapshot(self, poll_url: str, timeout_seconds: float = 0.5) -> dict:
        request = urllib.request.Request(
            poll_url,
            headers={"x-jarvis-token": self._token},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=max(0.05, float(timeout_seconds or 0.5))) as response:
                body = response.read().decode("utf-8")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, socket.timeout, OSError) as err:
            raise RuntimeError(f"brain tail request failed: {err}") from err
        data = json.loads(body)
        snapshot = data.get("tail") if isinstance(data, dict) else None
        if not isinstance(snapshot, dict):
            raise RuntimeError("brain tail response missing tail snapshot")
        return snapshot

    def _tail_from_snapshot(self, snapshot: dict) -> JarvisTail:
        status = str(snapshot.get("status") or "").strip().lower()
        text = " ".join(str(snapshot.get("text") or "").split()).strip()
        fish_text = " ".join(str(snapshot.get("fish_text") or snapshot.get("fishText") or "").split()).strip()
        tone = str(snapshot.get("tone") or "").strip()
        speech = {
            **({"fish_text": fish_text} if fish_text and fish_text != text else {}),
            **({"tone": tone} if tone else {}),
        } or None
        latency_ms = snapshot.get("latencyMs", snapshot.get("latency_ms"))
        try:
            normalized_latency = int(latency_ms) if latency_ms is not None else None
        except (TypeError, ValueError):
            normalized_latency = None
        return JarvisTail(
            status=status,
            text=text if status == "ready" else "",
            speech=speech,
            reason=" ".join(str(snapshot.get("reason") or "").split()).strip(),
            latency_ms=normalized_latency,
        )

    def _normalize_speech_metadata(self, speech: dict | None) -> dict | None:
        if not isinstance(speech, dict):
            return None
        normalized: dict = {}
        for key, value in speech.items():
            clean_key = str(key or "").strip()
            if not clean_key or value is None:
                continue
            if clean_key == "tail" and isinstance(value, dict):
                nested = {
                    str(nested_key).strip(): nested_value
                    for nested_key, nested_value in value.items()
                    if str(nested_key or "").strip() and nested_value is not None
                }
                if nested:
                    normalized[clean_key] = nested
                continue
            clean_value = str(value).strip()
            if clean_value:
                normalized[clean_key] = clean_value
        return normalized or None

    def _extract_tail_metadata(self, data: dict, speech: dict | None) -> dict | None:
        candidates = []
        if isinstance(speech, dict):
            candidates.append(speech.get("tail"))
        candidates.append(data.get("tail") if isinstance(data, dict) else None)
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            normalized = {
                str(key).strip(): value
                for key, value in candidate.items()
                if str(key or "").strip() and value is not None
            }
            status = str(normalized.get("status") or "").strip()
            poll_path = str(normalized.get("poll_path") or normalized.get("poll_url") or normalized.get("url") or "").strip()
            if status or poll_path:
                return normalized
        return None

    def _extract_failure_metadata(self, data: dict, fallback_text: str = "") -> JarvisFailureMetadata | None:
        if not isinstance(data, dict):
            return None
        failure = data.get("failure")
        prompt_metrics = data.get("prompt_metrics")
        code = ""
        summary = ""
        provider = ""
        retryable = True

        if isinstance(failure, dict):
            code = str(failure.get("code", "")).strip()
            summary = " ".join(str(failure.get("summary", "")).split()).strip()
            provider = str(failure.get("provider", "")).strip()
            retryable = bool(failure.get("retryable", True))

        if not code and isinstance(prompt_metrics, dict) and prompt_metrics.get("engine_error_fallback"):
            code = str(prompt_metrics.get("error_class") or prompt_metrics.get("prompt_subtype") or "").strip()
        if not code and data.get("engine_error_fallback"):
            code = str(data.get("error_class") or data.get("prompt_subtype") or "").strip()
        if not summary and code and fallback_text:
            summary = " ".join(str(fallback_text).split()).strip()
        if not code:
            return None
        return JarvisFailureMetadata(
            code=code,
            summary=summary,
            provider=provider,
            retryable=retryable,
        )


def build_tts_engine(config: Config) -> TtsEngine:
    return TtsEngine(
        config.output_device,
        config.tts_voice,
        config.tts_speed,
        config.tts_pitch,
        fish_audio_enabled=config.fish_audio_enabled,
        fish_audio_api_key=config.fish_audio_api_key,
        fish_audio_voice_id=config.fish_audio_voice_id,
        fish_audio_model=config.fish_audio_model,
        fish_audio_latency=config.fish_audio_latency,
        fish_audio_sample_rate=config.fish_audio_sample_rate,
        fish_tts_speed=config.fish_tts_speed,
        fish_tts_volume_db=config.fish_tts_volume_db,
        fish_tts_temperature=config.fish_tts_temperature,
        fish_tts_top_p=config.fish_tts_top_p,
        fish_tts_chunk_length=config.fish_tts_chunk_length,
        fish_tts_repetition_penalty=config.fish_tts_repetition_penalty,
        fish_tts_condition_on_previous_chunks=config.fish_tts_condition_on_previous_chunks,
        fish_tts_tone_enabled=config.fish_tts_tone_enabled,
        fish_tts_comma_breaks=config.fish_tts_comma_breaks,
        fish_tts_tone_tags=config.fish_tts_tone_tags,
        fish_tts_night_enabled=config.fish_tts_night_enabled,
        fish_tts_night_start=config.fish_tts_night_start,
        fish_tts_night_end=config.fish_tts_night_end,
        fish_tts_night_volume_db=config.fish_tts_night_volume_db,
        fish_tts_night_speed=config.fish_tts_night_speed,
        ha_tts_entity=config.ha_tts_entity,
    )


class VoiceClipBridge:
    def __init__(self, manifest_url: str, token: str, device: str, request_timeout_seconds: float, cache_seconds: float):
        self._manifest_url = str(manifest_url or "").strip()
        self._token = str(token or "").strip()
        self._device = str(device or "").strip()
        self._request_timeout_seconds = max(1.0, float(request_timeout_seconds))
        self._cache_seconds = max(0.0, float(cache_seconds))
        self._cached_manifests: dict[str, dict] = {}
        self._last_clip_names: dict[str, str] = {}

    def play_wake_greeting(self, speaker: str = DEFAULT_GREETING_SPEAKER) -> bool:
        normalized_speaker = str(speaker or DEFAULT_GREETING_SPEAKER).strip() or DEFAULT_GREETING_SPEAKER
        greeting_played = self.play_random_clip("generalGreetings", speaker=normalized_speaker)
        if not greeting_played:
            return False
        self.play_random_clip("afterGreetings")
        return True

    def play_wait_clip(self) -> bool:
        return self.play_random_clip("waitTimes")

    def play_wait_extended_clip(self) -> bool:
        return self.play_random_clip("waitExtended")

    def play_thinking_clip(self) -> bool:
        return self.play_random_clip("thinking")

    def play_goodbye_clip(self) -> bool:
        return self.play_random_clip("goodbyes", speaker=DEFAULT_GREETING_SPEAKER)

    def play_local_clip(self, clip_path: str, speed: float = 1.0, volume: float = 1.0) -> bool:
        normalized = str(clip_path or "").strip()
        if not normalized:
            return False
        expanded = os.path.expanduser(normalized)
        if not os.path.isfile(expanded):
            log(f"local voice clip missing: {expanded}")
            return False
        log(f"playing local voice clip: {expanded}")
        self._play_clip_file(expanded, speed=speed, volume=volume)
        return True

    def play_random_clip(self, clip_set: str, speaker: str = "") -> bool:
        if not self._manifest_url or not self._token:
            log("voice clip bridge disabled: manifest URL or token missing")
            return False

        clips = self._load_manifest(clip_set, speaker=speaker)
        if not clips:
            log(f"voice clip bridge has no clips for set={clip_set} speaker={speaker or '-'}")
            return False

        clip_key = self._cache_key(clip_set, speaker)
        candidates = clips
        last_clip_name = self._last_clip_names.get(clip_key, "")
        if last_clip_name and len(clips) > 1:
            filtered = [clip for clip in clips if str(clip.get("name", "")).strip() != last_clip_name]
            if filtered:
                candidates = filtered

        clip = random.choice(candidates)
        clip_name = str(clip.get("name", "")).strip()
        clip_url = str(clip.get("url", "")).strip()
        if not clip_name or not clip_url:
            log(f"voice clip bridge received malformed clip metadata for set={clip_set}; skipping")
            return False

        clip_path = self._download_clip(clip_name, clip_url)
        try:
            label = f"{clip_set}:{speaker}" if speaker else clip_set
            log(f"playing voice clip [{label}]: {clip_name}")
            self._play_clip_file(clip_path)
            self._last_clip_names[clip_key] = clip_name
            return True
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(clip_path)

    def _load_manifest(self, clip_set: str, speaker: str = "") -> list[dict]:
        cache_key = self._cache_key(clip_set, speaker)
        cached = self._cached_manifests.get(cache_key) or {}
        now = time.monotonic()
        if cached.get("clips") and (now - float(cached.get("cached_at", 0.0))) <= self._cache_seconds:
            return list(cached.get("clips", []))

        request = urllib.request.Request(
            self._build_manifest_url(clip_set, speaker=speaker),
            headers={
                "x-jarvis-token": self._token,
            },
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=self._request_timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))

        clips = payload.get("clips", [])
        if not isinstance(clips, list):
            raise RuntimeError("voice clip manifest clips field was not a list")

        normalized = []
        for clip in clips:
            if not isinstance(clip, dict):
                continue
            name = str(clip.get("name", "")).strip()
            url = str(clip.get("url", "")).strip()
            if not name or not url:
                continue
            normalized.append({"name": name, "url": url})

        self._cached_manifests[cache_key] = {
            "clips": normalized,
            "cached_at": now,
        }
        return normalized

    def _build_manifest_url(self, clip_set: str, speaker: str = "") -> str:
        parsed = urllib.parse.urlparse(self._manifest_url)
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        query = [(key, value) for key, value in query if key not in {"set", "speaker", "profile"}]
        query.append(("set", clip_set))
        if speaker:
            query.append(("speaker", speaker))
        return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))

    def _cache_key(self, clip_set: str, speaker: str = "") -> str:
        return f"{clip_set}|{str(speaker or '').strip().lower()}"

    def _download_clip(self, clip_name: str, clip_url: str) -> str:
        suffix = os.path.splitext(clip_name)[1] or ".bin"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            clip_path = handle.name
        try:
            request = urllib.request.Request(
                clip_url,
                headers={
                    "x-jarvis-token": self._token,
                },
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=self._request_timeout_seconds) as response:
                handle = open(clip_path, "wb")
                try:
                    handle.write(response.read())
                finally:
                    handle.close()
        except Exception:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(clip_path)
            raise
        return clip_path

    def _play_clip_file(self, clip_path: str, speed: float = 1.0, volume: float = 1.0) -> None:
        normalized_speed = max(0.5, min(2.0, float(speed or 1.0)))
        normalized_volume = max(0.0, min(2.0, float(volume if volume is not None else 1.0)))
        ffmpeg_cmd = [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            clip_path,
        ]
        filters = []
        if abs(normalized_speed - 1.0) > 0.001:
            filters.append(f"atempo={normalized_speed:.3f}")
        if abs(normalized_volume - 1.0) > 0.001:
            filters.append(f"volume={normalized_volume:.3f}")
        if filters:
            ffmpeg_cmd.extend(["-filter:a", ",".join(filters)])
        ffmpeg_cmd.extend([
            "-f",
            "wav",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-",
        ])
        ffmpeg_proc = subprocess.Popen(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            if not ffmpeg_proc.stdout:
                raise RuntimeError("ffmpeg pipe did not open")
            aplay_proc = subprocess.run(
                ["aplay", "-q", "-D", self._device],
                stdin=ffmpeg_proc.stdout,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            _ = aplay_proc
            ffmpeg_proc.stdout.close()
            ffmpeg_stderr = ffmpeg_proc.communicate()[1]
        finally:
            if ffmpeg_proc.stdout:
                with contextlib.suppress(Exception):
                    ffmpeg_proc.stdout.close()

        if ffmpeg_proc.returncode != 0:
            raise RuntimeError(f"ffmpeg waiting-audio decode failed: {ffmpeg_stderr.decode('utf-8', errors='ignore').strip()}")


def text_matches_prompt_line(text: str, prompt_lines: list[str]) -> bool:
    candidate = normalize_text(text)
    if not candidate:
        return False
    for prompt_line in prompt_lines:
        prompt_normalized = normalize_text(prompt_line)
        if prompt_normalized and candidate == prompt_normalized:
            return True
    return False


def wake_greeting_slot(hour: int) -> str:
    if hour < 12:
        return "morning"
    if hour < 18:
        return "afternoon"
    return "evening"


def all_wake_greetings() -> list[str]:
    return [line for lines in WAKE_GREETINGS.values() for line in lines]


class PromptTextBridge:
    def __init__(self, manifest_path: str, now=None):
        self._manifest_path = str(manifest_path or "").strip()
        self._now = now or (lambda: datetime.now(LOCAL_GREETING_TIMEZONE))
        self._cached_manifest: dict | None = None
        self._cached_mtime: float | None = None
        self._last_choices: dict[str, str] = {}
        self._greeting_bags: dict[str, list[str]] = {}
        self._last_greeting = ""

    def build_wake_greeting(self, speaker: str = DEFAULT_GREETING_SPEAKER, prefer=None) -> str:
        """A shuffle bag per time of day: every line plays once before any
        repeats, and a new bag never opens with the line just spoken."""
        _ = speaker
        current = self._now()
        if current.tzinfo is None:
            current = current.replace(tzinfo=LOCAL_GREETING_TIMEZONE)
        else:
            current = current.astimezone(LOCAL_GREETING_TIMEZONE)
        slot = wake_greeting_slot(current.hour)
        bag = self._greeting_bags.get(slot)
        if not bag:
            bag = list(WAKE_GREETINGS[slot])
            random.shuffle(bag)
            if len(bag) > 1 and bag[-1] == self._last_greeting:
                bag[0], bag[-1] = bag[-1], bag[0]
            self._greeting_bags[slot] = bag
        # A line already rendered plays at once; take the next one of those
        # still in the bag, so the shuffle holds and Fish is not needed.
        index = len(bag) - 1
        if callable(prefer):
            index = next((i for i in range(len(bag) - 1, -1, -1) if prefer(bag[i])), index)
        self._last_greeting = bag.pop(index)
        return self._last_greeting

    def choose_text(self, clip_set: str, speaker: str = "") -> str:
        manifest = self._load_manifest()
        if not manifest:
            return ""
        bucket = manifest.get(str(clip_set or "").strip())
        lines = self._resolve_lines(bucket, speaker=speaker)
        if not lines:
            return ""
        choice_key = self._choice_key(clip_set, speaker)
        candidates = lines
        last_choice = self._last_choices.get(choice_key, "")
        if last_choice and len(lines) > 1:
            filtered = [line for line in lines if line != last_choice]
            if filtered:
                candidates = filtered
        selected = random.choice(candidates)
        self._last_choices[choice_key] = selected
        return selected

    def all_lines(self) -> list[str]:
        manifest = self._load_manifest()
        collected: list[str] = []
        self._collect_lines(manifest, collected)
        return collected

    def _choice_key(self, clip_set: str, speaker: str = "") -> str:
        normalized_speaker = str(speaker or "").strip() or DEFAULT_GREETING_SPEAKER
        return f"{clip_set}:{normalized_speaker}"

    def _load_manifest(self) -> dict:
        if not self._manifest_path or not os.path.isfile(self._manifest_path):
            return {}
        try:
            current_mtime = os.path.getmtime(self._manifest_path)
        except OSError:
            return {}
        if self._cached_manifest is not None and self._cached_mtime == current_mtime:
            return self._cached_manifest
        try:
            with open(self._manifest_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError) as err:
            log(f"prompt text manifest load failed: {err}")
            self._cached_manifest = {}
            self._cached_mtime = current_mtime
            return {}
        if not isinstance(payload, dict):
            log("prompt text manifest root must be a JSON object")
            self._cached_manifest = {}
            self._cached_mtime = current_mtime
            return {}
        self._cached_manifest = payload
        self._cached_mtime = current_mtime
        return payload

    def _resolve_lines(self, bucket, speaker: str = "") -> list[str]:
        if isinstance(bucket, str):
            text = " ".join(bucket.split()).strip()
            return [text] if text else []
        if isinstance(bucket, list):
            return self._normalize_lines(bucket)
        if not isinstance(bucket, dict):
            return []
        normalized_speaker = str(speaker or "").strip()
        for key in (
            normalized_speaker,
            DEFAULT_GREETING_SPEAKER,
            "default",
            "Default",
            "general",
            "General",
        ):
            if key and key in bucket:
                return self._resolve_lines(bucket.get(key), speaker="")
        return []

    def _normalize_lines(self, values: list) -> list[str]:
        normalized = []
        for value in values:
            text = " ".join(str(value or "").split()).strip()
            if text:
                normalized.append(text)
        return normalized

    def _collect_lines(self, bucket, collected: list[str]) -> None:
        if isinstance(bucket, str):
            text = " ".join(bucket.split()).strip()
            if text:
                collected.append(text)
            return
        if isinstance(bucket, list):
            collected.extend(self._normalize_lines(bucket))
            return
        if isinstance(bucket, dict):
            for value in bucket.values():
                self._collect_lines(value, collected)


def build_wake_spotter(config: Config):
    if config.wake_engine == "microwakeword":
        try:
            spotter = MicroWakeWordPhraseSpotter(config.wake_microwakeword_model)
            log(f"wake engine set to microWakeWord model={spotter._label}")
            if config.wake_vosk_fallback_enabled:
                try:
                    fallback = PhraseSpotter(config.wake_model_dir, config.phrase_variants)
                    log("wake Vosk phrase fallback enabled")
                    return CombinedWakeSpotter(spotter, fallback)
                except Exception as fallback_err:
                    log(f"wake Vosk phrase fallback unavailable: {fallback_err}")
            return spotter
        except Exception as err:
            log(f"microWakeWord setup failed; falling back to Vosk wake spotter: {err}")
    log("wake engine set to Vosk phrase spotter")
    return PhraseSpotter(config.wake_model_dir, config.phrase_variants)


def build_stt_engine(config: Config) -> "SttEngine":
    return SttEngine(
        config.stt_model,
        config.fast_stt_model,
        config.phrase_variants,
        config.fast_stt_command_max_words,
        config.stt_backend,
        config.deepgram_api_key,
        config.deepgram_model,
        config.deepgram_language,
        config.deepgram_timeout_seconds,
        config.elevenlabs_api_key,
        config.elevenlabs_model_id,
        config.elevenlabs_language_code,
        config.elevenlabs_realtime_url,
        config.elevenlabs_audio_format,
        config.elevenlabs_commit_strategy,
        config.elevenlabs_vad_silence_threshold_secs,
        config.elevenlabs_vad_threshold,
        config.elevenlabs_min_speech_duration_ms,
        config.elevenlabs_min_silence_duration_ms,
        config.elevenlabs_no_verbatim,
        config.elevenlabs_enable_logging,
        config.elevenlabs_include_timestamps,
        config.elevenlabs_include_language_detection,
        config.elevenlabs_keyterms,
        config.elevenlabs_timeout_seconds,
        deepgram_endpointing_ms=config.deepgram_endpointing_ms,
        deepgram_keyterms=config.deepgram_keyterms,
        deepgram_end_of_turn=config.deepgram_end_of_turn,
        deepgram_flux_model=config.deepgram_flux_model,
        deepgram_flux_eot_threshold=config.deepgram_flux_eot_threshold,
        deepgram_flux_warm_socket=config.deepgram_flux_warm_socket,
        inworld_api_key=config.inworld_api_key,
        inworld_model=config.inworld_model,
        inworld_language=config.inworld_language,
        inworld_url=config.inworld_url,
        inworld_timeout_seconds=config.inworld_timeout_seconds,
        inworld_keyterms=config.inworld_keyterms,
        inworld_eot_threshold=config.inworld_eot_threshold,
        inworld_voice_profile=config.inworld_voice_profile,
        inworld_voice_profile_top_n=config.inworld_voice_profile_top_n,
        ha_stt_entity=config.ha_stt_entity,
        ha_stt_language=config.ha_stt_language,
    )


def build_kill_spotter(config: Config):
    kill_variants = {"kill": kill_phrase_candidates(config.phrase_variants)}
    return PhraseSpotter(config.wake_model_dir, kill_variants)


class JarvisVoiceLoop:
    def __init__(self, config: Config):
        self._config = config
        self._running = True
        # The wake and kill spotters (Vosk, microWakeWord) only listen to the local microphone loop;
        # endpoints and Assist satellites wake on the device.
        self._spotter = build_wake_spotter(config) if config.local_voice_enabled else None
        self._kill_spotter = build_kill_spotter(config) if config.local_voice_enabled else None
        self._capture = TurnCapture(
            config.silence_seconds,
            config.pre_roll_ms,
            config.session_idle_seconds,
            config.vad_mode,
            config.start_trigger_frames,
            config.speech_reset_frames,
            config.max_turn_seconds,
            config.hard_max_turn_seconds,
        )
        self._stt = build_stt_engine(config)
        self._stt.prewarm_live_sessions()
        self._tts = build_tts_engine(config)
        self._tail_prepare_tts = build_tts_engine(config)
        self._jarvis = JarvisClient(
            config.jarvis_url,
            config.jarvis_token,
            config.room,
            config.jarvis_channel,
            config.jarvis_source_via,
        )
        self._voice_clips = VoiceClipBridge(
            config.voice_audio_manifest_url,
            config.jarvis_token,
            config.output_device,
            config.voice_audio_request_timeout_seconds,
            config.voice_audio_cache_seconds,
        )
        self._prompt_texts = PromptTextBridge(config.prompt_text_manifest_path)
        self._speaker_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speaker-id")
        self._wake_audio_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="wake-audio")
        self._browser_wake_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="browser-wake")
        self._endpoint_playback_lock = threading.Lock()
        self._endpoint_playbacks: dict[str, str] = {}
        self._pending_wake_speaker = None
        self._pending_session_speaker = None
        self._pending_wake_ack = None
        self._event_logger = VoiceEventLogger(config.voice_event_log_dir)
        self._tts.set_playback_event_callback(self._log_voice_event)
        self._tail_prepare_tts.set_playback_event_callback(self._log_voice_event)
        self._self_voice_rejector = self._build_self_voice_rejector()
        self._tts.set_playback_audio_tap(self._self_voice_rejector)
        self._ha_state_publisher = HomeAssistantStatePublisher(
            enabled=config.ha_state_publish_enabled,
            base_url=config.ha_state_publish_url,
            token=config.ha_state_publish_token,
            client_id=config.ha_state_publish_client_id,
            timeout_seconds=config.ha_state_publish_timeout_seconds,
            interval_seconds=config.ha_state_publish_interval_seconds,
            cache_path=config.ha_state_publish_cache_path,
        )
        for engine in (self._stt, self._tts, self._tail_prepare_tts):
            engine.set_home_assistant(self._ha_state_publisher)
        self._speech_lock = threading.RLock()
        # Re-entrant: a speaker match that is already done when a turn attaches its callback runs
        # that callback at once, on the turn's own thread, which takes this lock again.
        self._browser_turn_lock = threading.RLock()
        self._remote_tts_server = RemoteTtsServer(
            config.remote_tts_bind_host,
            config.remote_tts_port,
            config.remote_tts_token,
            self._handle_remote_tts_request,
            event_logger=self._event_logger,
        ) if config.remote_tts_enabled else None
        self._browser_voice_server = BrowserVoiceServer(
            config.browser_voice_bind_host,
            config.browser_voice_port,
            config.browser_voice_token,
            config.browser_voice_allowed_origins,
            self._handle_browser_voice_wake,
            self._handle_browser_voice_wake_prompt,
            self._handle_browser_voice_turn,
            self._handle_browser_voice_turn_stream,
            self._handle_browser_voice_live_turn_stream,
            event_logger=self._event_logger,
            health_callback=self._browser_voice_health,
            wake_sample_callback=self._handle_browser_wake_sample,
            playback_callback=self._handle_browser_playback_event,
        ) if config.browser_voice_enabled else None
        self._endpoint_gateway = self._build_endpoint_gateway(config)
        self._assist_servers = self._build_assist_servers(config)
        self._last_failure_line = ""
        self._speaker_id = SpeakerIdentifier(
            config.speaker_id_enabled,
            config.speaker_profiles_path,
            config.wake_speaker_profiles_path,
            config.speaker_id_threshold,
            config.speaker_id_min_seconds,
            config.speaker_model_cache_dir,
        )
        self._speaker_identity = SpeakerIdentityState(
            config.default_greeting_speaker or DEFAULT_GREETING_SPEAKER
        )
        speaker_readiness = self._speaker_id.readiness()
        if speaker_readiness["status"] != "ready":
            reason = str(speaker_readiness.get("reason") or speaker_readiness["status"])
            missing_paths = ", ".join(speaker_readiness.get("missing_paths") or [])
            detail = f"speaker identification {speaker_readiness['status']}: {reason}"
            if missing_paths:
                detail = f"{detail}; missing {missing_paths}"
            log(detail)
            self._log_voice_event("speaker_profiles_unavailable", **speaker_readiness)
        self._speaker_executor.submit(self._speaker_id.warmup)
        self._noise_filter_chain = build_noise_filter_chain(config)
        self._jarvis_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="housemate-http")
        self._tail_prepare_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tail-tts-prep")
        self._tail_poll_futures = set()
        self._tail_poll_lock = threading.Lock()
        self._recent_prompt_lines: list[str] = []
        self._active_session_id = ""
        self._browser_sessions: dict[str, BrowserVoiceSession] = {}
        self._browser_presence_timer: threading.Timer | None = None
        self._browser_presence_lock = threading.Lock()
        self._event_context_local = threading.local()

    def _build_turn_id(self, prefix: str = "turn") -> str:
        normalized = " ".join(str(prefix or "turn").split()).strip().lower().replace(" ", "-") or "turn"
        return f"{normalized}-{utc_timestamp().replace(':', '').replace('-', '').replace('.', '')}-{uuid.uuid4().hex[:8]}"

    def _event_context(self) -> dict:
        event_context_local = getattr(self, "_event_context_local", None)
        if event_context_local is None:
            return {}
        current = getattr(event_context_local, "stack", None)
        if not current:
            return {}
        merged = {}
        for item in current:
            if isinstance(item, dict):
                merged.update(item)
        return merged

    @contextlib.contextmanager
    def _voice_event_context(self, **fields):
        normalized = {}
        for key, value in fields.items():
            if value is None:
                continue
            normalized_key = str(key or "").strip()
            if not normalized_key:
                continue
            normalized[normalized_key] = value
        event_context_local = getattr(self, "_event_context_local", None)
        if event_context_local is None:
            event_context_local = threading.local()
            self._event_context_local = event_context_local
        stack = getattr(event_context_local, "stack", None)
        if stack is None:
            stack = []
            event_context_local.stack = stack
        stack.append(normalized)
        try:
            yield
        finally:
            with contextlib.suppress(Exception):
                stack.pop()

    def _event_text(self, value: object, limit: int = 200) -> str | None:
        spoken = " ".join(str(value or "").split()).strip()
        if not spoken:
            return None
        if len(spoken) <= limit:
            return spoken
        return spoken[:limit] + "..."

    def _active_turn_capture(self) -> TurnCapture:
        return self._capture

    def _build_self_voice_rejector(self) -> LivePlaybackMirror | None:
        if self._playback_mic_mode() != "aec":
            return None
        if not bool(getattr(self._config, "self_voice_reject_enabled", True)):
            return None
        return LivePlaybackMirror(
            enabled=True,
            max_lag_ms=getattr(self._config, "self_voice_reject_max_lag_ms", DEFAULT_SELF_VOICE_REJECT_MAX_LAG_MS),
            min_similarity=getattr(self._config, "self_voice_reject_min_similarity", DEFAULT_SELF_VOICE_REJECT_MIN_SIMILARITY),
            min_playback_rms=getattr(
                self._config,
                "self_voice_reject_min_playback_rms",
                DEFAULT_SELF_VOICE_REJECT_MIN_PLAYBACK_RMS,
            ),
            min_mic_rms=getattr(self._config, "self_voice_reject_min_mic_rms", DEFAULT_SELF_VOICE_REJECT_MIN_MIC_RMS),
            max_gain=getattr(self._config, "self_voice_reject_max_gain", DEFAULT_SELF_VOICE_REJECT_MAX_GAIN),
            residual_ratio=getattr(
                self._config,
                "self_voice_reject_residual_ratio",
                DEFAULT_SELF_VOICE_REJECT_RESIDUAL_RATIO,
            ),
        )

    def _log_voice_event(self, event_type: str, **fields) -> None:
        payload = {
            "room": self._config.room,
        }
        for key, value in self._event_context().items():
            if value is None:
                continue
            payload[key] = value
        for key, value in fields.items():
            if value is None:
                continue
            payload[key] = value
        self._event_logger.log_event(event_type, **payload)

    def _speaker_snapshot(self) -> str:
        speaker = str(self._speaker_identity.active_name() or "").strip()
        if speaker == DEFAULT_GREETING_SPEAKER:
            return ""
        return speaker

    def _set_voice_state(self, state: object) -> None:
        publisher = getattr(self, "_ha_state_publisher", None)
        if publisher is None:
            return
        publisher.set_voice_state(state)

    def _restore_active_voice_state(self) -> None:
        active_session_id = str(getattr(self, "_active_session_id", "") or "").strip()
        browser_sessions = getattr(self, "_browser_sessions", {})
        if browser_sessions:
            with contextlib.suppress(Exception):
                self._prune_browser_sessions()
        self._set_voice_state("listening" if active_session_id or browser_sessions else "idle")

    def _record_identified_speaker(self, speaker: str) -> None:
        normalized = str(speaker or "").strip()
        if not normalized:
            return
        publisher = getattr(self, "_ha_state_publisher", None)
        if publisher is None:
            return
        publisher.set_last_speaker(normalized)

    def _publish_tts_phrase(self, text: str, phase: str = "", speaker: str = "", duration_ms: int | None = None) -> None:
        publisher = getattr(self, "_ha_state_publisher", None)
        if publisher is None:
            return
        spoken = " ".join(str(text or "").split()).strip()
        if not spoken:
            publisher.clear_tts_phrase()
            return
        normalized_speaker = str(speaker or "").strip() or self._speaker_snapshot() or UNKNOWN_SPEAKER
        publisher.set_tts_phrase(
            spoken,
            phase=phase,
            speaker=normalized_speaker,
            duration_ms=duration_ms if duration_ms is not None else estimate_tts_duration_ms(spoken),
        )

    def _clear_tts_phrase(self) -> None:
        publisher = getattr(self, "_ha_state_publisher", None)
        if publisher is None:
            return
        publisher.clear_tts_phrase()

    def _start_voice_session(self) -> str:
        self._active_session_id = f"voice-{utc_timestamp().replace(':', '').replace('-', '').replace('.', '')}-{uuid.uuid4().hex[:8]}"
        self._log_voice_event("voice_session_started", session_id=self._active_session_id)
        self._set_voice_state("listening")
        return self._active_session_id

    def _end_voice_session(self, reason: str = "") -> None:
        session_id = str(getattr(self, "_active_session_id", "") or "").strip()
        if not session_id:
            return
        self._log_voice_event(
            "voice_session_ended",
            session_id=session_id,
            reason=str(reason or "").strip() or None,
        )
        self._active_session_id = ""
        self._set_voice_state("idle")

    def _browser_session_timeout_seconds(self) -> float:
        idle_seconds = max(0.0, float(self._config.session_idle_seconds or 0.0))
        hard_max = getattr(self._config, "hard_max_turn_seconds", None)
        max_turn_seconds = max(0.0, float(hard_max or self._config.max_turn_seconds or 0.0))
        return max(45.0, idle_seconds + max_turn_seconds + 15.0)

    def _handle_browser_wake_sample(self, body: dict) -> dict:
        """Store one diagnostic wake/near-miss clip while capture is switched on."""
        if not getattr(self._config, "wake_sample_capture_enabled", False):
            return {"ok": False, "status": "disabled"}
        if not isinstance(body, dict):
            raise ValueError("request body must be an object")
        kind = str(body.get("kind") or "").strip()
        if kind not in WAKE_SAMPLE_KINDS:
            raise ValueError("kind must be detected, near_miss or speech_miss")
        audio = decode_browser_audio_to_pcm(base64.b64decode(str(body.get("audio_base64") or ""), validate=True))
        if not audio or len(audio) > SAMPLE_RATE * SAMPLE_WIDTH * 10:
            raise ValueError("wake sample audio must be 0-10 s")
        client_id = re.sub(r"[^a-z0-9-]+", "-", str(body.get("client_id") or "browser").lower()).strip("-")[:40] or "browser"
        now = time.time()
        stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime(now)) + f"{int((now % 1) * 1000):03d}Z"
        stem = f"{stamp}-{client_id}-{kind}"
        metadata = {"kind": kind, "client_id": client_id, "received_at": stamp}
        for key in ("probability", "cutoff", "agc_db", "input_peak_dbfs"):
            value = body.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                metadata[key] = round(float(value), 4)
        for key in ("frontend", "terminal_version", "wake_model"):
            value = body.get(key)
            if value is not None:
                metadata[key] = str(value)[:64]
        try:
            self._write_voice_sample(stem, audio, metadata)
        except OSError as err:
            log(f"wake sample save failed: {err}")
            return {"ok": False, "status": "not_saved"}
        self._log_voice_event("wake_sample_saved", sample=stem, **{k: v for k, v in metadata.items() if k != "client_id"})
        return {"ok": True, "status": "saved", "sample": stem}

    def _write_voice_sample(self, stem: str, audio: bytes, metadata: dict) -> None:
        directory = self._config.wake_sample_dir
        os.makedirs(directory, exist_ok=True)
        if shutil.disk_usage(directory).free < WAKE_SAMPLE_MIN_FREE_BYTES:
            raise OSError("voice sample capture paused: under 2 GB free")
        with open(os.path.join(directory, f"{stem}.wav"), "wb") as handle:
            handle.write(encode_wav_bytes(audio))
        with open(os.path.join(directory, f"{stem}.json"), "w", encoding="utf-8") as handle:
            json.dump(metadata, handle, sort_keys=True)
        prune_wake_samples(directory, self._config.wake_sample_max_files)

    def _save_browser_turn_sample(
        self,
        *,
        turn_id: str,
        client_id: str,
        audio: bytes,
        heard_text: str,
        command: str,
        wake_attached: bool,
        wake_candidate: bool,
        stt_latency_ms: int,
    ) -> None:
        """Keep the exact STT audio of a real turn as a replayable test fixture."""
        if not getattr(getattr(self, "_config", None), "wake_sample_capture_enabled", False) or not audio:
            return
        safe_client = re.sub(r"[^a-z0-9-]+", "-", str(client_id or "browser").lower()).strip("-")[:40] or "browser"
        stem = f"{turn_id}-{safe_client}-turn"
        metadata = {
            "kind": "turn",
            "turn_id": turn_id,
            "client_id": safe_client,
            "wake_attached": bool(wake_attached),
            "wake_candidate": bool(wake_candidate),
            "heard_text": heard_text,
            "command": command,
            "stt_latency_ms": int(stt_latency_ms),
            "audio_seconds": round(len(audio) / float(SAMPLE_RATE * SAMPLE_WIDTH), 3),
        }
        try:
            self._write_voice_sample(stem, audio, metadata)
        except OSError as err:
            log(f"turn sample save failed: {err}")
            return
        self._log_voice_event("turn_sample_saved", sample=stem)

    def _ears_clip_dir(self) -> str:
        configured = str(getattr(self._config, "ears_clip_dir", "") or "").strip()
        return os.path.expanduser(configured or DEFAULT_EARS_CLIP_DIR)

    def _ears_recorded_ids(self, prompts: dict[str, dict]) -> set[str]:
        directory = self._ears_clip_dir()
        return {prompt_id for prompt_id in prompts if os.path.exists(os.path.join(directory, f"{prompt_id}.wav"))}

    def _save_ears_clip(self, prompt_id: str, prompt: dict, audio: bytes, client_id: str, heard_text: str) -> None:
        directory = self._ears_clip_dir()
        os.makedirs(directory, exist_ok=True)
        metadata = {
            "id": prompt_id,
            "text": prompt["text"],
            "delivery": prompt["delivery"],
            "client_id": client_id,
            "live_heard_text": heard_text,
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "audio_seconds": round(len(audio) / float(SAMPLE_RATE * SAMPLE_WIDTH), 3),
        }
        with open(os.path.join(directory, f"{prompt_id}.wav"), "wb") as handle:
            handle.write(encode_wav_bytes(audio))
        with open(os.path.join(directory, f"{prompt_id}.json"), "w", encoding="utf-8") as handle:
            json.dump(metadata, handle, sort_keys=True)

    def _ears_test_reply(
        self,
        client_id: str,
        utterance: str,
        heard_text: str,
        audio_bytes: bytes,
        wake_attached: bool,
    ) -> tuple[str, bool] | None:
        """Run one guided recording step; None means not a test turn.

        Test state lives on the browser session, so a new wake, kill phrase,
        goodbye or idle expiry ends it and an ordinary command is never kept.
        """
        prompts = ears_prompt_table()
        total = len(prompts)
        if is_ears_start_command(utterance):
            session = self._browser_session_for_client(client_id, create=True)
            recorded = self._ears_recorded_ids(prompts)
            first = next((prompt_id for prompt_id in prompts if prompt_id not in recorded), None)
            if first is None:
                session.ears_test = None
                return f"All {total} test lines are already recorded.", True
            session.ears_test = {"current": first, "previous": None, "skipped": set()}
            self._log_voice_event("ears_test_started", prompt_id=first, recorded=len(recorded))
            intro = (
                f"Test mode. {len(recorded)} of {total} done. One line each after the beep. "
                "Say stop to pause, redo for the last one again, or skip. "
            )
            return intro + ears_prompt_line(first, prompts), False
        session = self._browser_session_for_client(client_id, create=False)
        state = session.ears_test if session is not None else None
        if state is None:
            return None
        if wake_attached:
            # A fresh "Hey Housemate,..." is a normal command, never a test line.
            session.ears_test = None
            self._log_voice_event("ears_test_ended", reason="wake")
            return None
        current = state["current"]
        command = normalize_text(utterance)
        if command in EARS_STOP_PHRASES:
            session.ears_test = None
            recorded = len(self._ears_recorded_ids(prompts))
            self._log_voice_event("ears_test_ended", reason="stop", recorded=recorded)
            return f"Paused. {recorded} of {total} recorded. Say time to test to carry on.", True
        if command in EARS_REPEAT_PHRASES:
            return ears_prompt_line(current, prompts), False
        if command in EARS_REDO_PHRASES and state["previous"]:
            state["current"], state["previous"] = state["previous"], None
            return "Again. " + ears_prompt_line(state["current"], prompts), False
        if command in EARS_SKIP_PHRASES:
            state["skipped"].add(current)
        else:
            try:
                self._save_ears_clip(current, prompts[current], audio_bytes, client_id, heard_text)
            except OSError as err:
                log(f"ears clip save failed: {err}")
                session.ears_test = None
                return "I couldn't save that one, so test mode is off. Check the voice log.", True
            self._log_voice_event("ears_test_clip_saved", prompt_id=current, heard_text=self._event_text(heard_text))
            state["previous"] = current
        recorded = self._ears_recorded_ids(prompts)
        upcoming = next(
            (prompt_id for prompt_id in prompts if prompt_id not in recorded and prompt_id not in state["skipped"]),
            None,
        )
        if upcoming is None:
            session.ears_test = None
            self._log_voice_event("ears_test_ended", reason="complete", recorded=len(recorded))
            if len(recorded) >= total:
                return f"That's the lot. All {total} recorded. Cheers.", True
            return f"That's the end of the list. {len(recorded)} of {total} recorded; skipped ones come back next time.", True
        state["current"] = upcoming
        return ears_prompt_line(upcoming, prompts), False

    def _browser_voice_health(self) -> dict:
        speaker_identifier = getattr(self, "_speaker_id", None)
        detailed_status = (
            speaker_identifier.readiness()
            if speaker_identifier is not None and hasattr(speaker_identifier, "readiness")
            else {
                "enabled": False,
                "status": "unavailable",
                "reason": "speaker_identifier_not_ready",
                "trusted_identity_available": False,
            }
        )
        public_status = {
            key: detailed_status.get(key)
            for key in (
                "enabled",
                "status",
                "reason",
                "trusted_identity_available",
                "speaker_profile_count",
                "wake_speaker_profile_count",
            )
            if key in detailed_status
        }
        return {
            "speaker_id": public_status,
            "wake_sample_capture": bool(getattr(getattr(self, "_config", None), "wake_sample_capture_enabled", False)),
        }

    def _build_browser_session_id(self) -> str:
        return f"browser-voice-{utc_timestamp().replace(':', '').replace('-', '').replace('.', '')}-{uuid.uuid4().hex[:8]}"

    def _build_endpoint_gateway(self, config):
        if not getattr(config, "endpoint_gateway_enabled", False):
            return None
        from housemate_endpoint_gateway.admin import build_control_plane
        from housemate_endpoint_gateway.live import EndpointLiveServer

        control = build_control_plane(config.endpoint_gateway_db_path, config.endpoint_gateway_key_path)
        music_mute = None
        if getattr(config, "endpoint_music_mute", True) and config.ha_state_publish_enabled:
            from housemate_endpoint_gateway.music_mute import MusicMute

            def player_for(endpoint_id: str) -> str | None:
                record = self._endpoint_record(control.registry, endpoint_id)
                return record.media_player if record is not None else None

            music_mute = MusicMute(
                self._ha_state_publisher,
                player_for,
                state_path=os.path.join(
                    os.path.dirname(os.path.expanduser(config.endpoint_gateway_db_path)), "endpoint-music-muted.json"
                ),
                log_event=self._log_voice_event,
            )
            music_mute.recover()
        return EndpointLiveServer(
            control,
            self._handle_browser_voice_live_turn_stream,
            host=config.endpoint_gateway_bind_host,
            port=config.endpoint_gateway_port,
            log=log,
            event_logger=self._log_voice_event,
            wake_policy=getattr(config, "endpoint_wake_policy", None),
            playback=lambda client_id, event, playback_id: self._handle_browser_playback_event(
                {"client_id": client_id, "event": event, "playback_id": playback_id}
            ),
            session_end=lambda client_id, reason: self._drop_browser_session(client_id, reason=reason),
            music_mute=music_mute,
            say=self._endpoint_say,
        )

    def _build_assist_servers(self, config) -> list:
        """The Wyoming hearing/voice server and the housemate_assist agent's turn API."""
        if not getattr(config, "assist_wyoming_enabled", False):
            return []
        from housemate_assist.training import VoiceTraining
        from housemate_assist.turns import AssistReplies, AssistTurnServer, HeardTurns
        from housemate_assist.wyoming_server import AssistWyomingServer

        def open_tts_session(**callbacks):
            return ProgressiveTtsSession(self._tts, phase="assist_reply", **callbacks)

        heard = HeardTurns()
        replies = AssistReplies()
        # Built before the speaker identifier: training finds it when a session finishes.
        training = VoiceTraining(train=lambda *args: self._speaker_id.train_person(*args), log=log,
                                 trained=lambda: self._speaker_id.trained_person_ids())
        turns = AssistTurnServer(
            heard=heard,
            replies=replies,
            run_turn=self._run_assist_turn,
            has_session=lambda client_id: self._normalize_browser_client_id(client_id) in self._browser_sessions,
            drop_session=lambda client_id, reason: self._drop_browser_session(client_id, reason=reason),
            host=config.assist_wyoming_bind_host,
            port=config.assist_turn_port,
            log=log,
            event=self._log_voice_event,
            is_wake_phrase=lambda phrase: not phrase.strip() or is_wake_only_text(phrase, config.phrase_variants),
            **self._assist_music_hooks(),
            calibration_done=self._assist_calibration_done,
            training=training,
        )

        def identify(audio: bytes):
            # A follow-up keeps its session's speaker and checks its own turn; only a new one needs this.
            if turns.expects_follow_up():
                return None
            return self._start_endpoint_wake_speaker(ASSIST_CLIENT_LOG_ID, audio)

        wyoming = AssistWyomingServer(
            stt=self._stt,
            open_tts_session=open_tts_session if getattr(self._tts, "_fish_ready", False) else None,
            host=config.assist_wyoming_bind_host,
            port=config.assist_wyoming_port,
            no_speech_seconds=config.assist_stt_no_speech_seconds,
            max_turn_seconds=config.hard_max_turn_seconds,
            log=log,
            event=self._log_voice_event,
            on_heard=heard.add,
            identify=identify,
            claim_turn=replies.claim,
            wake_only=lambda text: resolve_wake_attached_utterance(text, config.phrase_variants)[1]
            in {"empty", "wake_only"},
            eot_threshold=lambda: self._speaker_eot_threshold(turns.follow_up_client()),
            assistant_name=assistant_name(),
        )
        return [turns, wyoming]

    def _assist_calibration_done(self, client_id: str, host: str, takes: int) -> str:
        """An Assist dot's calibration session is over: its takes come off it (after the agent's
        announcement has started, so the two do not share the dot's Wi-Fi at once), and the assistant says so."""
        from housemate_endpoint_gateway.live import CALIBRATION_TEXT, fetch_calibration_takes

        endpoint_id = self._normalize_browser_client_id(client_id)[len("endpoint:"):]
        calibration_dir = getattr(getattr(self, "_endpoint_gateway", None), "calibration_dir",
                                  "~/.local/share/housemate-voice/calibration")
        self._log_voice_event("assist_calibration_done", client_id=client_id, takes=takes)
        if takes:
            timer = threading.Timer(ASSIST_CALIBRATION_FETCH_DELAY_S, fetch_calibration_takes,
                                    args=(host, calibration_dir, endpoint_id, self._log_voice_event))
            timer.daemon = True
            timer.start()
        return CALIBRATION_TEXT

    def _assist_music_hooks(self) -> dict:
        """The gateway's MusicMute for Assist satellites (`assist-<device>`), when it runs."""
        mute = getattr(getattr(self, "_endpoint_gateway", None), "music_mute", None)
        if mute is None:
            return {}

        def endpoint(client_id: str) -> str:
            return self._normalize_browser_client_id(client_id)[len("endpoint:"):]

        return {
            "music_listening": lambda client_id: mute.listening(endpoint(client_id)),
            "music_release": lambda client_id: mute.release(endpoint(client_id)),
            "music_forget": lambda client_id: mute.forget(endpoint(client_id), "command"),
        }

    @staticmethod
    def _endpoint_record(registry, endpoint_id: str):
        """The fleet registry's record for an endpoint, or for an Assist satellite (`assist-<HA device>`) by its
        recorded Home Assistant device. None when there is none."""
        with contextlib.suppress(Exception):
            if endpoint_id.startswith(ASSIST_ENDPOINT_PREFIX):
                return registry.find_by_ha_device(endpoint_id[len(ASSIST_ENDPOINT_PREFIX):])
            return registry.require(endpoint_id)
        return None

    def _speaker_eot_threshold(self, client_id: str | None) -> float | None:
        """The Flux end-of-turn threshold of whoever that client's session is speaking with, if they have one."""
        if not client_id:
            return None
        session = getattr(self, "_browser_sessions", {}).get(self._normalize_browser_client_id(client_id))
        speaker = speaker_of_reference(session.speaker_name) if session is not None else ""
        thresholds = getattr(getattr(self, "_config", None), "speaker_flux_eot_thresholds", None) or {}
        own = thresholds.get(speaker) if speaker else None
        if own is not None:
            self._log_voice_event("stt_speaker_end_of_turn", speaker=speaker, eot_threshold=own)
        return own

    def _run_assist_turn(self, client_id: str, text: str, audio: bytes, speaker_future, writer,
                         wake: bool = False) -> None:
        """An Assist turn: HA's transcript and the audio it came from, through every endpoint's turn. A
        "Hey Housemate" turn is confirmed and stripped as an endpoint's confident wake is."""
        from housemate_assist.turns import HeardTranscript

        body = {"client_id": client_id, "ha_intents": True}
        if wake:
            body.update(wake_attached=True, wake_candidate=True, wake_confident=True)
        if speaker_future is not None:
            started = time.monotonic()
            with contextlib.suppress(Exception):
                speaker_future.result(timeout=ASSIST_WAKE_SPEAKER_WAIT_S if wake else ASSIST_SPEAKER_WAIT_S)
            self._log_voice_event(
                "assist_speaker_wait",
                client_id=client_id,
                done=speaker_future.done(),
                waited_ms=int(round((time.monotonic() - started) * 1000)),
            )
            body["endpoint_wake_speaker_future"] = speaker_future
        self._handle_browser_voice_turn(
            body,
            stream_writer=writer,
            audio_bytes_override=audio,
            stt_live_session=HeardTranscript(text),
        )

    def _normalize_browser_client_id(self, client_id: str) -> str:
        return " ".join(str(client_id or "").split()).strip()[:128] or "browser-default"

    def _endpoint_say(self, client_id: str, text: str, emit) -> None:
        """A fixed line into an endpoint turn the endpoint opened itself (a calibration report)."""
        with self._speech_lock:
            prepared = self._tts.prepare_speech(text, phase="endpoint_say")
        self._mark_browser_playback_state(text, phase="endpoint_say", end_session=True)
        emit({"event": "audio_clip", "clip": self._prepared_speech_to_browser_clip(prepared, text=text, phase="endpoint_say")})

    def _is_endpoint_client(self, client_id: str) -> bool:
        return self._normalize_browser_client_id(client_id).startswith("endpoint:")

    def _endpoint_turn_info(self, client_id: str) -> dict | None:
        """The endpoint a turn came from, as the fleet registry records it, for the assistant."""
        if not self._is_endpoint_client(client_id):
            return None
        endpoint_id = self._normalize_browser_client_id(client_id)[len("endpoint:"):]
        info: dict = {"id": endpoint_id}
        gateway = getattr(self, "_endpoint_gateway", None)
        record = self._endpoint_record(gateway.control.registry, endpoint_id) if gateway is not None else None
        if record is not None:
            if record.friendly_name:
                info["name"] = record.friendly_name
            if record.media_player:
                info["media_player"] = record.media_player
        # Paused only for this request, the music is still on as far as the assistant is concerned (no model calls).
        mute = getattr(gateway, "music_mute", None)
        if mute is not None:
            with contextlib.suppress(Exception):
                if mute.muted_for_turn(endpoint_id):
                    info["music_paused_by_turn"] = True
        return info

    def _trusted_browser_speaker(self, client_id: str) -> str:
        # An endpoint's identity is where the audio came from, never who spoke.
        if self._is_endpoint_client(client_id):
            return ""
        trusted_clients = getattr(self._config, "browser_voice_trusted_clients", {})
        if not isinstance(trusted_clients, dict):
            return ""
        speaker = str(trusted_clients.get(self._normalize_browser_client_id(client_id)) or "").strip()
        return speaker if speaker in known_wake_speakers() else ""

    def _prune_browser_sessions(self) -> None:
        if not self._browser_sessions:
            return
        cutoff = time.monotonic() - self._browser_session_timeout_seconds()
        expired = [client_id for client_id, session in list(self._browser_sessions.items()) if session.last_seen_at < cutoff]
        for client_id in expired:
            session = self._browser_sessions.pop(client_id, None)
            if session is not None:
                self._log_voice_event(
                    "browser_voice_session_ended",
                    client_id=client_id,
                    session_id=session.session_id,
                    reason="idle_timeout",
                )

    def _ensure_browser_session_reaper(self) -> None:
        """Expire idle browser sessions on a clock, not only on the next request.

        Without this a conversation that simply stops (no kill phrase) left
        the voice state sensor on "listening" until the next wake.
        """
        if getattr(self, "_browser_session_reaper", None) is not None:
            return

        def reap() -> None:
            while True:
                time.sleep(BROWSER_SESSION_REAP_SECONDS)
                if not self._browser_sessions:
                    continue
                with contextlib.suppress(Exception):
                    self._prune_browser_sessions()
                    if not self._browser_sessions:
                        self._cancel_browser_presence_timer()
                        self._clear_tts_phrase()
                        self._restore_active_voice_state()

        self._browser_session_reaper = threading.Thread(target=reap, name="housemate-browser-session-reaper", daemon=True)
        self._browser_session_reaper.start()

    def _browser_session_for_client(self, client_id: str, create: bool = False) -> BrowserVoiceSession | None:
        normalized = self._normalize_browser_client_id(client_id)
        self._prune_browser_sessions()
        session = self._browser_sessions.get(normalized)
        if session is None and create:
            trusted_speaker = self._trusted_browser_speaker(normalized)
            session = BrowserVoiceSession(
                session_id=self._build_browser_session_id(),
                last_seen_at=time.monotonic(),
                speaker_name=trusted_speaker,
                speaker_confidence=1.0 if trusted_speaker else 0.0,
            )
            self._browser_sessions[normalized] = session
            self._ensure_browser_session_reaper()
            self._log_voice_event("browser_voice_session_started", client_id=normalized, session_id=session.session_id)
        if session is not None:
            session.last_seen_at = time.monotonic()
        return session

    def _remember_browser_session_speaker(
        self,
        client_id: str,
        session_id: str,
        speaker_name: str,
        speaker_confidence: float = 0.0,
    ) -> bool:
        normalized_client_id = self._normalize_browser_client_id(client_id)
        normalized_session_id = " ".join(str(session_id or "").split()).strip()
        normalized_speaker = " ".join(str(speaker_name or "").split()).strip()
        if normalized_speaker not in known_wake_speakers():
            return False
        if not normalized_client_id or not normalized_session_id:
            return False
        session = self._browser_sessions.get(normalized_client_id)
        if session is None or session.session_id != normalized_session_id:
            return False
        # An endpoint session keeps the first confident speaker until it ends;
        # a turn that confidently sounds like someone else is credited per turn, not here. The same
        # person matched more surely (a sentence, often after its own turn has gone) raises the
        # session's confidence for the turns that follow.
        if normalized_client_id.startswith("endpoint:") and session.speaker_name:
            if session.speaker_name != normalized_speaker:
                return False
            confidence = max(0.0, float(speaker_confidence or 0.0))
            session.last_seen_at = time.monotonic()
            if confidence <= session.speaker_confidence:
                return False
            session.speaker_confidence = confidence
            return True
        confidence = max(0.0, float(speaker_confidence or 0.0))
        if (
            session.speaker_name
            and session.speaker_name != normalized_speaker
            and confidence <= session.speaker_confidence
        ):
            return False
        if session.speaker_name == normalized_speaker and confidence <= session.speaker_confidence:
            session.last_seen_at = time.monotonic()
            return False
        session.speaker_name = normalized_speaker
        session.speaker_confidence = max(session.speaker_confidence, confidence)
        session.last_seen_at = time.monotonic()
        return True

    def _identify_endpoint_turn(self, session: BrowserVoiceSession, audio_bytes: bytes) -> tuple[str, float]:
        """A turn on an endpoint: its own match, or, for the session's speaker, the match for all their
        turns so far together if that is surer. Short turns each score low on a speaker (0.5-0.7);
        together they are the same voice heard for longer.
        Someone else's turn is matched on its own and kept out of the session's voiceprints."""
        name, score, voiceprint = self._speaker_id.identify_turn(audio_bytes)
        if voiceprint is None or not name or (session.speaker_name and name != session.speaker_name):
            return name, score
        session.voiceprints = session.voiceprints[-11:] + [voiceprint]
        if len(session.voiceprints) < 2:
            return name, score
        together_name, together = self._speaker_id.identify_voiceprints(session.voiceprints)
        if together_name == name and together > score:
            return name, together
        return name, score

    def _accept_browser_speaker_result(
        self,
        client_id: str,
        session_id: str,
        source: str,
        speaker: str,
        score: float,
        *,
        late: bool = False,
        lock_held: bool = False,
    ) -> str:
        normalized_speaker = " ".join(str(speaker or "").split()).strip()
        if normalized_speaker not in known_wake_speakers():
            return ""
        if lock_held:
            accepted = self._remember_browser_session_speaker(
                client_id,
                session_id,
                normalized_speaker,
                score,
            )
        else:
            with self._browser_turn_lock:
                accepted = self._remember_browser_session_speaker(
                    client_id,
                    session_id,
                    normalized_speaker,
                    score,
                )
        if not accepted:
            return ""
        self._record_identified_speaker(normalized_speaker)
        self._log_voice_event(
            "browser_voice_speaker_resolved",
            client_id=self._normalize_browser_client_id(client_id),
            session_id=session_id,
            source=str(source or "browser_speaker").strip() or "browser_speaker",
            matched_speaker=normalized_speaker,
            confidence=round(max(0.0, float(score or 0.0)), 3),
            after_greeting_deadline=bool(late),
        )
        return normalized_speaker

    def _accept_browser_speaker_future(
        self,
        client_id: str,
        session_id: str,
        source: str,
        future,
        *,
        deadline: float = 0.0,
    ) -> str:
        try:
            speaker, score = future.result()
        except Exception as err:
            self._log_voice_event(
                "browser_voice_speaker_failed",
                client_id=self._normalize_browser_client_id(client_id),
                session_id=session_id,
                source=str(source or "browser_speaker").strip() or "browser_speaker",
                error=str(err),
            )
            return ""
        return self._accept_browser_speaker_result(
            client_id,
            session_id,
            source,
            speaker,
            score,
            late=bool(deadline and time.monotonic() > deadline),
        )

    def _drop_browser_session(self, client_id: str, reason: str = "") -> None:
        normalized = self._normalize_browser_client_id(client_id)
        session = self._browser_sessions.pop(normalized, None)
        if session is not None:
            for future in (session.wake_prompt_future, session.wake_speaker_future):
                if future is None:
                    continue
                with contextlib.suppress(Exception):
                    future.cancel()
            self._log_voice_event(
                "browser_voice_session_ended",
                client_id=normalized,
                session_id=session.session_id,
                reason=str(reason or "").strip() or None,
            )
        if not self._browser_sessions:
            self._cancel_browser_presence_timer()
            self._clear_tts_phrase()
            self._restore_active_voice_state()

    def _cancel_browser_presence_timer(self) -> None:
        with self._browser_presence_lock:
            timer = self._browser_presence_timer
            self._browser_presence_timer = None
        if timer is not None:
            timer.cancel()

    def _schedule_browser_presence_reset(self, duration_ms: int = 0, end_session: bool = False) -> None:
        self._cancel_browser_presence_timer()
        delay_seconds = max(0.25, float(max(0, int(duration_ms or 0))) / 1000.0)

        def finish() -> None:
            self._clear_tts_phrase()
            if end_session:
                self._set_voice_state("idle")
            else:
                self._restore_active_voice_state()
            with self._browser_presence_lock:
                self._browser_presence_timer = None

        timer = threading.Timer(delay_seconds, finish)
        timer.daemon = True
        with self._browser_presence_lock:
            self._browser_presence_timer = timer
        timer.start()

    def _mark_browser_playback_state(self, text: str = "", phase: str = "", end_session: bool = False) -> None:
        spoken = " ".join(str(text or "").split()).strip()
        duration_ms = estimate_tts_duration_ms(spoken) if spoken else 800
        if spoken:
            self._publish_tts_phrase(spoken, phase=phase, duration_ms=duration_ms)
        else:
            self._clear_tts_phrase()
        self._set_voice_state("speaking")
        self._schedule_browser_presence_reset(duration_ms=duration_ms, end_session=end_session)

    def _handle_browser_playback_event(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValueError("request body must be an object")
        client_id = self._normalize_browser_client_id(body.get("client_id") or "browser-default")
        event = str(body.get("event") or "").strip().lower()
        playback_id = " ".join(str(body.get("playback_id") or "").split()).strip()[:128]
        if event not in {"started", "finished"} or not playback_id:
            raise ValueError("playback event and playback_id are required")
        publisher = getattr(self, "_ha_state_publisher", None)
        if publisher is None:
            return {"ok": True, "ignored": True}
        if event == "started":
            text = " ".join(str(body.get("text") or "").split()).strip()
            phase = " ".join(str(body.get("phase") or "").split()).strip()
            speaker = self._speaker_snapshot() or UNKNOWN_SPEAKER
            with self._endpoint_playback_lock:
                self._endpoint_playbacks[client_id] = playback_id
            publisher.set_endpoint_tts_phrase(
                text,
                phase=phase,
                speaker=speaker,
                client_id=client_id,
                playback_id=playback_id,
            )
            self._log_voice_event(
                "browser_endpoint_playback_started",
                client_id=client_id,
                playback_id=playback_id,
                phase=phase or None,
                utterance=self._event_text(text),
            )
            return {"ok": True, "playing": True}
        with self._endpoint_playback_lock:
            active_playback_id = self._endpoint_playbacks.get(client_id, "")
            if active_playback_id != playback_id:
                return {"ok": True, "ignored": True, "playing": bool(active_playback_id)}
            self._endpoint_playbacks.pop(client_id, None)
        cleared = publisher.clear_endpoint_tts_phrase(playback_id=playback_id)
        self._log_voice_event(
            "browser_endpoint_playback_finished",
            client_id=client_id,
            playback_id=playback_id,
            cleared=bool(cleared),
        )
        return {"ok": True, "playing": False}

    def _handle_browser_voice_wake(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValueError("request body must be an object")
        client_id = self._normalize_browser_client_id(body.get("client_id") or "browser-default")
        encoded_audio = str(body.get("audio_base64") or "").strip()
        wake_recent_audio = b""
        if encoded_audio:
            try:
                wake_recent_audio = decode_browser_audio_to_pcm(base64.b64decode(encoded_audio, validate=True))
            except Exception as err:
                raise ValueError(f"invalid wake audio: {err}") from err
        with self._browser_turn_lock:
            self._drop_browser_session(client_id, reason="wake_restart")
            requested_at = time.monotonic()
            trusted_speaker = self._trusted_browser_speaker(client_id)
            session = BrowserVoiceSession(
                session_id=self._build_browser_session_id(),
                last_seen_at=requested_at,
                wake_requested_at=requested_at,
                speaker_name=trusted_speaker,
                speaker_confidence=1.0 if trusted_speaker else 0.0,
            )
            session.wake_prompt_future = self._browser_wake_executor.submit(
                self._prepare_browser_wake_prompt_clips,
                client_id,
                session.session_id,
                wake_recent_audio,
                requested_at,
            )
            self._browser_sessions[client_id] = session
            self._ensure_browser_session_reaper()
            self._log_voice_event(
                "browser_voice_session_started",
                client_id=client_id,
                session_id=session.session_id,
                trusted_speaker=trusted_speaker or None,
            )
            self._log_voice_event(
                "browser_voice_wake_started",
                client_id=client_id,
                session_id=session.session_id,
                wake_recent_audio_ms=int(round(len(wake_recent_audio) * 1000 / float(SAMPLE_RATE * SAMPLE_WIDTH))) if wake_recent_audio else None,
            )
            self._cancel_browser_presence_timer()
            self._clear_tts_phrase()
            self._set_voice_state("listening")
            clips = []
            ack_clip = self._browser_wake_ack_clip()
            if ack_clip:
                clips.append(ack_clip)
            return {
                "ok": True,
                "status": "wake_started",
                "client_id": client_id,
                "session_id": session.session_id,
                "audio_clips": clips,
                "prompt_pending": True,
                "poll_after_ms": 100,
            }

    def _handle_browser_voice_wake_prompt(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValueError("request body must be an object")
        client_id = self._normalize_browser_client_id(body.get("client_id") or "browser-default")
        requested_session_id = " ".join(str(body.get("session_id") or "").split()).strip()
        if not requested_session_id:
            raise ValueError("session_id required")
        with self._browser_turn_lock:
            session = self._browser_sessions.get(client_id)
            if session is None or session.session_id != requested_session_id:
                return {
                    "ok": True,
                    "status": "expired",
                    "client_id": client_id,
                    "session_id": "",
                    "audio_clips": [],
                    "end_session": True,
                }
            session.last_seen_at = time.monotonic()
            future = session.wake_prompt_future
            delivered = bool(session.wake_prompt_delivered)
        if delivered:
            return {
                "ok": True,
                "status": "ready",
                "client_id": client_id,
                "session_id": requested_session_id,
                "audio_clips": [],
                "end_session": False,
            }
        if future is None:
            return {
                "ok": True,
                "status": "ready",
                "client_id": client_id,
                "session_id": requested_session_id,
                "audio_clips": [],
                "end_session": False,
            }
        if not future.done():
            return {
                "ok": True,
                "status": "pending",
                "client_id": client_id,
                "session_id": requested_session_id,
                "audio_clips": [],
                "poll_after_ms": 100,
                "end_session": False,
            }
        clips = list(future.result() or [])
        with self._browser_turn_lock:
            session = self._browser_sessions.get(client_id)
            if session is not None and session.session_id == requested_session_id:
                session.wake_prompt_future = None
                session.wake_prompt_delivered = True
        return {
            "ok": True,
            "status": "ready",
            "client_id": client_id,
            "session_id": requested_session_id,
            "audio_clips": clips,
            "end_session": False,
        }

    def _prepared_speech_to_browser_clip(
        self,
        prepared: PreparedSpeech,
        *,
        text: str = "",
        phase: str = "",
    ) -> dict:
        spoken = " ".join(str(text or prepared.utterance or "").split()).strip()
        try:
            if prepared.raw_pcm:
                with open(prepared.path, "rb") as handle:
                    wav_bytes = encode_wav_bytes(handle.read(), sample_rate=prepared.sample_rate)
            else:
                with open(prepared.path, "rb") as handle:
                    wav_bytes = handle.read()
            return {
                "mime_type": "audio/wav",
                "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
                "backend": prepared.backend,
                "phase": str(phase or prepared.phase or "").strip() or None,
                "text": spoken or None,
            }
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(prepared.path)

    def _browser_beep_clip(self) -> dict:
        frame_count = max(1, int(SAMPLE_RATE * BEEP_DURATION_MS / 1000))
        level = int(32767 * BEEP_AMPLITUDE)
        frames = bytearray()
        for index in range(frame_count):
            sample = int(level * math.sin(2.0 * math.pi * BEEP_FREQUENCY_HZ * index / SAMPLE_RATE))
            frames.extend(sample.to_bytes(2, byteorder="little", signed=True))
        return {
            "mime_type": "audio/wav",
            "audio_base64": base64.b64encode(encode_wav_bytes(bytes(frames), sample_rate=SAMPLE_RATE)).decode("ascii"),
            "backend": "local_beep",
            "phase": "confirm_beep",
            "text": None,
        }

    def _browser_clip_from_file_path(
        self,
        clip_path: str,
        *,
        phase: str = "",
        text: str = "",
        speed: float = 1.0,
        volume: float = 1.0,
    ) -> dict:
        normalized = os.path.expanduser(str(clip_path or "").strip())
        if not normalized or not os.path.isfile(normalized):
            raise FileNotFoundError(f"browser clip missing: {normalized}")
        normalized_speed = max(0.5, min(2.0, float(speed or 1.0)))
        normalized_volume = max(0.0, min(2.0, float(volume if volume is not None else 1.0)))
        ffmpeg_cmd = [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            normalized,
        ]
        filters = []
        if abs(normalized_speed - 1.0) > 0.001:
            filters.append(f"atempo={normalized_speed:.3f}")
        if abs(normalized_volume - 1.0) > 0.001:
            filters.append(f"volume={normalized_volume:.3f}")
        if filters:
            ffmpeg_cmd.extend(["-filter:a", ",".join(filters)])
        ffmpeg_cmd.extend([
            "-f",
            "wav",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-",
        ])
        result = subprocess.run(
            ffmpeg_cmd,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode != 0 or not result.stdout:
            detail = result.stderr.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(f"browser clip transcode failed: {detail}")
        spoken = " ".join(str(text or "").split()).strip()
        return {
            "mime_type": "audio/wav",
            "audio_base64": base64.b64encode(result.stdout).decode("ascii"),
            "backend": "local_clip",
            "phase": str(phase or "").strip() or None,
            "text": spoken or None,
        }

    def _browser_wake_ack_clip(self) -> dict | None:
        clip_path = str(getattr(self._config, "wake_ack_clip_path", "") or "").strip()
        if not clip_path:
            return None
        clip_speed = float(getattr(self._config, "wake_ack_clip_speed", DEFAULT_WAKE_ACK_CLIP_SPEED) or DEFAULT_WAKE_ACK_CLIP_SPEED)
        clip_volume = float(getattr(self._config, "wake_ack_clip_volume", DEFAULT_WAKE_ACK_CLIP_VOLUME) or DEFAULT_WAKE_ACK_CLIP_VOLUME)
        try:
            return self._browser_clip_from_file_path(
                clip_path,
                phase="wake_ack",
                speed=clip_speed,
                volume=clip_volume,
            )
        except Exception as err:
            log(f"browser wake ack clip failed: {err}")
            return None

    def _prepare_browser_wake_prompt_clips(
        self,
        client_id: str,
        session_id: str,
        wake_recent_audio: bytes,
        wake_requested_at: float,
    ) -> list[dict]:
        speaker = UNKNOWN_SPEAKER
        wake_audio = self._prepare_wake_speaker_audio(wake_recent_audio)
        speaker_future = None
        if wake_audio and self._speaker_id.can_identify():
            speaker_future = self._speaker_executor.submit(self._speaker_id.identify, wake_audio, "wake_browser")
        # The ack clip exists to cover wake speaker ID. Without one the
        # greeting goes at once and a later speaker result still lands on
        # the session.
        hold_seconds = WAKE_PROMPT_MIN_DELAY_SECONDS if str(getattr(self._config, "wake_ack_clip_path", "") or "").strip() else 0.0
        prompt_deadline = float(wake_requested_at) + hold_seconds
        if speaker_future is not None:
            with self._browser_turn_lock:
                current_session = self._browser_sessions.get(self._normalize_browser_client_id(client_id))
                if current_session is not None and current_session.session_id == session_id:
                    current_session.wake_speaker_future = speaker_future
            speaker_future.add_done_callback(
                lambda completed: self._accept_browser_speaker_future(
                    client_id,
                    session_id,
                    "browser_wake",
                    completed,
                    deadline=prompt_deadline,
                )
            )
            remaining_seconds = max(0.0, prompt_deadline - time.monotonic())
            try:
                matched_speaker, score = speaker_future.result(timeout=remaining_seconds if remaining_seconds > 0.0 else 0.0)
                if str(matched_speaker or "").strip() in known_wake_speakers():
                    speaker = str(matched_speaker or "").strip()
            except FutureTimeoutError:
                speaker = UNKNOWN_SPEAKER
            except Exception as err:
                log(f"browser wake speaker guess failed client_id={client_id}: {err}")
        remaining_delay = max(0.0, prompt_deadline - time.monotonic())
        if remaining_delay > 0.0:
            time.sleep(remaining_delay)
        spoken = self._prompt_texts.build_wake_greeting(speaker=speaker, prefer=self._wake_greeting_cached) or str(self._config.greeting or "").strip()
        if not spoken:
            return []
        with self._speech_lock:
            prepared = self._prepare_wake_greeting_speech(spoken)
        self._log_voice_event(
            "browser_voice_wake_prompt_ready",
            client_id=client_id,
            session_id=session_id,
            greeting_speaker=speaker or None,
            utterance=spoken,
        )
        self._mark_browser_playback_state(spoken, phase="wake_greeting", end_session=False)
        return [self._prepared_speech_to_browser_clip(prepared, text=spoken, phase="wake_greeting")]

    def _wake_greeting_cached(self, line: str) -> bool:
        available = getattr(getattr(self, "_tts", None), "cached_speech_available", None)
        return bool(callable(available) and available(line, speech=dict(WAKE_GREETING_SPEECH), phase="wake_greeting"))

    def _prepare_wake_greeting_speech(self, spoken: str):
        if hasattr(self._tts, "prepare_cached_speech"):
            prepared = self._tts.prepare_cached_speech(spoken, speech=dict(WAKE_GREETING_SPEECH), phase="wake_greeting")
            if getattr(prepared, "backend", "") == "espeak" and getattr(self._tts, "_fish_ready", False):
                # A greeting is the first thing heard; one Fish retry beats a robot voice.
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(prepared.path)
                prepared = self._tts.prepare_cached_speech(spoken, speech=dict(WAKE_GREETING_SPEECH), phase="wake_greeting")
            return prepared
        return self._tts.prepare_speech(spoken, phase="wake_greeting")

    def _start_wake_greeting_cache_warmup(self) -> None:
        """Once at start: renders the day and night greeting sets on a separate
        Fish worker, current mode first. Wakes never start a warm-up."""
        tts = getattr(self, "_tts", None)
        warm = getattr(tts, "warm_speech_cache_isolated", None)
        if not callable(warm):
            return
        lock = self.__dict__.setdefault("_greeting_warm_lock", threading.Lock())
        with lock:
            if self.__dict__.get("_greeting_warm_started"):
                return
            self._greeting_warm_started = True
        night_now = getattr(tts, "night_quiet_now", None)
        night_first = bool(callable(night_now) and night_now())

        def run() -> None:
            for night in (night_first, not night_first):
                lines = [*WAKE_ACKS, *all_wake_greetings()]
                rendered = warm(lines, speech=dict(WAKE_GREETING_SPEECH), phase="wake_greeting", night=night)
                log(f"wake greeting cache warm: mode={'night' if night else 'day'} rendered={rendered} total={len(lines)}")

        threading.Thread(target=run, name="greeting-cache-warmup", daemon=True).start()

    def _start_browser_tail_poll(self, reply_result: JarvisReply, lead_text: str):
        if reply_result.failure:
            return None
        return self._start_personality_tail_poll(
            reply_result,
            timeout_seconds=personality_tail_poll_timeout_for_text(lead_text),
        )

    def _cancel_personality_tail(self, tail_metadata: dict | None) -> bool:
        cancel_tail = getattr(getattr(self, "_jarvis", None), "cancel_tail", None)
        if not callable(cancel_tail):
            return False
        def cancel() -> None:
            try:
                cancel_tail(tail_metadata)
            except Exception as err:
                self._log_voice_event("personality_tail_cancel_failed", error=str(err))

        threading.Thread(target=cancel, name="housemate-tail-cancel", daemon=True).start()
        return True

    def _track_tail_poll_future(self, future, tail_metadata: dict | None) -> None:
        setattr(future, "jarvis_tail_metadata", tail_metadata)
        lock = getattr(self, "_tail_poll_lock", None)
        if lock is None:
            lock = threading.Lock()
            self._tail_poll_lock = lock
        futures = getattr(self, "_tail_poll_futures", None)
        if futures is None:
            futures = set()
            self._tail_poll_futures = futures
        with lock:
            futures.add(future)

        def finished(completed) -> None:
            with lock:
                futures.discard(completed)

        future.add_done_callback(finished)

    def _cancel_tail_poll_future(self, future) -> None:
        if future is None:
            return
        self._cancel_personality_tail(getattr(future, "jarvis_tail_metadata", None))
        future.cancel()

    def _cancel_all_tail_polls(self) -> None:
        lock = getattr(self, "_tail_poll_lock", None)
        futures = getattr(self, "_tail_poll_futures", None)
        if lock is None or not futures:
            return
        with lock:
            pending = list(futures)
        for future in pending:
            self._cancel_tail_poll_future(future)

    def _browser_tail_if_ready(self, tail_future, tail_metadata: dict | None = None, utterance: str = "") -> JarvisTail | None:
        if tail_future is None:
            return None
        if not tail_future.done():
            self._cancel_tail_poll_future(tail_future)
            self._log_voice_event(
                "browser_voice_tail_skipped",
                utterance=utterance,
                reason="tail_not_ready_when_lead_finished",
            )
            return None
        try:
            tail = tail_future.result()
        except Exception as err:
            self._log_voice_event("browser_voice_tail_failed", utterance=utterance, error=str(err))
            return None
        if not isinstance(tail, JarvisTail) or tail.status != "ready" or not tail.text:
            return None
        self._log_voice_event(
            "browser_voice_tail_ready",
            utterance=utterance,
            reply_chars=len(tail.text),
            latency_ms=tail.latency_ms,
        )
        return tail

    def _prepare_browser_tail_clips(self, tail: JarvisTail | None) -> list[dict]:
        if tail is None:
            return []
        with self._speech_lock:
            prepared = self._tail_prepare_tts.prepare_speech(
                tail.text,
                speech=tail.speech,
                phase="personality_tail",
            )
        return [self._prepared_speech_to_browser_clip(prepared, text=tail.text, phase="personality_tail")]

    def _handle_browser_voice_turn(
        self,
        body: dict,
        stream_writer=None,
        *,
        audio_bytes_override: bytes | None = None,
        stt_live_session=None,
    ) -> dict:
        if not isinstance(body, dict):
            raise ValueError("request body must be an object")
        client_id = " ".join(str(body.get("client_id") or "browser-default").split()).strip()[:128] or "browser-default"
        wake_attached = bool(body.get("wake_attached", False))
        wake_candidate = wake_attached and bool(body.get("wake_candidate", False))
        # The endpoint's own wake model was sure: its words are kept even when STT misses the phrase.
        wake_confident = wake_candidate and bool(body.get("wake_confident", False))
        endpoint_wake_speaker = body.get("endpoint_wake_speaker_future")
        if audio_bytes_override is not None:
            audio_bytes = bytes(audio_bytes_override)
        else:
            encoded_audio = str(body.get("audio_base64") or "").strip()
            if not encoded_audio:
                raise ValueError("audio_base64 required")
            try:
                audio_bytes = decode_browser_audio_to_pcm(base64.b64decode(encoded_audio, validate=True))
            except Exception as err:
                raise ValueError(f"invalid browser audio: {err}") from err
        if not audio_bytes:
            raise ValueError("decoded browser audio was empty")
        with self._browser_turn_lock:
            turn_id = self._build_turn_id("browser-turn")
            turn_started = time.monotonic()
            with self._voice_event_context(turn_id=turn_id, transport="browser_voice", client_id=client_id):
                turn_speaker_future = None
                turn_speaker_session_id = ""
                existing_session = self._browser_session_for_client(client_id, create=False)
                speaker_identifier = getattr(self, "_speaker_id", None)
                if (
                    existing_session is not None
                    and speaker_identifier is not None
                    and speaker_identifier.can_identify()
                ):
                    turn_speaker_session_id = existing_session.session_id
                    if self._is_endpoint_client(client_id):
                        turn_speaker_future = self._speaker_executor.submit(
                            self._identify_endpoint_turn,
                            existing_session,
                            audio_bytes,
                        )
                    else:
                        turn_speaker_future = self._speaker_executor.submit(
                            speaker_identifier.identify,
                            audio_bytes,
                            "browser_turn",
                        )
                    turn_speaker_future.add_done_callback(
                        lambda completed: self._accept_browser_speaker_future(
                            client_id,
                            turn_speaker_session_id,
                            "browser_turn",
                            completed,
                        )
                    )

                def emit_stream_meta(result: dict) -> None:
                    if not callable(stream_writer):
                        return
                    stream_writer(
                        {
                            "event": "meta",
                            "status": str(result.get("status") or "").strip(),
                            "client_id": result.get("client_id"),
                            "heard_text": result.get("heard_text"),
                            "reply_text": result.get("reply_text"),
                            "model_used": bool(result.get("model_used", False)),
                            "session_id": result.get("session_id"),
                            "end_session": bool(result.get("end_session", False)),
                            "error_code": result.get("error_code"),
                            "music_hold": bool(result.get("music_hold", False)),
                            "listen_again": bool(result.get("listen_again", True)),
                        }
                    )

                def emit_stream_clip(clip: dict) -> None:
                    if callable(stream_writer):
                        stream_writer({"event": "audio_clip", "clip": clip})

                def emit_stream_open(stream_info: dict) -> None:
                    if not callable(stream_writer):
                        return
                    stream_writer(
                        {
                            "event": "audio_open",
                            "backend": stream_info.get("backend"),
                            "stream_id": stream_info.get("stream_id"),
                            "phase": stream_info.get("phase"),
                            "sample_rate": int(stream_info.get("sample_rate") or SAMPLE_RATE),
                            "channels": int(stream_info.get("channels") or 1),
                            "sample_width": int(stream_info.get("sample_width") or SAMPLE_WIDTH),
                            "text": stream_info.get("text"),
                        }
                    )

                def emit_stream_chunk(chunk: bytes) -> None:
                    if not callable(stream_writer):
                        return
                    stream_writer(
                        {
                            "event": "audio_chunk",
                            "audio_base64": base64.b64encode(bytes(chunk or b"")).decode("ascii"),
                        }
                    )

                def emit_stream_close(stream_info: dict | None = None) -> None:
                    if not callable(stream_writer):
                        return
                    info = stream_info if isinstance(stream_info, dict) else {}
                    stream_writer(
                        {
                            "event": "audio_close",
                            "phase": str(info.get("phase") or "").strip() or None,
                        }
                    )

                def emit_stream_audio(text: str, speech: dict | None = None, phase: str = "") -> None:
                    if not callable(stream_writer):
                        return
                    output_opened = False

                    def on_stream_start(stream_info: dict) -> None:
                        nonlocal output_opened
                        emit_stream_open(stream_info)
                        output_opened = True

                    try:
                        self._tts.stream_browser_speech(
                            text,
                            speech=speech,
                            phase=phase,
                            start_callback=on_stream_start,
                            chunk_callback=emit_stream_chunk,
                        )
                    finally:
                        if output_opened:
                            emit_stream_close({"phase": phase})

                self._log_voice_event(
                    "voice_turn_started",
                    mode="browser_voice",
                    wake_attached=bool(wake_attached),
                    audio_seconds=round(len(audio_bytes) / float(SAMPLE_RATE * SAMPLE_WIDTH), 3),
                )
                self._log_voice_event(
                    "browser_voice_turn_received",
                    audio_seconds=round(len(audio_bytes) / float(SAMPLE_RATE * SAMPLE_WIDTH), 3),
                )
                stt_started = time.monotonic()
                if stt_live_session is not None:
                    utterance = self._stt.transcribe_bytes(audio_bytes, live_session=stt_live_session)
                else:
                    utterance = self._stt.transcribe_bytes(audio_bytes)
                stt_finished_at = time.monotonic()
                self._log_voice_event(
                    "browser_voice_stt_finished",
                    # Unconfirmed possible wakes may be room chatter: no text.
                    utterance=None if wake_candidate else self._event_text(utterance),
                    wake_candidate=True if wake_candidate else None,
                    latency_ms=int(round((stt_finished_at - stt_started) * 1000)),
                )
                if not utterance and wake_candidate:
                    return self._reject_browser_wake_candidate(client_id, "", turn_started, emit_stream_meta)
                if not utterance:
                    result = {
                        "ok": True,
                        "status": "no_input",
                        "client_id": client_id,
                        "heard_text": "",
                        "reply_text": "",
                        "session_id": "",
                        "end_session": False,
                        "audio_clips": [],
                    }
                    self._log_voice_event(
                        "voice_turn_finished",
                        status="no_input",
                        total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                    )
                    emit_stream_meta(result)
                    return result
                corrected = apply_known_transcript_corrections(utterance)
                if corrected != utterance:
                    utterance = corrected
                wake_only_heard = False
                if wake_candidate:
                    command, outcome = resolve_wake_attached_utterance(utterance, self._config.phrase_variants)
                    if outcome not in {"wake_stripped", "wake_only"}:
                        # The voice host confirms every wake, as the stock Echo's second stage does: the endpoint
                        # being sure is not enough. A
                        # confident wake keeps words that sound like a misheard "Hey Housemate"; nothing else.
                        if not (wake_confident and looks_like_misheard_wake(utterance)):
                            return self._reject_browser_wake_candidate(
                                client_id, utterance, turn_started, emit_stream_meta, wake_confident=wake_confident
                            )
                        command, outcome = utterance, "kept_confident_wake"
                    wake_only_heard = outcome == "wake_only"
                    self._log_voice_event(
                        "browser_voice_wake_prefix",
                        outcome=f"{outcome}_candidate",
                        heard_text=self._event_text(utterance),
                        command=self._event_text(command),
                    )
                    utterance = command
                elif wake_attached:
                    utterance = self._resolve_browser_wake_attached_utterance(
                        utterance,
                        audio_bytes,
                        streamed=stt_live_session is not None,
                    )
                self._save_browser_turn_sample(
                    turn_id=turn_id,
                    client_id=client_id,
                    audio=audio_bytes,
                    heard_text=corrected,
                    command=utterance,
                    wake_attached=wake_attached,
                    wake_candidate=wake_candidate,
                    stt_latency_ms=int(round((stt_finished_at - stt_started) * 1000)),
                )
                if not utterance and wake_only_heard and self._is_endpoint_client(client_id):
                    return self._endpoint_wake_greeting(
                        client_id, endpoint_wake_speaker, turn_started, emit_stream_meta, emit_stream_clip
                    )
                if not utterance:
                    result = {
                        "ok": True,
                        "status": "no_input",
                        "client_id": client_id,
                        "heard_text": "",
                        "reply_text": "",
                        "session_id": "",
                        "end_session": False,
                        "audio_clips": [],
                    }
                    self._log_voice_event(
                        "voice_turn_finished",
                        status="wake_only",
                        total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                    )
                    emit_stream_meta(result)
                    return result
                if self._matches_kill_phrase(utterance):
                    self._drop_browser_session(client_id, reason="kill")
                    with self._speech_lock:
                        prepared = self._tts.prepare_speech(self._config.goodbye, phase="goodbye")
                    result = {
                        "ok": True,
                        "status": "ended",
                        "client_id": client_id,
                        "heard_text": utterance,
                        "reply_text": self._config.goodbye,
                        "session_id": "",
                        "end_session": True,
                        "audio_clips": [self._prepared_speech_to_browser_clip(prepared, text=self._config.goodbye, phase="goodbye")],
                    }
                    self._mark_browser_playback_state(
                        self._config.goodbye,
                        phase="goodbye",
                        end_session=True,
                    )
                    self._log_voice_event(
                        "voice_turn_finished",
                        status="kill",
                        heard_text=self._event_text(utterance),
                        reply_text=self._event_text(self._config.goodbye),
                        total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                    )
                    if callable(stream_writer):
                        for clip in result["audio_clips"]:
                            emit_stream_clip(clip)
                    emit_stream_meta(result)
                    return result
                if body.get("ha_intents") and looks_like_ha_timer_command(utterance):
                    # The agent hands these words to HA's own intents, on the satellite.
                    result = {
                        "ok": True,
                        "status": "ha_intent",
                        "client_id": client_id,
                        "heard_text": utterance,
                        "reply_text": "",
                        "session_id": "",
                        "end_session": False,
                        "audio_clips": [],
                    }
                    self._log_voice_event(
                        "voice_turn_finished",
                        status="ha_intent",
                        heard_text=self._event_text(utterance),
                        total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                    )
                    emit_stream_meta(result)
                    return result
                if self._is_endpoint_client(client_id) and is_calibration_start_command(utterance):
                    gateway = getattr(self, "_endpoint_gateway", None)
                    # An Assist speaker records takes too; its agent starts the session.
                    able = body.get("ha_intents") or (gateway is not None and gateway.supports(client_id, "voice.calibration"))
                    calibration_text = CALIBRATION_START_TEXT if able else CALIBRATION_UNSUPPORTED_TEXT
                    self._drop_browser_session(client_id, reason="calibration")
                    with self._speech_lock:
                        prepared = self._tts.prepare_speech(calibration_text, phase="calibration")
                    result = {
                        "ok": True,
                        "status": "final_reply",
                        "client_id": client_id,
                        "heard_text": utterance,
                        "reply_text": calibration_text,
                        "model_used": False,
                        "session_id": "",
                        "end_session": True,
                        "audio_clips": [self._prepared_speech_to_browser_clip(prepared, text=calibration_text, phase="calibration")],
                    }
                    self._mark_browser_playback_state(calibration_text, phase="calibration", end_session=True)
                    self._log_voice_event(
                        "voice_turn_finished",
                        status="calibration" if able else "calibration_unsupported",
                        heard_text=self._event_text(utterance),
                        total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                    )
                    if callable(stream_writer):
                        for clip in result["audio_clips"]:
                            emit_stream_clip(clip)
                        meta = {
                            "event": "meta", "status": "final_reply", "client_id": client_id,
                            "heard_text": utterance, "reply_text": calibration_text, "end_session": True,
                        }
                        if able:
                            meta["endpoint_command"] = {
                                "type": "calibrate", "takes": CALIBRATION_TAKES, "timeout_ms": CALIBRATION_TIMEOUT_MS,
                            }
                        stream_writer(meta)
                    return result
                ears_reply = self._ears_test_reply(client_id, utterance, corrected, audio_bytes, wake_attached)
                if ears_reply is not None:
                    ears_text, ears_end = ears_reply
                    with self._speech_lock:
                        prepared = self._tts.prepare_speech(ears_text, phase="ears_test")
                    ears_session = self._browser_session_for_client(client_id, create=False)
                    result = {
                        "ok": True,
                        # final_reply keeps the terminal's listen beep and follow-up turn.
                        "status": "final_reply",
                        "client_id": client_id,
                        "heard_text": utterance,
                        "reply_text": ears_text,
                        "model_used": False,
                        "session_id": "" if ears_end or ears_session is None else ears_session.session_id,
                        "end_session": ears_end,
                        "audio_clips": [self._prepared_speech_to_browser_clip(prepared, text=ears_text, phase="ears_test")],
                    }
                    if ears_end:
                        self._drop_browser_session(client_id, reason="ears_test_end")
                    self._mark_browser_playback_state(ears_text, phase="ears_test", end_session=ears_end)
                    self._log_voice_event(
                        "voice_turn_finished",
                        status="ears_test",
                        heard_text=self._event_text(utterance),
                        reply_text=self._event_text(ears_text),
                        total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                        end_session=ears_end,
                    )
                    if callable(stream_writer):
                        for clip in result["audio_clips"]:
                            emit_stream_clip(clip)
                    emit_stream_meta(result)
                    return result
                browser_session = self._browser_session_for_client(client_id, create=True)
                # The wake is confirmed by now: the endpoint's early wake-word match may count. It was
                # started a second or more ago, so this rarely waits at all.
                if (
                    endpoint_wake_speaker is not None
                    and browser_session is not None
                    and not browser_session.speaker_name
                    and browser_session.wake_speaker_future is None
                ):
                    with contextlib.suppress(Exception):
                        endpoint_wake_speaker.result(timeout=ENDPOINT_TURN_SPEAKER_WAIT_S)
                    browser_session.wake_speaker_future = endpoint_wake_speaker
                pending_speaker_futures = []
                if browser_session is not None and browser_session.wake_speaker_future is not None:
                    pending_speaker_futures.append(("browser_wake", browser_session.wake_speaker_future))
                if (
                    browser_session is not None
                    and turn_speaker_future is not None
                    and turn_speaker_session_id == browser_session.session_id
                ):
                    pending_speaker_futures.append(("browser_turn", turn_speaker_future))
                for source, pending_future in pending_speaker_futures:
                    if not pending_future.done():
                        continue
                    try:
                        matched_speaker, matched_score = pending_future.result()
                    except Exception:
                        continue
                    self._accept_browser_speaker_result(
                        client_id,
                        browser_session.session_id,
                        source,
                        matched_speaker,
                        matched_score,
                        lock_held=True,
                    )
                    if source == "browser_wake":
                        browser_session.wake_speaker_future = None
                session_id = browser_session.session_id if browser_session else ""
                speaker_name = browser_session.speaker_name if browser_session else ""
                speaker_confidence = browser_session.speaker_confidence if browser_session else 0.0
                # An endpoint session's speaker is locked, but this turn may confidently be someone
                # else (another person answering): credit them for this turn only.
                if (
                    self._is_endpoint_client(client_id)
                    and browser_session is not None
                    and turn_speaker_future is not None
                    and turn_speaker_session_id == browser_session.session_id
                ):
                    # A follow-up in a session that already knows its speaker does not wait: the
                    # check only raises confidence or credits someone else, and up to 0.5 s on
                    # every chat turn is felt. A finished check still counts.
                    try:
                        turn_name, turn_score = turn_speaker_future.result(
                            timeout=0 if speaker_name else ENDPOINT_TURN_SPEAKER_WAIT_S
                        )
                    except Exception:
                        turn_name, turn_score = "", 0.0
                    if (
                        turn_name
                        and turn_name == speaker_name
                        and float(turn_score or 0.0) > speaker_confidence
                    ):
                        # The same person, heard more surely: a sentence carries far more of a voice
                        # than "Hey Housemate", so the session's confidence rises (the name stays locked).
                        browser_session.speaker_confidence = float(turn_score)
                        speaker_confidence = float(turn_score)
                        self._log_voice_event(
                            "endpoint_turn_speaker_confirmed",
                            client_id=self._normalize_browser_client_id(client_id),
                            session_id=session_id,
                            speaker=speaker_name,
                            confidence=round(speaker_confidence, 3),
                        )
                    elif turn_name in known_wake_speakers() and turn_name != speaker_name:
                        self._log_voice_event(
                            "endpoint_turn_speaker",
                            client_id=self._normalize_browser_client_id(client_id),
                            session_id=session_id,
                            locked_speaker=speaker_name or None,
                            turn_speaker=turn_name,
                            confidence=round(float(turn_score or 0.0), 3),
                        )
                        speaker_name, speaker_confidence = turn_name, float(turn_score or 0.0)
                self._cancel_browser_presence_timer()
                self._clear_tts_phrase()
                self._set_voice_state("processing")
                session_context = self._voice_event_context(session_id=session_id) if session_id else contextlib.nullcontext()
                endpoint_info = self._endpoint_turn_info(client_id)
                with session_context:
                    request_started = time.monotonic()
                    self._set_voice_state("thinking")
                    self._log_voice_event("jarvis_http_request_started", utterance=self._event_text(utterance))
                    progressive_spoken = False
                    try:
                        if callable(stream_writer):
                            try:
                                reply_result = self._ask_jarvis_progressive(
                                    None,
                                    utterance,
                                    speaker_name=speaker_name,
                                    speaker_confidence=speaker_confidence,
                                    turn_complete_at=stt_finished_at,
                                    session_id=session_id,
                                    endpoint=endpoint_info,
                                    output_callbacks={
                                        "start": emit_stream_open,
                                        "chunk": emit_stream_chunk,
                                        "close": emit_stream_close,
                                    },
                                    restore_voice_state=False,
                                )
                                progressive_spoken = bool(reply_result.progressive_spoken)
                            except (ProgressiveStreamUnavailable, ProgressiveTurnError, TTSPlaybackError) as err:
                                if is_browser_voice_client_disconnected(err):
                                    raise BrowserVoiceClientDisconnected("browser voice client disconnected") from err
                                if not progressive_error_allows_legacy(err):
                                    self._log_voice_event(
                                        "progressive_voice_replay_blocked",
                                        utterance=utterance,
                                        speaker_guess=speaker_name or None,
                                        reason=type(err).__name__,
                                        error=str(err),
                                        transport="browser_voice",
                                    )
                                    raise
                                log(f"browser progressive voice unavailable before playback; using legacy path: {err}")
                                self._log_voice_event(
                                    "progressive_voice_fallback",
                                    utterance=utterance,
                                    speaker_guess=speaker_name or None,
                                    reason=type(err).__name__,
                                    error=str(err),
                                    transport="browser_voice",
                                )
                                self._set_voice_state("thinking")
                                reply_result = self._jarvis.ask(
                                    utterance,
                                    speaker_name=speaker_name,
                                    speaker_confidence=speaker_confidence,
                                    session_id=session_id,
                                    endpoint=endpoint_info,
                                )
                        else:
                            reply_result = self._jarvis.ask(
                                utterance,
                                speaker_name=speaker_name,
                                speaker_confidence=speaker_confidence,
                                session_id=session_id,
                                endpoint=endpoint_info,
                            )
                    except Exception as err:
                        if is_browser_voice_client_disconnected(err):
                            raise BrowserVoiceClientDisconnected("browser voice client disconnected") from err
                        failure = JarvisFailureMetadata(
                            code=classify_jarvis_transport_error(err.__cause__ if isinstance(err.__cause__, Exception) else err),
                            summary=" ".join(str(err or "").split()).strip(),
                        )
                        self._log_voice_event(
                            "jarvis_http_error",
                            utterance=self._event_text(utterance),
                            latency_ms=int(round((time.monotonic() - request_started) * 1000)),
                            error_code=failure.code,
                            error_summary=failure.summary or None,
                        )
                        final_text = self._choose_failure_line(failure)
                        result = {
                            "ok": True,
                            "status": "failure_fallback",
                            "client_id": client_id,
                            "heard_text": utterance,
                            "reply_text": final_text,
                            "model_used": False,
                            "session_id": session_id,
                            "end_session": False,
                            "error_code": failure.code,
                            "audio_clips": [],
                        }
                        if callable(stream_writer):
                            emit_stream_audio(final_text, phase="failure_fallback")
                            self._clear_tts_phrase()
                            self._restore_active_voice_state()
                            emit_stream_meta(result)
                        else:
                            with self._speech_lock:
                                prepared = self._tts.prepare_speech(final_text, phase="failure_fallback")
                            result["audio_clips"] = [self._prepared_speech_to_browser_clip(prepared, text=final_text, phase="failure_fallback")]
                            self._mark_browser_playback_state(final_text, phase="failure_fallback", end_session=False)
                        self._log_voice_event(
                            "voice_turn_finished",
                            status="failure_fallback",
                            heard_text=self._event_text(utterance),
                            reply_text=self._event_text(final_text),
                            total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                        )
                        return result
                    self._log_voice_event(
                        "jarvis_http_reply_received",
                        utterance=self._event_text(utterance),
                        latency_ms=int(round((time.monotonic() - request_started) * 1000)),
                        reply_chars=len(reply_result.text or ""),
                        error_code=reply_result.failure.code if reply_result.failure else None,
                    )
                    voice_response = reply_result.voice_response if isinstance(reply_result.voice_response, dict) else {}
                    if not reply_result.failure and str(voice_response.get("mode") or "").strip() == "confirm_beep":
                        end_session = bool(voice_response.get("end_session", False))
                        if end_session:
                            self._drop_browser_session(client_id, reason="voice_response_end")
                        result = {
                            "ok": True,
                            "status": "confirm_beep",
                            "client_id": client_id,
                            "heard_text": utterance,
                            "reply_text": "",
                            "model_used": False,
                            "session_id": "" if end_session else session_id,
                            "end_session": end_session,
                            "music_hold": voice_response.get("music_after") == "hold",
                            # An endpoint already played the voice host's end cue for this turn: that is its beep.
                            "audio_clips": [] if self._is_endpoint_client(client_id) else [self._browser_beep_clip()],
                        }
                        self._mark_browser_playback_state("", phase="confirm_beep", end_session=end_session)
                        self._log_voice_event(
                            "voice_turn_finished",
                            status="confirm_beep",
                            heard_text=self._event_text(utterance),
                            total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                        )
                        if callable(stream_writer):
                            for clip in result["audio_clips"]:
                                emit_stream_clip(clip)
                        emit_stream_meta(result)
                        return result
                    final_text = reply_result.text
                    phase = "final_reply"
                    if reply_result.failure:
                        final_text = self._choose_failure_line(reply_result.failure, default_text=reply_result.text)
                        phase = "failure_fallback"
                    clips = []
                    end_session = bool(voice_response.get("end_session", False))
                    if end_session:
                        self._drop_browser_session(client_id, reason="voice_response_end")
                    result = {
                        "ok": True,
                        "status": phase,
                        "client_id": client_id,
                        "heard_text": utterance,
                        "reply_text": final_text,
                        "model_used": bool(reply_result.model_used) if not reply_result.failure else False,
                        "session_id": "" if end_session else session_id,
                        "end_session": end_session,
                        "music_hold": not reply_result.failure and voice_response.get("music_after") == "hold",
                        # Listen again only when he asked something, as a stock Echo does;
                        # a failure line asks them to say it again.
                        "listen_again": bool(reply_result.failure) or bool(voice_response.get("expect_speech", True)),
                        "audio_clips": clips,
                    }
                    tail_future = None
                    if not progressive_spoken:
                        tail_future = self._start_browser_tail_poll(reply_result, final_text)
                    if callable(stream_writer):
                        if not progressive_spoken:
                            emit_stream_audio(final_text, speech=reply_result.speech, phase=phase)
                            ready_tail = self._browser_tail_if_ready(
                                tail_future,
                                reply_result.tail,
                                utterance=utterance,
                            )
                            if ready_tail is not None:
                                emit_stream_audio(
                                    ready_tail.text,
                                    speech=ready_tail.speech,
                                    phase="personality_tail",
                                )
                        self._clear_tts_phrase()
                        self._restore_active_voice_state()
                        emit_stream_meta(result)
                    else:
                        with self._speech_lock:
                            prepared = self._tts.prepare_speech(final_text, speech=reply_result.speech, phase=phase)
                        clips.append(self._prepared_speech_to_browser_clip(prepared, text=final_text, phase=phase))
                        ready_tail = self._browser_tail_if_ready(
                            tail_future,
                            reply_result.tail,
                            utterance=utterance,
                        )
                        clips.extend(self._prepare_browser_tail_clips(ready_tail))
                        self._mark_browser_playback_state(final_text, phase=phase, end_session=end_session)
                    self._log_voice_event(
                        "voice_turn_finished",
                        status=phase,
                        heard_text=self._event_text(utterance),
                        reply_text=self._event_text(final_text),
                        total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                        end_session=end_session,
                    )
                    return result

    def _reject_browser_wake_candidate(
        self, client_id: str, utterance: str, turn_started: float, emit_stream_meta, *, wake_confident: bool = False
    ) -> dict:
        result = {
            "ok": True,
            "status": "not_wake",
            "client_id": client_id,
            "heard_text": "",
            "reply_text": "",
            "session_id": "",
            "end_session": False,
            "audio_clips": [],
        }
        words = len(normalize_text(utterance).split())
        # The words of a short refusal show what is being turned away (1-2 word confident
        # wakes); longer ones are room talk not meant for the assistant and stay unlogged.
        self._log_voice_event(
            "voice_turn_finished",
            status="wake_rejected",
            heard_words=words,
            wake_confident=bool(wake_confident),
            **({"heard_text": self._event_text(utterance)} if 0 < words <= WAKE_REJECTED_LOG_WORDS else {}),
            total_ms=int(round((time.monotonic() - turn_started) * 1000)),
        )
        emit_stream_meta(result)
        return result

    def _resolve_browser_wake_attached_utterance(self, utterance: str, audio_bytes: bytes, *, streamed: bool) -> str:
        phrase_variants = self._config.phrase_variants
        command, outcome = resolve_wake_attached_utterance(utterance, phrase_variants)
        second_opinion = ""
        second_outcome = ""
        if outcome == "no_wake_prefix" and streamed:
            # The attached audio always contains the wake phrase. When the
            # live stream lost it, the stream start is suspect (for example
            # "Housemate, what's" fused into "Swats"), so ask batch STT once.
            try:
                second_opinion = self._stt.transcribe_bytes(audio_bytes)
            except Exception as err:
                log(f"wake-attached batch second opinion failed: {err}")
                second_opinion = ""
            second_opinion = apply_known_transcript_corrections(second_opinion)
            second_command, second_outcome = resolve_wake_attached_utterance(second_opinion, phrase_variants)
            if second_outcome == "wake_stripped":
                command, outcome = second_command, "wake_stripped_batch"
        self._log_voice_event(
            "browser_voice_wake_prefix",
            outcome=outcome,
            heard_text=self._event_text(utterance),
            second_opinion=self._event_text(second_opinion) if second_opinion else None,
            second_outcome=second_outcome or None,
            command=self._event_text(command),
        )
        return command

    def _handle_browser_voice_turn_stream(self, body: dict, stream_writer) -> None:
        try:
            self._handle_browser_voice_turn(body, stream_writer=stream_writer)
        except Exception:
            self._clear_tts_phrase()
            self._restore_active_voice_state()
            raise

    def _handle_browser_voice_live_turn_stream(
        self,
        client_id: str,
        wake_attached: bool,
        audio_chunks,
        stream_writer,
        wake_candidate: bool = False,
        wake_confident: bool = False,
    ) -> None:
        end_of_turn = None
        live_kwargs = {}
        if self._is_endpoint_client(client_id):
            # Endpoints leave the end of a turn to the voice host, so the gateway is told what the interim
            # transcript shows: the wake phrase confirmed (a possible wake is shown from then on, not once
            # the reply is ready), and each time the words move on, which is how it lets a silent
            # follow-up go and stops a turn whose speaker has gone quiet without STT ending it.
            raw_writer = stream_writer
            interim_state = {"wake": False, "last": ""}

            def endpoint_interim(transcript: str) -> None:
                text = " ".join(str(transcript or "").split())
                if not text or text == interim_state["last"]:
                    return
                interim_state["last"] = text
                outcome = ""
                if wake_candidate:
                    _command, outcome = resolve_wake_attached_utterance(text, self._config.phrase_variants)
                    if not interim_state["wake"] and outcome in {"wake_stripped", "wake_only"}:
                        interim_state["wake"] = True
                        raw_writer({"event": "wake_heard"})
                # wake_only: nothing said past "Hey Housemate" yet, so the gateway's wake pause may run.
                raw_writer({"event": "speech_progress", "wake_only": outcome == "wake_only"})

            live_kwargs["interim_callback"] = endpoint_interim
        # Whoever this session is speaking with, if they have their own end-of-turn threshold.
        own_threshold = self._speaker_eot_threshold(client_id)
        if own_threshold is not None:
            live_kwargs["eot_threshold"] = own_threshold
        if getattr(self._stt, "live_end_of_turn", False):
            end_of_turn = LiveEndOfTurnSignal(
                stream_writer,
                wake_attached=wake_attached,
                phrase_variants=self._config.phrase_variants,
            )
            live_session = self._stt.start_live_session(end_of_turn_callback=end_of_turn, **live_kwargs)
            if live_session is not None:
                end_of_turn.announce()
            stream_writer = end_of_turn.writer
        else:
            live_session = self._stt.start_live_session(**({"eot_threshold": own_threshold} if own_threshold is not None else {}))
        if live_session is None:
            raise RuntimeError("configured STT backend does not support live streaming")
        audio = bytearray()
        pending_sample_bytes = b""
        wake_speaker_started = False
        endpoint_wake_speaker = None
        endpoint_client = self._is_endpoint_client(client_id)
        try:
            for chunk in audio_chunks:
                payload = pending_sample_bytes + bytes(chunk or b"")
                if not payload:
                    continue
                aligned_length = len(payload) - (len(payload) % SAMPLE_WIDTH)
                pending_sample_bytes = payload[aligned_length:]
                payload = payload[:aligned_length]
                if not payload:
                    continue
                # A possible wake must not open a browser session before the
                # voice host confirms the wake phrase.
                if wake_attached and not wake_candidate and not wake_speaker_started:
                    self._start_browser_stream_wake_speaker(client_id, payload)
                    wake_speaker_started = True
                audio.extend(payload)
                live_session.feed_audio(payload)
                # Identify on the wake word and the start of the request as soon as they are here. The
                # result only counts once the voice host has confirmed the wake (see the turn handler).
                if (
                    endpoint_client
                    and wake_attached
                    and endpoint_wake_speaker is None
                    and len(audio) >= ENDPOINT_WAKE_SPEAKER_BYTES
                ):
                    endpoint_wake_speaker = self._start_endpoint_wake_speaker(
                        client_id, bytes(audio[ENDPOINT_WAKE_SPEAKER_FROM:ENDPOINT_WAKE_SPEAKER_BYTES])
                    ) or False
            # A short request ("Hey Housemate, stop") ends sooner: identify on what there is.
            if (
                endpoint_client
                and wake_attached
                and endpoint_wake_speaker is None
                and len(audio) > ENDPOINT_WAKE_SPEAKER_FROM
            ):
                endpoint_wake_speaker = self._start_endpoint_wake_speaker(
                    client_id, bytes(audio[ENDPOINT_WAKE_SPEAKER_FROM:])
                ) or False
            if end_of_turn is not None:
                end_of_turn.upload_finished()
            if pending_sample_bytes:
                raise ValueError("live PCM stream is not sample-aligned")
            if not audio:
                raise ValueError("live audio stream was empty")
            self._handle_browser_voice_turn(
                {
                    "client_id": client_id,
                    "wake_attached": bool(wake_attached),
                    **({"wake_candidate": True} if wake_candidate else {}),
                    **({"wake_confident": True} if wake_confident else {}),
                    **({"endpoint_wake_speaker_future": endpoint_wake_speaker} if endpoint_wake_speaker else {}),
                },
                stream_writer=stream_writer,
                audio_bytes_override=bytes(audio),
                stt_live_session=live_session,
            )
        except Exception:
            with contextlib.suppress(Exception):
                live_session.close()
            self._clear_tts_phrase()
            self._restore_active_voice_state()
            raise

    def _endpoint_wake_greeting(self, client_id, wake_speaker, turn_started, emit_stream_meta, emit_stream_clip) -> dict:
        """A bare "Hey Housemate" from an endpoint, then quiet: acknowledge it ("Mm-hm?"), open the
        session, and ask the endpoint to keep listening (no greeting; the gateway
        only ends the turn after its wake pause). Called with the browser turn lock held, so it does
        not use the prompt helper (which takes that lock itself)."""
        session = self._browser_session_for_client(client_id, create=True)
        if wake_speaker is not None and session is not None and not session.speaker_name:
            with contextlib.suppress(Exception):
                matched, score = wake_speaker.result(timeout=ENDPOINT_TURN_SPEAKER_WAIT_S)
                self._accept_browser_speaker_result(
                    client_id, session.session_id, "browser_wake", matched, score, lock_held=True
                )
        speaker = (session.speaker_name if session is not None else "") or UNKNOWN_SPEAKER
        cached = [line for line in WAKE_ACKS if self._wake_greeting_cached(line)]
        spoken = random.choice(cached or WAKE_ACKS)
        clips = []
        with self._speech_lock:
            prepared = self._prepare_wake_greeting_speech(spoken)
        if prepared is not None:
            clips.append(self._prepared_speech_to_browser_clip(prepared, text=spoken, phase="wake_greeting"))
            self._mark_browser_playback_state(spoken, phase="wake_greeting", end_session=False)
        result = {
            "ok": True,
            "status": "wake_ack" if clips else "no_input",
            "client_id": client_id,
            "heard_text": "",
            "reply_text": spoken if clips else "",
            "session_id": session.session_id if session is not None else "",
            "end_session": False,
            "audio_clips": clips,
        }
        self._log_voice_event(
            "voice_turn_finished",
            status=result["status"],
            greeting_speaker=speaker,
            reply_text=self._event_text(result["reply_text"]),
            total_ms=int(round((time.monotonic() - turn_started) * 1000)),
        )
        for clip in clips:
            emit_stream_clip(clip)
        emit_stream_meta(result)
        return result

    def _start_endpoint_wake_speaker(self, client_id: str, wake_audio: bytes):
        speaker_identifier = getattr(self, "_speaker_id", None)
        if speaker_identifier is None or not speaker_identifier.can_identify():
            return None
        future = self._speaker_executor.submit(speaker_identifier.identify, wake_audio, "wake_endpoint")
        self._log_voice_event(
            "endpoint_wake_speaker_started",
            client_id=self._normalize_browser_client_id(client_id),
            wake_audio_ms=int(round(len(wake_audio) * 1000 / float(SAMPLE_RATE * SAMPLE_WIDTH))),
        )
        return future

    def _start_browser_stream_wake_speaker(self, client_id: str, wake_audio: bytes) -> None:
        speaker_identifier = getattr(self, "_speaker_id", None)
        if speaker_identifier is None or not speaker_identifier.can_identify():
            return
        payload = self._prepare_wake_speaker_audio(wake_audio)
        if not payload:
            return
        with self._browser_turn_lock:
            session = self._browser_session_for_client(client_id, create=True)
            if session is None or session.wake_speaker_future is not None:
                return
            future = self._speaker_executor.submit(
                speaker_identifier.identify,
                payload,
                "wake_browser_stream",
            )
            session.wake_speaker_future = future
            session_id = session.session_id
        future.add_done_callback(
            lambda completed: self._accept_browser_speaker_future(
                client_id,
                session_id,
                "browser_wake_stream",
                completed,
            )
        )
        self._log_voice_event(
            "browser_voice_wake_speaker_started",
            client_id=self._normalize_browser_client_id(client_id),
            session_id=session_id,
            wake_audio_ms=int(round(len(payload) * 1000 / float(SAMPLE_RATE * SAMPLE_WIDTH))),
        )

    def _estimate_wake_phrase_end_lag_ms(self, recent_audio: bytes) -> int | None:
        return estimate_trailing_non_speech_ms(recent_audio, vad_mode=self._config.vad_mode)

    def _estimate_wake_phrase_start_lag_ms(self, recent_audio: bytes) -> int | None:
        return estimate_wake_phrase_start_lag_ms(recent_audio, vad_mode=self._config.vad_mode)

    def _play_wake_greeting_tick_once(self, source: str = "") -> int:
        if not getattr(self._config, "wake_greeting_ticker_enabled", False):
            return 0
        with self._speech_lock:
            tick_ms = self._beep_and_measure_ms(
                duration_ms=WAKE_GREETING_TICK_DURATION_MS,
                frequency_hz=WAKE_GREETING_TICK_FREQUENCY_HZ,
                amplitude=WAKE_GREETING_TICK_AMPLITUDE,
            )
        self._log_voice_event(
            "wake_greeting_tick",
            source=str(source or "").strip() or None,
            latency_ms=tick_ms,
        )
        return tick_ms

    def _play_wake_ack_clip_once(self, audio: AudioInput | None = None) -> int:
        clip_path = str(getattr(self._config, "wake_ack_clip_path", "") or "").strip()
        clip_speed = float(getattr(self._config, "wake_ack_clip_speed", DEFAULT_WAKE_ACK_CLIP_SPEED) or DEFAULT_WAKE_ACK_CLIP_SPEED)
        clip_volume = float(getattr(self._config, "wake_ack_clip_volume", DEFAULT_WAKE_ACK_CLIP_VOLUME))
        if not clip_path:
            return 0
        started = time.monotonic()
        self._log_voice_event(
            "wake_ack_started",
            speaker_guess=self._speaker_snapshot() or None,
            clip_path=clip_path,
            clip_speed=clip_speed,
            clip_volume=clip_volume,
        )
        played = False
        error = None
        try:
            with self._speech_lock:
                played = self._run_with_mic_suppressed(audio, lambda: self._voice_clips.play_local_clip(clip_path, speed=clip_speed, volume=clip_volume))
        except Exception as err:
            error = str(err)
            log(f"wake ack clip failed: {err}")
        played_ms = int(round((time.monotonic() - started) * 1000)) if played else 0
        self._log_voice_event(
            "wake_ack_finished",
            speaker_guess=self._speaker_snapshot() or None,
            clip_path=clip_path,
            clip_speed=clip_speed,
            clip_volume=clip_volume,
            played=played,
            latency_ms=played_ms if played else None,
            error=error,
        )
        return played_ms

    def _start_wake_ack_clip(self, audio: AudioInput | None = None) -> bool:
        clip_path = str(getattr(self._config, "wake_ack_clip_path", "") or "").strip()
        if not clip_path:
            return False
        self._pending_wake_ack = self._wake_audio_executor.submit(self._play_wake_ack_clip_once, audio)
        return True

    def _wait_pending_wake_ack(self) -> int:
        future = getattr(self, "_pending_wake_ack", None)
        if not future:
            return 0
        self._pending_wake_ack = None
        try:
            return int(future.result() or 0)
        except Exception as err:
            log(f"wake ack wait failed: {err}")
            return 0

    def _play_wake_greeting_ticker(self, prompt_deadline: float | None) -> None:
        if not getattr(self._config, "wake_greeting_ticker_enabled", False):
            return
        if prompt_deadline is None:
            return
        while True:
            remaining_seconds = max(0.0, float(prompt_deadline) - time.monotonic())
            if remaining_seconds <= 0.0:
                return
            self._play_wake_greeting_tick_once(source="wake_prompt_wait")
            sleep_seconds = min(WAKE_GREETING_TICK_INTERVAL_SECONDS, max(0.0, float(prompt_deadline) - time.monotonic()))
            if sleep_seconds > 0.0:
                time.sleep(sleep_seconds)

    def _wait_for_wake_prompt_speaker(self, prompt_deadline: float | None, speaker: str) -> str:
        current = str(speaker or "").strip() or DEFAULT_GREETING_SPEAKER
        default_speaker = str(self._config.default_greeting_speaker or DEFAULT_GREETING_SPEAKER).strip() or DEFAULT_GREETING_SPEAKER
        if current != default_speaker:
            return current if current in known_wake_speakers() else UNKNOWN_SPEAKER
        if prompt_deadline is None:
            current = self._apply_pending_wake_speaker(timeout_seconds=WAKE_SPEAKER_GRACE_SECONDS)
            return current if current in known_wake_speakers() else UNKNOWN_SPEAKER
        ticker_enabled = bool(getattr(self._config, "wake_greeting_ticker_enabled", False))
        while True:
            remaining_seconds = max(0.0, float(prompt_deadline) - time.monotonic())
            if remaining_seconds <= 0.0:
                break
            wait_slice = min(0.05 if ticker_enabled else remaining_seconds, remaining_seconds)
            current = self._apply_pending_wake_speaker(timeout_seconds=wait_slice)
            if current in known_wake_speakers():
                return current
            if ticker_enabled:
                self._play_wake_greeting_ticker(time.monotonic() + min(WAKE_GREETING_TICK_INTERVAL_SECONDS, remaining_seconds))
        current = self._apply_pending_wake_speaker(timeout_seconds=0.0)
        if current in known_wake_speakers():
            return current
        self._cancel_pending_speaker_job("_pending_wake_speaker")
        self._log_voice_event(
            "wake_speaker_resolved_unknown",
            speaker_guess=self._speaker_snapshot() or None,
            timeout_ms=int(round(WAKE_PROMPT_MIN_DELAY_SECONDS * 1000)),
        )
        return UNKNOWN_SPEAKER

    def _handle_remote_tts_request(self, text: str, speech: dict | None = None) -> None:
        spoken = " ".join(str(text or "").split()).strip()
        if not spoken:
            raise ValueError("text required")
        started = time.monotonic()
        self._set_voice_state("processing")
        self._log_voice_event(
            "remote_tts_started",
            utterance=spoken,
            voice_name=str((speech or {}).get("voice_name") or "").strip() or None,
            voice_id=str((speech or {}).get("voice_id") or "").strip() or None,
        )
        self._set_voice_state("speaking")
        try:
            self._publish_tts_phrase(spoken, phase="remote_tts")
            with self._speech_lock:
                self._tts.speak(spoken, speech=speech, phase="remote_tts")
            self._log_voice_event(
                "remote_tts_finished",
                utterance=spoken,
                voice_name=str((speech or {}).get("voice_name") or "").strip() or None,
                voice_id=str((speech or {}).get("voice_id") or "").strip() or None,
                latency_ms=int(round((time.monotonic() - started) * 1000)),
            )
        finally:
            self._clear_tts_phrase()
            self._restore_active_voice_state()

    def _choose_failure_line(self, failure: JarvisFailureMetadata | None = None, default_text: str = "") -> str:
        code = str(failure.code if failure else "").strip() or "jarvis_http_error"
        options = {
            "codex_usage_limit": [
                "My model path is out of usage right now. I can still handle direct house checks and commands.",
                "I am out of model usage right now, but direct house checks and commands still work.",
            ],
            "codex_auth": [
                "My model path needs signing in again. I can still handle direct house checks and commands.",
                "I need my model path signed in again, but direct house checks and commands still work.",
            ],
            "codex_unavailable": [
                "My model path is not answering right now. I can still handle direct house checks and commands.",
                "The model path is not answering right now, but direct house checks and commands still work.",
            ],
            "model_unavailable": [
                "The model path is down right now. I can still handle direct house checks and commands.",
                "My model path is down right now, but direct house checks and commands still work.",
            ],
            "brain_path_down": [
                "My brain is out of reach right now. Give me a minute.",
                "I can hear you, but my brain is out of reach right now.",
            ],
            "jarvis_http_error": [
                "I hit a problem talking to my brain.",
                "My brain path answered badly just then.",
            ],
        }
        candidates = options.get(code) or options["jarvis_http_error"]
        chosen = candidates[0]
        if chosen == self._last_failure_line and len(candidates) > 1:
            chosen = candidates[1]
        elif default_text and code not in options and default_text != self._last_failure_line:
            chosen = default_text
        self._last_failure_line = chosen
        return chosen

    def stop(self, *_args) -> None:
        log("stop requested")
        self._running = False
        self._set_voice_state("idle")
        self._cancel_pending_speaker_job("_pending_wake_speaker")
        self._cancel_pending_speaker_job("_pending_session_speaker")
        self._cancel_all_tail_polls()
        self._speaker_executor.shutdown(wait=False, cancel_futures=True)
        self._wake_audio_executor.shutdown(wait=False, cancel_futures=True)
        self._browser_wake_executor.shutdown(wait=False, cancel_futures=True)
        self._jarvis_executor.shutdown(wait=False, cancel_futures=True)
        self._tail_prepare_executor.shutdown(wait=False, cancel_futures=True)
        for tts in (self._tts, self._tail_prepare_tts):
            close_tts = getattr(tts, "close", None)
            if callable(close_tts):
                close_tts()

    def _reset_speaker_session(self) -> None:
        self._cancel_pending_speaker_job("_pending_wake_speaker")
        self._cancel_pending_speaker_job("_pending_session_speaker")
        self._speaker_identity.reset()

    def run(self) -> int:
        state = "idle"
        log("voice loop starting")
        self._log_voice_event("voice_loop_started")
        self._ha_state_publisher.start()
        self._restore_active_voice_state()
        if self._remote_tts_server:
            self._remote_tts_server.start()
        if self._browser_voice_server:
            self._browser_voice_server.start()
        endpoint_gateway = getattr(self, "_endpoint_gateway", None)
        if endpoint_gateway:
            endpoint_gateway.start()
        assist_servers = getattr(self, "_assist_servers", [])
        for server in assist_servers:
            server.start()
        self._start_wake_greeting_cache_warmup()
        if not self._config.local_voice_enabled:
            log("local microphone loop disabled; browser voice bridge remains active")
            self._log_voice_event("local_voice_disabled")
            try:
                while self._running:
                    time.sleep(0.2)
            finally:
                for server in assist_servers:
                    server.stop()
                if endpoint_gateway:
                    endpoint_gateway.stop()
                if self._browser_voice_server:
                    self._browser_voice_server.stop()
                if self._remote_tts_server:
                    self._remote_tts_server.stop()
                self._ha_state_publisher.stop()
            log("voice loop stopped")
            self._log_voice_event("voice_loop_stopped")
            return 0
        try:
            with AudioInput(
                self._config.input_device,
                self._config.audio_settle_ms,
                filter_chain=self._noise_filter_chain,
                self_voice_rejector=self._self_voice_rejector,
            ) as audio:
                while self._running:
                    try:
                        if state == "idle":
                            wake_result = self._wait_for_wake(audio)
                            if wake_result and wake_result.get("event") == "wake":
                                wake_detected_at = time.monotonic()
                                wake_recent_audio = wake_result.get("recent_audio", b"")
                                wake_phrase_end_lag_ms = self._estimate_wake_phrase_end_lag_ms(wake_recent_audio)
                                wake_phrase_start_lag_ms = self._estimate_wake_phrase_start_lag_ms(wake_recent_audio)
                                log("wake phrase detected")
                                self._start_voice_session()
                                self._reset_speaker_session()
                                self._log_voice_event(
                                    "wake_detected",
                                    speaker_guess=self._speaker_snapshot() or None,
                                    wake_recent_audio_ms=int(round(len(wake_recent_audio) * 1000 / float(SAMPLE_RATE * SAMPLE_WIDTH))) if wake_recent_audio else None,
                                    wake_phrase_start_lag_ms=wake_phrase_start_lag_ms,
                                    wake_phrase_end_lag_ms=wake_phrase_end_lag_ms,
                                )
                                self._start_async_wake_speaker(wake_recent_audio)
                                wake_ack_started = self._start_wake_ack_clip(audio)
                                if not wake_ack_started:
                                    self._play_wake_greeting_tick_once(source="wake_detected")
                                continuation_state = self._handle_wake_continuation(audio, wake_recent_audio)
                                if continuation_state:
                                    state = continuation_state
                                    continue
                                log("wake detected; prompting for command")
                                self._apply_pending_speaker_updates()
                                self._play_wake_prompt(
                                    audio,
                                    speaker=self._speaker_identity.active_name(),
                                    wake_detected_at=wake_detected_at,
                                    wake_phrase_start_lag_ms=wake_phrase_start_lag_ms,
                                    wake_phrase_end_lag_ms=wake_phrase_end_lag_ms,
                                )
                                state = "session_prompted"
                                continue
                            continue
                            continue

                        session_result = self._handle_session_turn(
                            audio,
                            prompt_on_empty=state == "session_prompted",
                            speaker_source="session_turn",
                        )
                        if session_result == "idle":
                            self._end_voice_session(reason="idle")
                            self._reset_speaker_session()
                            state = "idle"
                        elif session_result == "greet":
                            self._apply_pending_speaker_updates()
                            self._play_wake_prompt(audio, speaker=self._speaker_identity.active_name())
                            state = "session_prompted"
                        else:
                            state = "session"
                    except EOFError:
                        log("audio stream ended unexpectedly; restarting capture")
                        audio.restart()
                        if state == "session":
                            log("restored capture during active session")
                        time.sleep(0.2)
                        continue
        finally:
            for server in assist_servers:
                server.stop()
            if endpoint_gateway:
                endpoint_gateway.stop()
            if self._browser_voice_server:
                self._browser_voice_server.stop()
            if self._remote_tts_server:
                self._remote_tts_server.stop()
            self._ha_state_publisher.stop()

        log("voice loop stopped")
        self._log_voice_event("voice_loop_stopped")
        return 0

    def _observe_speaker_identity(self, source: str, audio_bytes: bytes) -> str:
        speaker, score = self._speaker_id.identify(audio_bytes, source=source)
        if speaker:
            log(f"identified speaker from {source}: {speaker} score={score:.3f}")
        elif score > 0.0:
            log(f"speaker confidence below threshold from {source}: score={score:.3f}")
        active = self._speaker_identity.observe(source, speaker, score)
        if speaker:
            self._record_identified_speaker(active)
        return active

    def _cancel_pending_speaker_job(self, attr_name: str) -> None:
        pending = getattr(self, attr_name, None)
        if not pending:
            return
        _source, future, _started_at, _audio_seconds = pending
        future.cancel()
        setattr(self, attr_name, None)

    def _start_async_speaker_identity(self, attr_name: str, source: str, audio_bytes: bytes) -> None:
        self._cancel_pending_speaker_job(attr_name)
        payload = bytes(audio_bytes or b"")
        if not payload:
            return
        started_at = time.monotonic()
        audio_seconds = round(len(payload) / float(SAMPLE_RATE * SAMPLE_WIDTH), 3)
        self._log_voice_event(
            "speaker_guess_started",
            source=source,
            speaker_guess=self._speaker_snapshot() or None,
            audio_seconds=audio_seconds,
        )
        future = self._speaker_executor.submit(self._speaker_id.identify, payload, source)
        setattr(self, attr_name, (str(source or "unknown").strip() or "unknown", future, started_at, audio_seconds))

    def _apply_pending_speaker_identity(self, attr_name: str, timeout_seconds: float = 0.0) -> str:
        pending = getattr(self, attr_name, None)
        if not pending:
            return self._speaker_identity.active_name()
        source, future, started_at, audio_seconds = pending
        try:
            if timeout_seconds > 0.0:
                speaker, score = future.result(timeout=max(0.0, float(timeout_seconds)))
            elif future.done():
                speaker, score = future.result()
            else:
                return self._speaker_identity.active_name()
        except FutureTimeoutError:
            return self._speaker_identity.active_name()
        except Exception as err:
            setattr(self, attr_name, None)
            log(f"async speaker identification failed from {source}: {err}")
            self._log_voice_event(
                "speaker_guess_finished",
                source=source,
                speaker_guess=self._speaker_snapshot() or None,
                audio_seconds=audio_seconds,
                latency_ms=int(round((time.monotonic() - started_at) * 1000)),
                error=str(err),
            )
            return self._speaker_identity.active_name()
        setattr(self, attr_name, None)
        if speaker:
            log(f"identified speaker from {source}: {speaker} score={score:.3f}")
        elif score > 0.0:
            log(f"speaker confidence below threshold from {source}: score={score:.3f}")
        active = self._speaker_identity.observe(source, speaker, score)
        if speaker:
            self._record_identified_speaker(active)
        self._log_voice_event(
            "speaker_guess_finished",
            source=source,
            speaker_guess=active or None,
            matched_speaker=speaker or None,
            confidence=round(score, 3) if score > 0.0 else None,
            audio_seconds=audio_seconds,
            latency_ms=int(round((time.monotonic() - started_at) * 1000)),
        )
        return active

    def _apply_pending_speaker_updates(self) -> str:
        self._apply_pending_speaker_identity("_pending_wake_speaker")
        return self._apply_pending_speaker_identity("_pending_session_speaker")

    def _start_async_wake_speaker(self, audio_bytes: bytes) -> None:
        payload = self._prepare_wake_speaker_audio(audio_bytes)
        self._start_async_speaker_identity("_pending_wake_speaker", "wake_async", payload)

    def _apply_pending_wake_speaker(self, timeout_seconds: float = 0.0) -> str:
        return self._apply_pending_speaker_identity("_pending_wake_speaker", timeout_seconds=timeout_seconds)

    def _start_async_session_speaker(self, source: str, audio_bytes: bytes) -> None:
        self._start_async_speaker_identity("_pending_session_speaker", source, audio_bytes)

    def _prepare_wake_speaker_audio(self, audio_bytes: bytes) -> bytes:
        payload = bytes(audio_bytes or b"")
        if not payload:
            return b""
        trimmed = trim_audio_tail(payload, self._config.wake_follow_seconds)
        if len(trimmed) >= self._speaker_id._min_bytes:
            return trimmed
        return payload

    def _handle_session_turn(
        self,
        audio: AudioInput,
        seeded_audio: bytes = b"",
        prompt_on_empty: bool = False,
        strip_leading_wake: bool = False,
        speaker_source: str = "session_turn",
        speaker_audio: bytes = b"",
        stt_live_session=None,
    ) -> str:
        capture_event = None
        live_session = stt_live_session
        if seeded_audio:
            audio_bytes = seeded_audio
        else:
            if live_session is None:
                with contextlib.suppress(Exception):
                    live_session = self._stt.start_live_session()
            audio_bytes, capture_event = self._active_turn_capture().capture(
                audio,
                event_spotter=self._kill_spotter,
                stop_events=("kill",),
                frame_observer=live_session.feed_audio if live_session is not None else None,
            )
        if capture_event == "kill":
            with contextlib.suppress(Exception):
                if live_session is not None:
                    live_session.close()
            log("fast local kill detected during active session turn")
            self._handle_kill(audio, source="capture")
            return "idle"
        if not audio_bytes:
            with contextlib.suppress(Exception):
                if live_session is not None:
                    live_session.close()
            self._spotter.reset()
            if prompt_on_empty:
                return "greet"
            return "idle"
        turn_id = self._build_turn_id("voice-turn")
        turn_started = time.monotonic()
        with self._voice_event_context(
            turn_id=turn_id,
            transport="voice_loop",
            source=speaker_source,
            session_id=str(getattr(self, "_active_session_id", "") or "").strip() or None,
        ):
            self._log_voice_event(
                "voice_turn_started",
                mode="voice_loop",
                wake_attached=bool(strip_leading_wake),
                prompt_on_empty=bool(prompt_on_empty),
                audio_seconds=round(len(audio_bytes) / float(SAMPLE_RATE * SAMPLE_WIDTH), 3),
            )
            self._apply_pending_speaker_updates()
            self._start_async_session_speaker(speaker_source, speaker_audio or audio_bytes)
            turn_complete_at = time.monotonic()
            self._signal_listening_complete(audio)
            stt_started = time.monotonic()
            self._log_voice_event(
                "stt_started",
                speaker_guess=self._speaker_snapshot() or None,
                audio_seconds=round(len(audio_bytes) / float(SAMPLE_RATE * SAMPLE_WIDTH), 3),
                source=speaker_source,
            )
            utterance = self._stt.transcribe_bytes(audio_bytes, live_session=live_session)
            self._log_voice_event(
                "stt_finished",
                speaker_guess=self._speaker_snapshot() or None,
                source=speaker_source,
                utterance=self._event_text(utterance),
                latency_ms=int(round((time.monotonic() - stt_started) * 1000)),
            )
            self._apply_pending_speaker_updates()
            if not utterance:
                log("stt produced empty utterance")
                result = "greet" if prompt_on_empty else "continue"
                if prompt_on_empty:
                    log("empty first post-wake utterance; prompting for command")
                self._log_voice_event(
                    "voice_turn_finished",
                    status="empty_transcript",
                    next_state=result,
                    total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                )
                return result
            corrected = apply_known_transcript_corrections(utterance)
            if corrected != utterance:
                log(f"corrected transcript: {utterance} -> {corrected}")
                utterance = corrected
            if strip_leading_wake:
                stripped = strip_leading_wake_phrase(utterance, self._config.phrase_variants)
                if stripped:
                    log(f"stripped wake phrase from first spoken turn: {stripped}")
                    utterance = stripped
            if prompt_on_empty and should_ignore_short_first_post_wake_goodbye(utterance, audio_bytes, self._config.phrase_variants):
                log("ignoring short first post-wake goodbye-like utterance; prompting again")
                self._log_voice_event(
                    "voice_turn_finished",
                    status="ignored_short_goodbye",
                    heard_text=self._event_text(utterance),
                    next_state="greet",
                    total_ms=int(round((time.monotonic() - turn_started) * 1000)),
                )
                return "greet"
            result = self._handle_utterance(
                audio,
                utterance,
                turn_complete_at=turn_complete_at,
                wake_attached=strip_leading_wake,
            )
            self._log_voice_event(
                "voice_turn_finished",
                status=result,
                heard_text=self._event_text(utterance),
                total_ms=int(round((time.monotonic() - turn_started) * 1000)),
            )
            return result

    def _beep_and_measure_ms(
        self,
        duration_ms: int = BEEP_DURATION_MS,
        frequency_hz: int = BEEP_FREQUENCY_HZ,
        amplitude: float = BEEP_AMPLITUDE,
        audio: AudioInput | None = None,
    ) -> int:
        started = time.monotonic()
        self._run_with_mic_suppressed(
            audio,
            lambda: self._tts.beep(
                duration_ms=duration_ms,
                frequency_hz=frequency_hz,
                amplitude=amplitude,
            ),
        )
        return int(round((time.monotonic() - started) * 1000))

    def _signal_listening_complete(self, audio: AudioInput) -> None:
        self._set_voice_state("processing")
        played_ms = self._beep_and_measure_ms(audio=audio)
        self._suppress_playback_tail(audio, played_ms=played_ms)

    def _complete_jarvis_turn(self, audio: AudioInput, cue_next_turn: bool = True, played_ms: int = 0) -> None:
        beep_ms = 0
        if cue_next_turn:
            beep_ms = self._beep_and_measure_ms(audio=audio)
        self._suppress_playback_tail(audio, played_ms=played_ms + beep_ms)

    def _playback_mic_mode(self) -> str:
        return normalize_playback_mic_mode(getattr(self._config, "playback_mic_mode", "suppress"))

    def _run_with_mic_suppressed(self, audio: AudioInput | None, callback):
        if audio is not None and self._playback_mic_mode() == "suppress":
            audio.begin_playback_suppression()
        try:
            return callback()
        finally:
            if audio is not None and self._playback_mic_mode() == "suppress":
                audio.end_playback_suppression()

    def _suppress_playback_tail(self, audio: AudioInput | None, played_ms: int = 0) -> None:
        if audio is None:
            return
        if self._playback_mic_mode() != "suppress":
            return
        pending_frames = audio.discard_pending_ms(max(0, int(played_ms)))
        tail_frames = max(0, int(round(max(0.0, float(self._config.post_tts_flush_ms)) / FRAME_MS)))
        if tail_frames > 0:
            audio.begin_playback_suppression()
            try:
                audio.discard_ms(self._config.post_tts_flush_ms)
            finally:
                audio.end_playback_suppression()
        drained = pending_frames + tail_frames
        if drained > 0:
            self._log_voice_event(
                "playback_audio_discarded",
                speaker_guess=self._speaker_snapshot() or None,
                frames=drained,
                playback_ms=max(0, int(played_ms)),
            )
        audio.restart()

    def _handle_utterance(
        self,
        audio: AudioInput,
        utterance: str,
        turn_complete_at: float | None = None,
        wake_attached: bool = False,
    ) -> str:
        if text_matches_prompt_line(utterance, self._recent_prompt_lines):
            log(f"ignoring self-heard prompt text: {utterance}")
            self._recent_prompt_lines = []
            return "continue"
        self._recent_prompt_lines = []
        if is_wake_only_text(utterance, self._config.phrase_variants):
            log("wake-only utterance detected; prompting for command")
            return "greet"
        log(f"user said: {utterance}")

        if self._matches_kill_phrase(utterance):
            self._handle_kill(audio, source="stt")
            return "idle"

        try:
            reply_result = self._ask_jarvis_progressive_or_legacy(
                audio,
                utterance,
                speaker_name=self._speaker_identity.name,
                speaker_confidence=self._speaker_identity.score,
                turn_complete_at=turn_complete_at,
            )
        except Exception as err:
            log(f"brain request failed: {err}")
            self._apply_pending_speaker_updates()
            failure = JarvisFailureMetadata(
                code=classify_jarvis_transport_error(err.__cause__ if isinstance(err.__cause__, Exception) else err),
                summary=" ".join(str(err or "").split()).strip(),
            )
            self._log_voice_event(
                "jarvis_http_error",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                error_code=failure.code or None,
                error_summary=failure.summary or None,
            )
            fallback = self._choose_failure_line(failure)
            self._speak_final(audio, fallback, phase="failure_fallback")
            self._complete_jarvis_turn(audio)
            return "continue"
        self._apply_pending_speaker_updates()
        voice_response = reply_result.voice_response if isinstance(reply_result.voice_response, dict) else {}
        if not reply_result.failure and str(voice_response.get("mode") or "").strip() == "confirm_beep":
            requested_end_session = bool(voice_response.get("end_session", False))
            end_session = requested_end_session and bool(wake_attached)
            self._log_voice_event(
                "voice_response_confirm_beep",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                kind=str(voice_response.get("kind") or "").strip() or None,
                end_session=end_session,
                requested_end_session=requested_end_session,
                wake_attached=bool(wake_attached),
            )
            self._set_voice_state("idle" if end_session else "listening")
            self._complete_jarvis_turn(audio, cue_next_turn=not end_session)
            return "idle" if end_session else "continue"
        final_text = reply_result.text
        if reply_result.failure:
            final_text = self._choose_failure_line(reply_result.failure, default_text=reply_result.text)
            self._log_voice_event(
                "jarvis_http_error",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                error_code=reply_result.failure.code or None,
                error_summary=reply_result.failure.summary or None,
            )
        log(f"brain replied: {final_text}")
        if reply_result.progressive_spoken:
            end_session = bool(voice_response.get("end_session", False))
            if end_session:
                self._set_voice_state("idle")
            self._complete_jarvis_turn(
                audio,
                cue_next_turn=not end_session,
                played_ms=reply_result.progressive_played_ms,
            )
            return "idle" if end_session else "continue"
        tail_timeout = personality_tail_poll_timeout_for_text(final_text)
        tail_future = None if reply_result.failure else self._start_personality_tail_poll(reply_result, timeout_seconds=tail_timeout)
        tail_prepare_future = self._start_personality_tail_prepare(tail_future)
        played_ms = self._speak_final(
            audio,
            final_text,
            phase="failure_fallback" if reply_result.failure else "final_reply",
            speech=reply_result.speech,
        )
        tail_played_ms = self._speak_personality_tail_if_ready(
            audio,
            tail_future,
            tail_prepare_future=tail_prepare_future,
            utterance=utterance,
        )
        end_session = bool(voice_response.get("end_session", False))
        if end_session:
            self._set_voice_state("idle")
        self._complete_jarvis_turn(audio, cue_next_turn=not end_session, played_ms=played_ms + tail_played_ms)
        return "idle" if end_session else "continue"

    def _start_personality_tail_poll(self, reply: JarvisReply, timeout_seconds: float | None = None):
        if not isinstance(reply.tail, dict):
            return None
        status = str(reply.tail.get("status") or "").strip().lower()
        poll_path = str(reply.tail.get("poll_path") or reply.tail.get("poll_url") or reply.tail.get("url") or "").strip()
        if not poll_path and status != "ready":
            return None
        self._log_voice_event(
            "personality_tail_poll_started",
            speaker_guess=self._speaker_snapshot() or None,
            status=status or None,
            poll_path=poll_path or None,
            timeout_ms=int(round(max(0.0, float(timeout_seconds or 0.0)) * 1000)) if timeout_seconds else None,
        )
        future = self._jarvis_executor.submit(
            self._jarvis.poll_tail,
            reply.tail,
            timeout_seconds or PERSONALITY_TAIL_MIN_POLL_TIMEOUT_SECONDS,
        )
        self._track_tail_poll_future(future, reply.tail)
        return future

    def _append_progressive_tail_if_ready(
        self,
        session: ProgressiveTtsSession,
        reply: JarvisReply,
        utterance: str = "",
    ) -> bool:
        if reply.failure or not isinstance(reply.tail, dict):
            return False
        timeout_seconds = personality_tail_poll_timeout_for_text(session.utterance or reply.text)
        tail_future = self._start_personality_tail_poll(reply, timeout_seconds=timeout_seconds)
        if tail_future is None:
            return False
        ready_before_lead_end = session.wait_for_future_before_playback_end(
            tail_future,
            timeout_seconds=timeout_seconds,
        )
        if not ready_before_lead_end:
            self._cancel_tail_poll_future(tail_future)
            self._log_voice_event(
                "personality_tail_skipped",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                reason="tail_not_ready_before_progressive_lead_finished",
            )
            return False
        try:
            tail = tail_future.result()
        except Exception as err:
            self._log_voice_event(
                "personality_tail_failed",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                error=str(err),
            )
            return False
        if not isinstance(tail, JarvisTail) or tail.status != "ready" or not tail.text:
            self._log_voice_event(
                "personality_tail_skipped",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                status=getattr(tail, "status", "") or None,
                reason=getattr(tail, "reason", "") or None,
                latency_ms=getattr(tail, "latency_ms", None),
            )
            return False
        speech = tail.speech if isinstance(tail.speech, dict) else {}
        fish_text = " ".join(str(speech.get("fish_text") or tail.text).split()).strip()
        session.append(fish_text, canonical_text=tail.text, tone=speech.get("tone") or "")
        reply.progressive_tail_spoken = True
        self._log_voice_event(
            "personality_tail_ready",
            utterance=utterance,
            speaker_guess=self._speaker_snapshot() or None,
            latency_ms=tail.latency_ms,
            reply_chars=len(tail.text),
            progressive=True,
        )
        return True

    def _start_personality_tail_prepare(self, tail_future):
        if tail_future is None:
            return None
        return self._tail_prepare_executor.submit(self._prepare_personality_tail, tail_future)

    def _prepare_personality_tail(self, tail_future) -> PreparedJarvisTail:
        tail = tail_future.result()
        if not isinstance(tail, JarvisTail):
            return PreparedJarvisTail(tail=JarvisTail(status="invalid", reason="tail_result_invalid"))
        if tail.status != "ready" or not tail.text:
            return PreparedJarvisTail(tail=tail)
        started = time.monotonic()
        self._log_voice_event(
            "personality_tail_prepare_started",
            speaker_guess=self._speaker_snapshot() or None,
            latency_ms=tail.latency_ms,
        )
        prepared = self._tail_prepare_tts.prepare_speech(tail.text, speech=tail.speech, phase="personality_tail")
        self._log_voice_event(
            "personality_tail_prepare_finished",
            speaker_guess=self._speaker_snapshot() or None,
            latency_ms=int(round((time.monotonic() - started) * 1000)),
        )
        return PreparedJarvisTail(tail=tail, prepared=prepared)

    def _discard_prepared_tail_when_ready(self, tail_prepare_future) -> None:
        if tail_prepare_future is None:
            return

        def cleanup(future) -> None:
            try:
                prepared_tail = future.result()
            except Exception:
                return
            prepared = prepared_tail.prepared if isinstance(prepared_tail, PreparedJarvisTail) else None
            if not isinstance(prepared, PreparedSpeech):
                return
            with contextlib.suppress(FileNotFoundError):
                os.unlink(prepared.path)

        tail_prepare_future.add_done_callback(cleanup)

    def _speak_personality_tail_if_ready(
        self,
        audio: AudioInput,
        tail_future,
        tail_prepare_future=None,
        utterance: str = "",
    ) -> int:
        if tail_future is None:
            return 0
        try:
            tail = tail_future.result(timeout=PERSONALITY_TAIL_READY_GRACE_SECONDS)
        except FutureTimeoutError:
            self._cancel_tail_poll_future(tail_future)
            self._discard_prepared_tail_when_ready(tail_prepare_future)
            self._log_voice_event(
                "personality_tail_skipped",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                reason="tail_not_ready_after_lead",
            )
            return 0
        except Exception as err:
            self._discard_prepared_tail_when_ready(tail_prepare_future)
            self._log_voice_event(
                "personality_tail_failed",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                error=str(err),
            )
            return 0
        if not isinstance(tail, JarvisTail) or tail.status != "ready" or not tail.text:
            self._discard_prepared_tail_when_ready(tail_prepare_future)
            self._log_voice_event(
                "personality_tail_skipped",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                status=getattr(tail, "status", "") or None,
                reason=getattr(tail, "reason", "") or None,
                latency_ms=getattr(tail, "latency_ms", None),
            )
            return 0
        self._log_voice_event(
            "personality_tail_ready",
            utterance=utterance,
            speaker_guess=self._speaker_snapshot() or None,
            latency_ms=tail.latency_ms,
            reply_chars=len(tail.text),
        )
        log(f"brain tail: {tail.text}")
        prepared = None
        if tail_prepare_future is not None:
            try:
                prepared_tail = tail_prepare_future.result(timeout=PERSONALITY_TAIL_PREP_READY_GRACE_SECONDS)
                if isinstance(prepared_tail, PreparedJarvisTail):
                    prepared = prepared_tail.prepared
            except FutureTimeoutError:
                self._discard_prepared_tail_when_ready(tail_prepare_future)
            except Exception as err:
                self._log_voice_event(
                    "personality_tail_prepare_failed",
                    utterance=utterance,
                    speaker_guess=self._speaker_snapshot() or None,
                    error=str(err),
                )
        if isinstance(prepared, PreparedSpeech):
            return self._play_prepared_final(audio, prepared, speech=tail.speech, phase="personality_tail")
        return self._speak_final(audio, tail.text, phase="personality_tail", speech=tail.speech)

    def _handle_kill(self, audio: AudioInput, source: str = "unknown") -> None:
        log(f"kill phrase detected source={source}")
        self._end_voice_session(reason=f"kill:{source}")
        goodbye_played = self._play_prompt_or_clip(
            audio,
            "goodbyes",
            self._voice_clips.play_goodbye_clip,
            speaker=DEFAULT_GREETING_SPEAKER,
            post_state="idle",
        )
        if not goodbye_played:
            started = time.monotonic()
            self._set_voice_state("speaking")
            try:
                self._run_with_mic_suppressed(audio, lambda: self._tts.speak_local(self._config.goodbye, phase="goodbye"))
            finally:
                self._restore_active_voice_state()
            goodbye_ms = int(round((time.monotonic() - started) * 1000))
        else:
            goodbye_ms = 0
        self._complete_jarvis_turn(audio, cue_next_turn=False, played_ms=goodbye_ms)
        self._spotter.reset()
        self._kill_spotter.reset()

    def _capture_post_wake_continuation(self, audio: AudioInput, frame_observer=None) -> tuple[bytes, str | None]:
        follow_frames = max(1, int(round(max(0.1, self._config.wake_follow_seconds) * 1000 / FRAME_MS)))
        trigger_frames = max(1, min(self._config.start_trigger_frames, 3))
        vad = webrtcvad.Vad(max(0, min(3, int(self._config.vad_mode))))
        leading_frames: list[bytes] = []
        speech_run = 0
        self._kill_spotter.reset()

        for _ in range(follow_frames):
            frame = audio.read_frame()
            event = self._kill_spotter.feed(frame)
            if event == "kill":
                return b"", event
            leading_frames.append(frame)
            if vad.is_speech(frame, SAMPLE_RATE):
                speech_run += 1
                if speech_run >= trigger_frames:
                    return self._active_turn_capture().capture_after_speech_start(
                        audio,
                        leading_frames,
                        event_spotter=self._kill_spotter,
                        stop_events=("kill",),
                        frame_observer=frame_observer,
                    )
            else:
                speech_run = 0
        return b"", None

    def _handle_wake_continuation(self, audio: AudioInput, wake_recent_audio: bytes = b"") -> str | None:
        live_session = None
        with contextlib.suppress(Exception):
            live_session = self._stt.start_live_session()
        continuation_audio, continuation_event = self._capture_post_wake_continuation(
            audio,
            frame_observer=live_session.feed_audio if live_session is not None else None,
        )
        if continuation_event == "kill":
            with contextlib.suppress(Exception):
                if live_session is not None:
                    live_session.close()
            log("fast local kill detected after wake")
            self._handle_kill(audio, source="wake_continuation")
            self._reset_speaker_session()
            return "idle"
        if not continuation_audio:
            with contextlib.suppress(Exception):
                if live_session is not None:
                    live_session.close()
            return None

        log("wake-attached command detected; skipping wake prompt")
        first_turn_audio = bytes(wake_recent_audio or b"") + bytes(continuation_audio)
        session_result = self._handle_session_turn(
            audio,
            seeded_audio=first_turn_audio,
            strip_leading_wake=True,
            speaker_source="wake_attached_turn",
            speaker_audio=continuation_audio,
            stt_live_session=live_session,
        )
        if session_result == "idle":
            self._end_voice_session(reason="wake_attached_idle")
            self._reset_speaker_session()
            return "idle"
        if session_result == "greet":
            self._apply_pending_speaker_updates()
            self._play_wake_prompt(audio, speaker=self._speaker_identity.active_name())
        return "session"

    def _play_wake_prompt(
        self,
        audio: AudioInput,
        speaker: str = "",
        wake_detected_at: float | None = None,
        wake_phrase_start_lag_ms: int | None = None,
        wake_phrase_end_lag_ms: int | None = None,
    ) -> None:
        speaker = str(speaker or self._config.default_greeting_speaker or DEFAULT_GREETING_SPEAKER).strip() or DEFAULT_GREETING_SPEAKER
        prompt_deadline = None
        if wake_detected_at is not None:
            prompt_deadline = float(wake_detected_at) + WAKE_PROMPT_MIN_DELAY_SECONDS
        speaker = self._wait_for_wake_prompt_speaker(prompt_deadline, speaker)
        played, played_ms = self._play_wake_prompt_rendered(
            audio=audio,
            speaker=speaker,
            wake_detected_at=wake_detected_at,
            wake_phrase_start_lag_ms=wake_phrase_start_lag_ms,
            wake_phrase_end_lag_ms=wake_phrase_end_lag_ms,
        )
        if not played:
            self._recent_prompt_lines = [self._config.greeting]
            played_ms = self._speak_prompt_text(
                self._config.greeting,
                audio=audio,
                event_type="wake_greeting",
                wake_detected_at=wake_detected_at,
                wake_phrase_start_lag_ms=wake_phrase_start_lag_ms,
                wake_phrase_end_lag_ms=wake_phrase_end_lag_ms,
                rendered_via="fallback_tts",
                speaker=speaker,
            )
        self._complete_jarvis_turn(audio, played_ms=played_ms)

    def _play_wake_prompt_rendered(
        self,
        audio: AudioInput | None = None,
        speaker: str = "",
        wake_detected_at: float | None = None,
        wake_phrase_start_lag_ms: int | None = None,
        wake_phrase_end_lag_ms: int | None = None,
    ) -> tuple[bool, int]:
        text = self._prompt_texts.build_wake_greeting(speaker=speaker, prefer=self._wake_greeting_cached)
        if text:
            try:
                self._recent_prompt_lines = [part for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
                return True, self._speak_prompt_text(
                    text,
                    audio=audio,
                    event_type="wake_greeting",
                    wake_detected_at=wake_detected_at,
                    wake_phrase_start_lag_ms=wake_phrase_start_lag_ms,
                    wake_phrase_end_lag_ms=wake_phrase_end_lag_ms,
                    rendered_via="text_tts",
                    speaker=speaker,
                )
            except Exception as err:
                log(f"text wake prompt failed; falling back to voice clips: {err}")
        try:
            self._recent_prompt_lines = []
            self._wait_pending_wake_ack()
            started = time.monotonic()
            self._log_prompt_event_started(
                event_type="wake_greeting",
                started_at=started,
                utterance=None,
                wake_detected_at=wake_detected_at,
                wake_phrase_start_lag_ms=wake_phrase_start_lag_ms,
                wake_phrase_end_lag_ms=wake_phrase_end_lag_ms,
                rendered_via="clip",
                speaker=speaker,
            )
            self._set_voice_state("speaking")
            try:
                played = self._run_with_mic_suppressed(
                    audio,
                    lambda: self._voice_clips.play_wake_greeting(speaker=speaker),
                )
            finally:
                self._restore_active_voice_state()
            played_ms = int(round((time.monotonic() - started) * 1000)) if played else 0
            self._log_prompt_event_finished(
                event_type="wake_greeting",
                started_at=started,
                utterance=None,
                played=played,
                rendered_via="clip",
                speaker=speaker,
            )
            return played, played_ms
        except Exception as err:
            log(f"voice clip wake prompt failed; falling back to TTS: {err}")
            self._recent_prompt_lines = []
            self._log_prompt_event_finished(
                event_type="wake_greeting",
                started_at=started if 'started' in locals() else None,
                utterance=None,
                played=False,
                rendered_via="clip",
                speaker=speaker,
                error=str(err),
            )
            return False, 0

    def _play_cached_wake_greeting(self, audio: "AudioInput | None", spoken: str) -> bool:
        if not hasattr(self._tts, "prepare_cached_speech") or not hasattr(self._tts, "play_prepared_speech"):
            return False
        try:
            prepared = self._prepare_wake_greeting_speech(spoken)
        except Exception as err:
            log(f"cached wake greeting unavailable; speaking live: {err}")
            return False
        self._run_with_mic_suppressed(audio, lambda: self._tts.play_prepared_speech(prepared))
        return True

    def _speak_prompt_text(
        self,
        text: str,
        audio: AudioInput | None = None,
        event_type: str = "",
        wake_detected_at: float | None = None,
        wake_phrase_start_lag_ms: int | None = None,
        wake_phrase_end_lag_ms: int | None = None,
        rendered_via: str = "text",
        speaker: str = "",
    ) -> int:
        spoken = " ".join(str(text or "").split()).strip()
        if not spoken:
            return 0
        started = time.monotonic()
        normalized_event = str(event_type or "").strip()
        self._log_prompt_event_started(
            event_type=event_type,
            started_at=started,
            utterance=spoken,
            wake_detected_at=wake_detected_at,
            wake_phrase_start_lag_ms=wake_phrase_start_lag_ms,
            wake_phrase_end_lag_ms=wake_phrase_end_lag_ms,
            rendered_via=rendered_via,
            speaker=speaker,
        )
        self._wait_pending_wake_ack()
        self._set_voice_state("speaking")
        try:
            with self._speech_lock:
                if normalized_event == "wake_greeting" and self._play_cached_wake_greeting(audio, spoken):
                    pass
                elif normalized_event == "wake_greeting" and hasattr(self._tts, "speak_with_local_fallback"):
                    self._run_with_mic_suppressed(
                        audio,
                        lambda: self._tts.speak_with_local_fallback(
                            spoken,
                            local_fallback_text="Voice service currently offline.",
                            phase=event_type,
                        ),
                    )
                else:
                    self._run_with_mic_suppressed(audio, lambda: self._tts.speak(spoken, phase=event_type))
            self._log_prompt_event_finished(
                event_type=event_type,
                started_at=started,
                utterance=spoken,
                played=True,
                rendered_via=rendered_via,
                speaker=speaker,
            )
            return int(round((time.monotonic() - started) * 1000))
        finally:
            self._restore_active_voice_state()

    def _log_prompt_event_started(
        self,
        event_type: str,
        started_at: float | None,
        utterance: str | None,
        wake_detected_at: float | None = None,
        wake_phrase_start_lag_ms: int | None = None,
        wake_phrase_end_lag_ms: int | None = None,
        rendered_via: str = "",
        speaker: str = "",
    ) -> None:
        normalized = str(event_type or "").strip()
        if not normalized:
            return
        wake_to_started_ms = None
        wake_phrase_start_to_started_ms = None
        wake_phrase_end_to_started_ms = None
        if wake_detected_at is not None and started_at is not None:
            wake_to_started_ms = int(round((float(started_at) - float(wake_detected_at)) * 1000))
            if wake_phrase_start_lag_ms is not None:
                wake_phrase_start_to_started_ms = wake_to_started_ms + int(wake_phrase_start_lag_ms)
            if wake_phrase_end_lag_ms is not None:
                wake_phrase_end_to_started_ms = wake_to_started_ms + int(wake_phrase_end_lag_ms)
        self._log_voice_event(
            f"{normalized}_started",
            speaker_guess=self._speaker_snapshot() or None,
            greeting_speaker=str(speaker or "").strip() or None,
            utterance=utterance,
            rendered_via=str(rendered_via or "").strip() or None,
            wake_to_started_ms=wake_to_started_ms,
            wake_phrase_start_to_started_ms=wake_phrase_start_to_started_ms,
            wake_phrase_end_to_started_ms=wake_phrase_end_to_started_ms,
        )

    def _log_prompt_event_finished(
        self,
        event_type: str,
        started_at: float | None,
        utterance: str | None,
        played: bool,
        rendered_via: str = "",
        speaker: str = "",
        error: str | None = None,
    ) -> None:
        normalized = str(event_type or "").strip()
        if not normalized or started_at is None:
            return
        self._log_voice_event(
            f"{normalized}_finished",
            speaker_guess=self._speaker_snapshot() or None,
            greeting_speaker=str(speaker or "").strip() or None,
            utterance=utterance,
            rendered_via=str(rendered_via or "").strip() or None,
            played=bool(played),
            error=error,
            latency_ms=int(round((time.monotonic() - float(started_at)) * 1000)),
        )

    def _play_prompt_or_clip(
        self,
        audio: AudioInput | None,
        label: str,
        player,
        speaker: str = "",
        post_state: str = "thinking",
    ) -> bool:
        try:
            clip_started = time.monotonic()
            self._log_voice_event(
                "wait_clip_started",
                clip_set=label,
                speaker_guess=self._speaker_snapshot() or None,
            )
            rendered_via = None
            prompt_text = self._prompt_texts.choose_text(label, speaker=speaker)
            if prompt_text:
                self._recent_prompt_lines = [prompt_text]
                played_ms = self._speak_prompt_text(prompt_text, audio=audio)
                played = True
                rendered_via = "text"
            else:
                self._recent_prompt_lines = []
                started = time.monotonic()
                self._set_voice_state("speaking")
                try:
                    played = self._run_with_mic_suppressed(audio, player)
                finally:
                    self._restore_active_voice_state()
                played_ms = int(round((time.monotonic() - started) * 1000)) if played else 0
                rendered_via = "clip" if played else None
        except Exception as err:
            played = False
            rendered_via = None
            played_ms = 0
            log(f"prompt playback failed for {label}: {err}")
            try:
                self._recent_prompt_lines = []
                started = time.monotonic()
                self._set_voice_state("speaking")
                try:
                    played = self._run_with_mic_suppressed(audio, player)
                finally:
                    self._restore_active_voice_state()
                played_ms = int(round((time.monotonic() - started) * 1000)) if played else 0
                rendered_via = "clip" if played else None
            except Exception as clip_err:
                log(f"voice clip bridge failed for {label}: {clip_err}")
                self._log_voice_event(
                    "wait_clip_finished",
                    clip_set=label,
                    speaker_guess=self._speaker_snapshot() or None,
                    played=False,
                    error=str(clip_err),
                )
                return False
        if played:
            if audio is not None:
                self._suppress_playback_tail(audio, played_ms=played_ms)
            self._set_voice_state(post_state)
            self._log_voice_event(
                "wait_clip_finished",
                clip_set=label,
                speaker_guess=self._speaker_snapshot() or None,
                played=True,
                rendered_via=rendered_via,
                latency_ms=int(round((time.monotonic() - clip_started) * 1000)),
            )
            return True
        if 'clip_started' in locals():
            self._log_voice_event(
                "wait_clip_finished",
                clip_set=label,
                speaker_guess=self._speaker_snapshot() or None,
                played=False,
                rendered_via=rendered_via,
                latency_ms=int(round((time.monotonic() - clip_started) * 1000)),
            )
        return False

    def _speak_final(self, audio: AudioInput, text: str, phase: str = "final_reply", speech: dict | None = None) -> int:
        speech_text = speech.get("text") if isinstance(speech, dict) else ""
        spoken = " ".join(str(speech_text or text or "").split()).strip()
        if not spoken:
            return 0
        self._recent_prompt_lines = [part for part in re.split(r"(?<=[.!?])\s+", spoken) if part.strip()]
        started = time.monotonic()
        self._log_voice_event(
            "final_speech_started",
            speaker_guess=self._speaker_snapshot() or None,
            utterance=spoken,
            phase=phase,
            voice_name=str((speech or {}).get("voice_name") or "").strip() or None,
            voice_id=str((speech or {}).get("voice_id") or "").strip() or None,
        )
        self._set_voice_state("speaking")
        try:
            self._publish_tts_phrase(spoken, phase=phase)
            with self._speech_lock:
                self._run_with_mic_suppressed(audio, lambda: self._tts.speak(spoken, speech=speech, phase=phase))
            self._log_voice_event(
                "final_speech_finished",
                speaker_guess=self._speaker_snapshot() or None,
                utterance=spoken,
                phase=phase,
                voice_name=str((speech or {}).get("voice_name") or "").strip() or None,
                voice_id=str((speech or {}).get("voice_id") or "").strip() or None,
                latency_ms=int(round((time.monotonic() - started) * 1000)),
            )
            return int(round((time.monotonic() - started) * 1000))
        finally:
            self._clear_tts_phrase()
            self._restore_active_voice_state()

    def _play_prepared_final(
        self,
        audio: AudioInput,
        prepared: PreparedSpeech,
        speech: dict | None = None,
        phase: str = "final_reply",
    ) -> int:
        speech_text = speech.get("text") if isinstance(speech, dict) else ""
        spoken = " ".join(str(speech_text or prepared.utterance or "").split()).strip()
        if not spoken:
            return 0
        self._recent_prompt_lines = [part for part in re.split(r"(?<=[.!?])\s+", spoken) if part.strip()]
        started = time.monotonic()
        self._log_voice_event(
            "final_speech_started",
            speaker_guess=self._speaker_snapshot() or None,
            utterance=spoken,
            phase=phase,
            voice_name=str((speech or {}).get("voice_name") or "").strip() or None,
            voice_id=str((speech or {}).get("voice_id") or "").strip() or None,
            prepared=True,
        )
        self._set_voice_state("speaking")
        try:
            self._publish_tts_phrase(spoken, phase=phase)
            with self._speech_lock:
                self._run_with_mic_suppressed(audio, lambda: self._tts.play_prepared_speech(prepared))
            self._log_voice_event(
                "final_speech_finished",
                speaker_guess=self._speaker_snapshot() or None,
                utterance=spoken,
                phase=phase,
                voice_name=str((speech or {}).get("voice_name") or "").strip() or None,
                voice_id=str((speech or {}).get("voice_id") or "").strip() or None,
                prepared=True,
                latency_ms=int(round((time.monotonic() - started) * 1000)),
            )
            return int(round((time.monotonic() - started) * 1000))
        finally:
            self._clear_tts_phrase()
            self._restore_active_voice_state()

    def _ask_jarvis_progressive_or_legacy(
        self,
        audio: AudioInput,
        utterance: str,
        speaker_name: str = "",
        speaker_confidence: float = 0.0,
        turn_complete_at: float | None = None,
    ) -> JarvisReply:
        if not hasattr(self, "_tts"):
            return self._ask_jarvis_with_bridge(
                audio,
                utterance,
                speaker_name=speaker_name,
                speaker_confidence=speaker_confidence,
                turn_complete_at=turn_complete_at,
            )
        try:
            return self._ask_jarvis_progressive(
                audio,
                utterance,
                speaker_name=speaker_name,
                speaker_confidence=speaker_confidence,
                turn_complete_at=turn_complete_at,
            )
        except (ProgressiveStreamUnavailable, ProgressiveTurnError, TTSPlaybackError) as err:
            if not progressive_error_allows_legacy(err):
                self._log_voice_event(
                    "progressive_voice_replay_blocked",
                    utterance=utterance,
                    speaker_guess=self._speaker_snapshot() or None,
                    reason=type(err).__name__,
                    error=str(err),
                )
                raise
            log(f"progressive voice unavailable before playback; using legacy path: {err}")
            self._log_voice_event(
                "progressive_voice_fallback",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                reason=type(err).__name__,
                error=str(err),
            )
            return self._ask_jarvis_with_bridge(
                audio,
                utterance,
                speaker_name=speaker_name,
                speaker_confidence=speaker_confidence,
                turn_complete_at=turn_complete_at,
            )

    def _ask_jarvis_progressive(
        self,
        audio: AudioInput,
        utterance: str,
        speaker_name: str = "",
        speaker_confidence: float = 0.0,
        turn_complete_at: float | None = None,
        session_id: str | None = None,
        output_callbacks: dict | None = None,
        restore_voice_state: bool = True,
        endpoint: dict | None = None,
    ) -> JarvisReply:
        request_started = time.monotonic()
        self._set_voice_state("thinking")
        self._log_voice_event(
            "jarvis_progressive_request_started",
            utterance=utterance,
            speaker_guess=self._speaker_snapshot() or None,
        )
        try:
            callbacks = output_callbacks if isinstance(output_callbacks, dict) else {}
            session = self._tts.start_progressive_speech(
                phase="progressive_reply",
                turn_complete_at=turn_complete_at,
                output_start_callback=callbacks.get("start"),
                output_chunk_callback=callbacks.get("chunk"),
                output_close_callback=callbacks.get("close"),
            )
        except Exception as err:
            if restore_voice_state:
                self._restore_active_voice_state()
            raise ProgressiveStreamUnavailable(f"Fish progressive speech is unavailable: {err}") from err

        reply: JarvisReply | None = None
        stream_error: Exception | None = None

        def on_open(cancel_callback) -> None:
            session.set_source_cancel(cancel_callback)

        def on_start(event: dict) -> None:
            self._log_voice_event(
                "jarvis_progressive_stream_started",
                utterance=utterance,
                stream_id=str(event.get("stream_id") or "").strip() or None,
                latency_ms=int(round((time.monotonic() - request_started) * 1000)),
            )

        def on_speech(event: dict) -> None:
            canonical = " ".join(str(event.get("text") or "").split()).strip()
            fish_text = " ".join(str(event.get("fish_text") or canonical).split()).strip()
            kind = str(event.get("kind") or "").strip()
            flush_immediately = kind == "bridge" and session.segment_count == 0
            self._set_voice_state("speaking_thinking")
            session.append(
                fish_text,
                canonical_text=canonical,
                flush_immediately=flush_immediately,
                tone=event.get("tone") or "",
                kind=kind,
            )
            combined = session.utterance
            self._recent_prompt_lines = [
                part
                for part in re.split(r"(?<=[.!?])\s+", combined)
                if part.strip()
            ]
            self._publish_tts_phrase(combined, phase="progressive_reply")
            now = time.monotonic()
            self._log_voice_event(
                "jarvis_progressive_speech_committed",
                utterance=canonical,
                stream_id=session.stream_id,
                sequence=session.segment_count,
                kind=kind or None,
                commit_policy=str(event.get("commit_policy") or "").strip() or None,
                request_to_commit_ms=int(round((now - request_started) * 1000)),
                question_to_commit_ms=(
                    int(round((now - turn_complete_at) * 1000))
                    if turn_complete_at is not None
                    else None
                ),
            )

        def finish_or_partial() -> JarvisReply:
            nonlocal reply, stream_error
            try:
                reply = self._jarvis.ask_stream(
                    utterance,
                    speaker_name,
                    speaker_confidence,
                    (
                        str(getattr(self, "_active_session_id", "") or "").strip()
                        if session_id is None
                        else str(session_id or "").strip()
                    ),
                    on_start=on_start,
                    on_speech=on_speech,
                    on_open=on_open,
                    endpoint=endpoint,
                )
            except (ProgressiveStreamUnavailable, ProgressiveTurnError) as err:
                stream_error = err
            except Exception as err:
                stream_error = ProgressiveTurnError(
                    f"progressive voice request failed: {err}",
                    fallback_allowed=session.segment_count == 0,
                )

            if session.segment_count > 0:
                session.mark_lead_complete()
                self._set_voice_state("speaking")

            if stream_error is not None and session.segment_count == 0:
                session.abort()
                raise stream_error

            if stream_error is None and reply is not None and session.segment_count > 0:
                self._append_progressive_tail_if_ready(session, reply, utterance=utterance)

            try:
                playback = session.finish()
            except TTSPlaybackError as err:
                if session.partial_audio and session.utterance:
                    return self._progressive_partial_reply(
                        session,
                        reply,
                        error=stream_error,
                    )
                session.abort()
                if stream_error is not None:
                    raise stream_error
                if session.segment_count > 0:
                    raise ProgressiveTurnError(
                        f"Fish failed after the brain committed speech: {err}",
                        fallback_allowed=False,
                    ) from err
                raise

            if stream_error is not None:
                if playback.partial_audio and playback.utterance:
                    return self._progressive_partial_reply(
                        session,
                        reply,
                        playback=playback,
                        error=stream_error,
                    )
                raise stream_error

            if reply is None:
                raise ProgressiveTurnError(
                    "brain progressive stream returned no reply",
                    fallback_allowed=not playback.partial_audio,
                )
            if not playback.partial_audio:
                voice_response = reply.voice_response if isinstance(reply.voice_response, dict) else {}
                if str(voice_response.get("mode") or "").strip() == "confirm_beep":
                    return reply
                raise TTSPlaybackError(
                    "Fish progressive stream returned no audio",
                    partial_audio=False,
                    startup_timeout=True,
                )

            reply.text = playback.utterance or reply.text
            reply.progressive_spoken = True
            reply.progressive_played_ms = playback.played_ms
            reply.progressive_segment_count = playback.segment_count
            self._log_voice_event(
                "jarvis_progressive_reply_finished",
                utterance=reply.text,
                stream_id=playback.stream_id,
                segment_count=playback.segment_count,
                request_ms=int(round((time.monotonic() - request_started) * 1000)),
                question_to_first_audio_ms=playback.question_to_first_audio_ms,
                first_audio_ms=playback.first_audio_ms,
                played_ms=playback.played_ms,
                underruns=playback.underruns,
            )
            return reply

        try:
            with self._speech_lock:
                if output_callbacks:
                    return finish_or_partial()
                return self._run_with_mic_suppressed(audio, finish_or_partial)
        finally:
            self._clear_tts_phrase()
            if restore_voice_state:
                self._restore_active_voice_state()

    def _progressive_partial_reply(
        self,
        session: ProgressiveTtsSession,
        reply: JarvisReply | None,
        playback: ProgressivePlaybackResult | None = None,
        error: Exception | None = None,
    ) -> JarvisReply:
        partial = reply or JarvisReply()
        partial.text = (playback.utterance if playback else session.utterance) or partial.text
        partial.failure = None
        partial.speech = None
        partial.tail = None
        partial.progressive_spoken = True
        partial.progressive_played_ms = playback.played_ms if playback else session.played_ms
        partial.progressive_segment_count = playback.segment_count if playback else session.segment_count
        self._log_voice_event(
            "jarvis_progressive_reply_partial",
            utterance=partial.text,
            stream_id=session.stream_id,
            segment_count=partial.progressive_segment_count,
            played_ms=partial.progressive_played_ms,
            error=str(error) if error else None,
        )
        return partial

    def _ask_jarvis_with_bridge(
        self,
        audio: AudioInput,
        utterance: str,
        speaker_name: str = "",
        speaker_confidence: float = 0.0,
        turn_complete_at: float | None = None,
    ) -> JarvisReply:
        request_started = time.monotonic()
        self._set_voice_state("thinking")
        self._log_voice_event(
            "jarvis_http_request_started",
            utterance=utterance,
            speaker_guess=self._speaker_snapshot() or None,
        )
        future = self._jarvis_executor.submit(
            self._jarvis.ask,
            utterance,
            speaker_name,
            speaker_confidence,
            str(getattr(self, "_active_session_id", "") or "").strip(),
        )
        config = getattr(self, "_config", None)
        threshold_ms = int(getattr(config, "slow_reply_threshold_ms", 0) or 0)
        if threshold_ms <= 0:
            threshold_ms = int(round(THINKING_CLIP_DELAY_SECONDS * 1000))
        next_clip_at = request_started + (threshold_ms / 1000.0)
        reply_allowed_at = 0.0
        clip_sequence = [
            ("thinking", self._voice_clips.play_thinking_clip),
            ("waitTimes", self._voice_clips.play_wait_clip),
            ("waitExtended", self._voice_clips.play_wait_extended_clip),
        ]

        def wait_for_reply_until(deadline: float) -> JarvisReply | None:
            remaining_seconds = max(0.0, deadline - time.monotonic())
            try:
                if remaining_seconds > 0.0:
                    reply = future.result(timeout=remaining_seconds)
                if future.done():
                    reply = future.result()
                else:
                    return None
            except FutureTimeoutError:
                return None
            if reply_allowed_at > 0.0:
                post_clip_remaining = max(0.0, reply_allowed_at - time.monotonic())
                if post_clip_remaining > 0.0:
                    time.sleep(post_clip_remaining)
            self._log_voice_event(
                "jarvis_http_reply_received",
                utterance=utterance,
                speaker_guess=self._speaker_snapshot() or None,
                latency_ms=int(round((time.monotonic() - request_started) * 1000)),
                reply_chars=len(reply.text or ""),
                error_code=reply.failure.code if reply.failure else None,
            )
            return reply

        def return_reply_when_allowed() -> JarvisReply | None:
            if not future.done():
                return None
            if reply_allowed_at > 0.0:
                delayed_reply = wait_for_reply_until(reply_allowed_at)
                if delayed_reply is not None:
                    return delayed_reply
            return future.result()

        for label, player in clip_sequence:
            reply = wait_for_reply_until(next_clip_at)
            if reply is not None:
                return reply

            log(f"{label} wait threshold hit; attempting clip")
            if self._play_prompt_or_clip(audio, label, player):
                reply_allowed_at = time.monotonic() + POST_CLIP_REPLY_DELAY_SECONDS
            next_clip_at = time.monotonic() + WAITING_CLIP_DELAY_SECONDS

        repeated_wait_clips = 0
        while True:
            reply = return_reply_when_allowed()
            if reply is not None:
                return reply

            reply = wait_for_reply_until(next_clip_at)
            if reply is not None:
                return reply

            if repeated_wait_clips >= MAX_REPEATING_WAIT_CLIPS:
                log("repeating wait audio limit reached; waiting silently for reply")
                next_clip_at = time.monotonic() + SILENT_REPLY_POLL_SECONDS
                continue

            log("repeating wait threshold hit; attempting waiting clip")
            repeated_wait_clips += 1
            if self._play_prompt_or_clip(audio, "waitTimes", self._voice_clips.play_wait_clip):
                reply_allowed_at = time.monotonic() + POST_CLIP_REPLY_DELAY_SECONDS
            next_clip_at = time.monotonic() + WAITING_CLIP_DELAY_SECONDS

    def _wait_for_wake(self, audio: AudioInput) -> dict | None:
        self._spotter.reset()
        while self._running:
            frame = audio.read_frame()
            event = self._spotter.feed(frame)
            if event:
                return {
                    "event": event,
                    "recent_audio": self._spotter.recent_audio(),
                }
        return None

    def _matches_kill_phrase(self, utterance: str) -> bool:
        return matches_kill_phrase_text(utterance, self._config.phrase_variants)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--v5-test-mode", action="store_true", help="send this run to the test brain endpoint")
    parser.add_argument("--brain-url", dest="jarvis_url", default="", help="override the brain URL for this run")
    parser.add_argument("--brain-probe", action="store_true", help="run a simple brain HTTP probe and exit")
    parser.add_argument("--tail-probe", action="store_true", help="run a brain lead/tail HTTP probe and exit")
    parser.add_argument("--tail-probe-playback", action="store_true", help="speak the tail probe lead and ready tail")
    return parser.parse_args(argv)


def apply_runtime_target_overrides(config: Config, args: argparse.Namespace) -> Config:
    override_url = str(getattr(args, "jarvis_url", "") or "").strip()
    v5_test_mode = bool(getattr(args, "v5_test_mode", False))
    if not v5_test_mode and not override_url:
        return config
    target_url = override_url or DEFAULT_V5_TEST_URL
    if v5_test_mode:
        return dataclasses.replace(
            config,
            jarvis_url=target_url,
            jarvis_channel="voice_http_test",
            jarvis_source_via="linux_voice_loop_v5_test",
            voice_audio_manifest_url="disabled",
        )
    return dataclasses.replace(config, jarvis_url=target_url)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    config = apply_runtime_target_overrides(Config.load(args.config), args)
    if args.brain_probe:
        return run_brain_probe(config)
    if args.tail_probe:
        return run_tail_probe(config, play_audio=bool(args.tail_probe_playback))
    loop = JarvisVoiceLoop(config)
    signal.signal(signal.SIGINT, loop.stop)
    signal.signal(signal.SIGTERM, loop.stop)
    return loop.run()


def run_brain_probe(config: Config) -> int:
    client = JarvisClient(
        config.jarvis_url,
        config.jarvis_token,
        config.room,
        config.jarvis_channel,
        config.jarvis_source_via,
    )
    started = time.monotonic()
    reply = client.ask("system health", speaker_name=next(iter(speaker_person_ids()), ""), speaker_confidence=1.0)
    latency_ms = int(round((time.monotonic() - started) * 1000))
    payload = {
        "ok": bool(reply.text),
        "text": reply.text,
        "latency_ms": latency_ms,
        "failure_code": reply.failure.code if reply.failure else "",
        "jarvis_url": config.jarvis_url,
        "jarvis_channel": config.jarvis_channel,
        "jarvis_source_via": config.jarvis_source_via,
    }
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
    return 0 if payload["ok"] else 1


def run_tail_probe(config: Config, play_audio: bool = False, tts_engine=None) -> int:
    client = JarvisClient(
        config.jarvis_url,
        config.jarvis_token,
        config.room,
        config.jarvis_channel,
        config.jarvis_source_via,
    )
    started = time.monotonic()
    reply = client.ask("tail probe", speaker_name=next(iter(speaker_person_ids()), ""), speaker_confidence=1.0)
    lead_ms = int(round((time.monotonic() - started) * 1000))
    tail_future = None
    if play_audio:
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="housemate-tail-probe")
        tail_future = executor.submit(client.poll_tail, reply.tail, personality_tail_poll_timeout_for_text(reply.text))
        tts = tts_engine or build_tts_engine(config)
        try:
            tts.speak(reply.text, speech=reply.speech, phase="tail_probe_lead")
            try:
                tail = tail_future.result(timeout=PERSONALITY_TAIL_READY_GRACE_SECONDS)
            except FutureTimeoutError:
                tail = JarvisTail(status="timeout", reason="tail_not_ready_after_lead")
            if tail.status == "ready" and tail.text:
                tts.speak(tail.text, speech=tail.speech, phase="tail_probe_tail")
        finally:
            executor.shutdown(wait=False, cancel_futures=True)
    else:
        tail = client.poll_tail(reply.tail, timeout_seconds=PERSONALITY_TAIL_MAX_POLL_TIMEOUT_SECONDS)
    payload = {
        "ok": bool(reply.text and tail.status == "ready" and tail.text),
        "lead_text": reply.text,
        "tail_status": tail.status,
        "tail_text": tail.text,
        "lead_ms": lead_ms,
        "tail_latency_ms": tail.latency_ms,
        "tail_reason": tail.reason,
    }
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
