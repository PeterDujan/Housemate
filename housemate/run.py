#!/usr/bin/env python3
"""Housemate start: the brain (Node) and the voice (Python) from one settings screen, run together.

The house's own data lives under /data and is never written over by the image:
  /data/brain   the brain's data dir (household.json, personality.json, house.json, memory...)
  /data/voice   the voice's HOME (speaker profiles, gateway key and registry, speech cache...)
Advanced voice tuning: /config/settings.json (this app's folder). Moving in from another box:
/config/import or /share/housemate/import (copied in once, never over anything).
If either process stops, the app stops and the Supervisor's watchdog starts it again.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

DATA = "/data"
BRAIN_DATA = os.path.join(DATA, "brain")
VOICE_HOME = os.path.join(DATA, "voice")
OPTIONS_PATH = os.path.join(DATA, "options.json")
SETTINGS_PATH = "/config/settings.json"
VOICE_CONFIG_PATH = os.path.join(DATA, "voice-config.json")
TOKEN_PATH = os.path.join(DATA, "internal-token")
STORE_VERSION_PATH = os.path.join(DATA, "store-version")
# Bump with a copy-first migration whenever a store under /data changes format.
STORE_VERSION = 1
IMPORT_DIRS = ("/config/import", "/share/housemate/import")
# Other apps and agents leave questions for the household here (the brain reads them out when asked).
QUESTIONS_DIR = "/share/housemate/questions"
APP = "/opt/housemate"
BRAIN_DIR = os.path.join(APP, "brain")
VOICE_DIR = os.path.join(APP, "voice")
SUPERVISOR = "http://supervisor"
DEFAULT_BRAIN_PORT = 3005

HEARING_BACKENDS = {
    "deepgram": "deepgram",
    "elevenlabs": "elevenlabs",
    "inworld": "inworld",
    "local_whisper": "local",
    "home_assistant": "home_assistant",
}

VOICE_DEFAULTS = {
    "room": "home",
    "deepgram_end_of_turn": "flux",
    "deepgram_model": "nova-3",
    "endpoint_gateway_bind_host": "0.0.0.0",
    "remote_tts_enabled": False,
    "wake_sample_capture_enabled": False,
    "fast_stt_model": "",
}


def log(message: str) -> None:
    print(f"[housemate] {message}", flush=True)


def read_json(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{path} must hold a JSON object")
    return value


def check_store_version(path: str = STORE_VERSION_PATH) -> None:
    """An older app never opens a newer store: it says so and stops rather than damage it."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            found = int(handle.read().strip() or 0)
    except FileNotFoundError:
        found = 0
    if found > STORE_VERSION:
        log(
            f"this house's data is store version {found}, newer than this app knows ({STORE_VERSION}). "
            "Update Housemate, or restore the backup taken before the downgrade."
        )
        sys.exit(1)
    if found < STORE_VERSION:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"{STORE_VERSION}\n")


def import_files(source: str, data: str = DATA, settings_path: str = SETTINGS_PATH) -> None:
    """Copies what is missing from an import folder (laid out as /data: brain/..., voice/...) into the
    house's data, then renames it import-done-<time> so it runs once. A file already there is kept,
    unless the folder holds a `.replace` marker (moving in again): then the file there is first moved
    to /data/replaced-<time>/ and the imported one takes its place."""
    if not os.path.isdir(source):
        return
    marker = os.path.join(source, ".replace")
    replace = os.path.exists(marker)
    if replace:
        os.unlink(marker)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    copied, kept, moved = 0, [], 0
    for root, _dirs, files in os.walk(source):
        for name in files:
            path = os.path.join(root, name)
            relative = os.path.relpath(path, source)
            target = settings_path if relative == "settings.json" else os.path.join(data, relative)
            if os.path.lexists(target):
                if not replace:
                    kept.append(relative)
                    continue
                aside = os.path.join(data, f"replaced-{stamp}", relative)
                os.makedirs(os.path.dirname(aside), exist_ok=True)
                shutil.move(target, aside)
                moved += 1
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(path, target)
            copied += 1
    done = f"{source}-done-{stamp}"
    os.rename(source, done)
    log(f"imported {copied} files into the house's data; {len(kept)} already there were left alone"
        + (f"; {moved} replaced files are in {os.path.join(data, f'replaced-{stamp}')}" if moved else ""))
    for relative in kept[:20]:
        log(f"import: kept the existing {relative}")
    log(f"the imported copy is in {done}: delete it once everything works (it may hold keys)")


def internal_token(options: dict, path: str = TOKEN_PATH) -> str:
    """The brain's API token: the set one, else one made here once and kept (the voice uses it)."""
    given = str(options.get("api_token") or "").strip()
    if given:
        return given
    try:
        with open(path, "r", encoding="utf-8") as handle:
            token = handle.read().strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    token = secrets.token_hex(24)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(token)
    return token


def assistant_name(brain_data: str = BRAIN_DATA) -> str:
    """The persona's name (the brain's personality.json), so the voice names its services after it."""
    name = str(read_json(os.path.join(brain_data, "personality.json")).get("name") or "").strip()
    return name or "Housemate"


def assistant_heard_as(brain_data: str = BRAIN_DATA) -> list:
    """The name's nicknames and mishearings from the persona, so the voice hears every form of it."""
    try:
        persona = read_json(os.path.join(brain_data, "personality.json"))
    except ValueError:
        return []
    words = [*(persona.get("aliases") or []), *(persona.get("misheard_as") or [])]
    return [" ".join(str(word).lower().split()) for word in words if str(word).strip()]


def link_wikipedia(options: dict, brain_data: str = BRAIN_DATA) -> None:
    """The offline Wikipedia store stays in /share (it is large): <brain>/knowledge points at it."""
    folder = str(options.get("wikipedia_dir") or "").strip()
    link = os.path.join(brain_data, "knowledge")
    if not folder:
        return
    if os.path.islink(link) and os.readlink(link) == folder:
        return
    if os.path.lexists(link) and not os.path.islink(link):
        log(f"{link} is a real folder; not replacing it with the Wikipedia link")
        return
    if os.path.islink(link):
        os.unlink(link)
    os.symlink(folder, link)


def brain_port(options: dict) -> int:
    return int(options.get("brain_port") or DEFAULT_BRAIN_PORT)


def brain_env(options: dict, token: str, base: dict | None = None, voice_words: dict | None = None) -> dict:
    """The brain's environment: the settings screen as its JARVIS_V5_* settings."""
    env = {key: value for key, value in (base if base is not None else os.environ).items() if not key.startswith("JARVIS_V5_")}
    brain = str(options.get("brain") or "claude")
    flag = lambda key, default: "true" if options.get(key, default) else "false"  # noqa: E731
    env.update({
        "JARVIS_V5_DATA_DIR": BRAIN_DATA,
        "JARVIS_V5_CONFIG_FILE": os.path.join(BRAIN_DATA, "config.json"),
        "JARVIS_V5_ALIAS_FILE": os.path.join(BRAIN_DATA, "aliases.json"),
        "JARVIS_V5_QUESTIONS_DIR": QUESTIONS_DIR,
        "JARVIS_V5_VOICE_WORDS": json.dumps(voice_words or {}),
        # The voice's turn API on loopback, for voice training from the page.
        "JARVIS_V5_VOICE_URL": f"http://127.0.0.1:{int(options.get('turn_port', 10311))}" if options.get("assist_enabled", True) else "",
        "JARVIS_V5_PORT": str(brain_port(options)),
        "JARVIS_V5_BACKGROUND_WATCHERS_ENABLED": flag("background_jobs", True),
        "JARVIS_V5_CLAUDE_HOME": os.path.join(BRAIN_DATA, "claude-home"),
        "JARVIS_V5_CODEX_HOME": os.path.join(BRAIN_DATA, "codex-home"),
        "JARVIS_V5_CODEX_WORKING_DIRECTORY": BRAIN_DIR,
        "JARVIS_V5_MODEL_BACKEND": "codex" if brain == "codex" else "claude",
        "JARVIS_V5_MODEL_ENABLED": "false" if brain == "off" else "true",
        "JARVIS_V5_MODEL": str(options.get("model") or "claude-sonnet-5"),
        "JARVIS_V5_MONTHLY_BUDGET_USD": str(options.get("monthly_budget_usd", 7.5)),
        "JARVIS_V5_CLAUDE_CHAT_EFFORT": str(options.get("chat_effort") or "default"),
        "JARVIS_V5_COGNITIVE_LEARNING_ENABLED": flag("learn_from_chats", True),
        "JARVIS_V5_MEMORY_REFLECTION_ENABLED": flag("learn_from_chats", True),
        "JARVIS_V5_MEMORY_RECALL_ENABLED": flag("recall_memories", True),
        "JARVIS_V5_COGNITIVE_RECALL_ENABLED": flag("recall_memories", True),
        "JARVIS_V5_MEMORY_ARCHIVE_ENABLED": flag("keep_words", True),
        "JARVIS_V5_COGNITIVE_PROACTIVE_ENABLED": flag("speak_up_on_its_own", False),
        "JARVIS_V5_SELF_GROWTH_ENABLED": flag("grow_its_character", False),
        "JARVIS_V5_DEVICE_CONTROL_ENABLED": flag("device_control", True),
        "JARVIS_V5_CHAT_TOOLS_ENABLED": flag("chat_tools", False),
        "JARVIS_V5_CHAT_WEB_SEARCH_ENABLED": flag("web_search", False),
        "JARVIS_V5_COGNITIVE_API_TOKEN": token,
        "JARVIS_V5_DASHBOARD_PATH": str(options.get("_dashboard_path") or ""),
        "JARVIS_V5_LOCALE": str(options.get("_locale") or "en"),
        "HA_URL": f"{SUPERVISOR.replace('http', 'ws')}/core/websocket",
        "HA_TOKEN": env.get("SUPERVISOR_TOKEN", ""),
    })
    for option, setting in (
        ("claude_token", "JARVIS_V5_CLAUDE_AUTH_TOKEN"),
        ("claude_api_key", "JARVIS_V5_CLAUDE_API_KEY"),
        ("openai_api_key", "JARVIS_V5_OPENAI_API_KEY"),
        ("place", "JARVIS_V5_PLACE"),
        ("household_roster", "JARVIS_V5_HOUSEHOLD_ROSTER"),
        ("approval_phone", "JARVIS_V5_MEMORY_APPROVAL_NOTIFY_SERVICE"),
        ("operator_ha_user", "JARVIS_V5_COGNITIVE_INGRESS_USER_ID"),
        ("projects_dir", "JARVIS_V5_PROJECTS_DIR"),
    ):
        value = str(options.get(option) or "").strip()
        if value:
            env[setting] = value
    return env


# Home Assistant's own speech, best first: its cloud, then what runs on the box.
HA_HEARING_FIRST = ("cloud", "whisper", "speech_to_phrase", "vosk")
HA_VOICE_FIRST = ("cloud", "piper", "kokoro", "google")


def best_entity(ids: list, first: tuple) -> str:
    """The best of HA's speech entities: the first whose id names a preferred engine, else the first there is."""
    for word in first:
        for entity_id in ids:
            if word in entity_id:
                return entity_id
    return ids[0] if ids else ""


def best_language(languages: list, locale: str) -> str:
    """The engine's language closest to the house's (en-AU, else any en)."""
    wanted = locale.lower()
    by_case = {str(language).lower(): str(language) for language in languages}
    if wanted in by_case:
        return by_case[wanted]
    base = wanted.split("-")[0]
    return by_case.get(base) or next((by_case[key] for key in by_case if key.split("-")[0] == base), "")


HA_STORAGE = "/homeassistant/.storage"


def own_speech_entities(port: int, storage: str = HA_STORAGE) -> set:
    """HA's speech entities that are this app's own (its Wyoming port): never picked, or it would hear itself."""
    try:
        entries = read_json(os.path.join(storage, "core.config_entries")).get("data", {}).get("entries", [])
        registry = read_json(os.path.join(storage, "core.entity_registry")).get("data", {}).get("entities", [])
    except (OSError, ValueError, AttributeError):
        return set()
    own = {entry.get("entry_id") for entry in entries
           if entry.get("domain") == "wyoming" and int((entry.get("data") or {}).get("port") or 0) == port}
    return {entity.get("entity_id") for entity in registry if entity.get("config_entry_id") in own}


def home_assistant_speech(options: dict, storage: str = HA_STORAGE) -> dict:
    """With hearing or voice on Home Assistant and no entity named, HA's own is picked (and logged).
    Returns the options to use; the saved options are left as they are."""
    hearing = str(options.get("hearing") or "home_assistant") == "home_assistant" and not str(options.get("ha_stt_entity") or "").strip()
    voice = str(options.get("voice") or "home_assistant") == "home_assistant" and not str(options.get("ha_tts_entity") or "").strip()
    if not (hearing or voice):
        return options
    try:
        states = supervisor_get_core("/api/states")
    except Exception as err:
        log(f"could not read Home Assistant's speech engines: {err}")
        return options
    own = own_speech_entities(int(options.get("wyoming_port", 10310)), storage)
    ids = sorted(str(state.get("entity_id") or "") for state in states
                 if isinstance(state, dict) and state.get("state") != "unavailable" and state.get("entity_id") not in own)
    picked = dict(options)
    if hearing:
        stt = best_entity([entity_id for entity_id in ids if entity_id.startswith("stt.")], HA_HEARING_FIRST)
        if stt:
            picked["ha_stt_entity"] = stt
            try:
                language = best_language(supervisor_get_core(f"/api/stt/{stt}").get("languages") or [], str(options.get("_locale") or options.get("language") or "en"))
                if language:
                    picked["ha_stt_language"] = language
            except Exception as err:
                log(f"could not read {stt}'s languages: {err}")
            log(f"hearing: Home Assistant's {stt} ({picked.get('ha_stt_language') or 'its default language'})")
        else:
            log("hearing: Home Assistant has no speech-to-text, so the app's own Whisper hears (add one in Home Assistant, e.g. Whisper or Home Assistant Cloud)")
    if voice:
        tts = best_entity([entity_id for entity_id in ids if entity_id.startswith("tts.")], HA_VOICE_FIRST)
        if tts:
            picked["ha_tts_entity"] = tts
            log(f"voice: Home Assistant's {tts}")
        else:
            log("voice: Home Assistant has no text-to-speech, so the app's basic voice speaks (add one in Home Assistant, e.g. Piper or Home Assistant Cloud)")
    return picked


def voice_options_layer(options: dict) -> dict:
    """The settings screen, as Voice Loop settings. Empty keys and lists are left out."""
    layer: dict = {
        "stt_backend": HEARING_BACKENDS.get(str(options.get("hearing") or ""), "home_assistant"),
        "deepgram_language": str(options.get("language") or "en-AU").strip(),
        "speaker_id_enabled": bool(options.get("speaker_id", True)),
        "endpoint_gateway_enabled": bool(options.get("speakers_enabled", True)),
        "endpoint_gateway_port": int(options.get("speakers_port", 8196)),
        "browser_voice_enabled": False,
        "assist_wyoming_enabled": bool(options.get("assist_enabled", True)),
        "assist_wyoming_port": int(options.get("wyoming_port", 10310)),
        "assist_turn_port": int(options.get("turn_port", 10311)),
        "ha_state_publish_enabled": bool(options.get("publish_states", True)),
    }
    voice = str(options.get("voice") or "home_assistant")
    layer["fish_audio_enabled"] = voice == "fish"
    for option, setting in (
        ("deepgram_api_key", "deepgram_api_key"),
        ("elevenlabs_api_key", "elevenlabs_api_key"),
        ("inworld_api_key", "inworld_api_key"),
        ("ha_stt_entity", "ha_stt_entity"),
        ("ha_stt_language", "ha_stt_language"),
        ("fish_api_key", "fish_audio_api_key"),
        ("fish_voice_id", "fish_audio_voice_id"),
        ("ha_tts_entity", "ha_tts_entity"),
    ):
        value = str(options.get(option) or "").strip()
        if value:
            layer[setting] = value
    if voice == "espeak":
        layer["ha_tts_entity"] = ""
    keyterms = [str(term).strip() for term in options.get("keyterms") or [] if str(term).strip()]
    if keyterms:
        layer["deepgram_keyterms"] = keyterms
        layer["elevenlabs_keyterms"] = keyterms
        layer["inworld_keyterms"] = keyterms
    return layer


def name_phrases(name: str) -> dict:
    """The wake and stop phrases made from the assistant's own name ("hey nabu", "bye bye nabu")."""
    key = " ".join(str(name or "").lower().split()) or "housemate"
    return {
        "wake_phrase": f"hey {key}",
        "kill_phrase": f"bye bye {key}",
        "phrase_variants": {"wake": [f"hey {key}", f"hi {key}", f"ok {key}"], "kill": [f"bye bye {key}", f"bye {key}", f"goodbye {key}"]},
    }


def voice_words_layer(words: dict) -> dict:
    """The House page's spoken words (brain/voice-words.json): greeting, goodbye and the stop phrase."""
    layer = {key: str(words[key]).strip() for key in ("greeting", "goodbye") if str(words.get(key) or "").strip()}
    stop = " ".join(str(words.get("stop_phrase") or "").lower().split())
    if stop:
        layer["kill_phrase"] = stop
    return layer


def page_voice_words() -> dict:
    """The page's spoken words; a damaged file is left out, never a reason not to start."""
    try:
        return read_json(os.path.join(BRAIN_DATA, "voice-words.json"))
    except ValueError as err:
        log(f"voice-words.json is damaged, so the spoken words are the defaults: {err}")
        return {}


def voice_words_in_use(config: dict) -> dict:
    """What the voice starts with, for the page (JARVIS_V5_VOICE_WORDS)."""
    return {"greeting": config.get("greeting", ""), "goodbye": config.get("goodbye", ""), "stop_phrase": config.get("kill_phrase", "")}


def voice_config(options: dict, settings: dict, token: str, name: str, supervisor_token: str, words: dict | None = None,
                 heard_as: list | None = None) -> dict:
    """defaults (with phrases from the name) < /config/settings.json < the page's spoken words
    < settings screen < what the app itself decides."""
    config = dict(VOICE_DEFAULTS)
    config.update(name_phrases(name))
    config.update(settings)
    config.update(voice_words_layer(words or {}))
    # The stop phrase in use is always one the voice listens for.
    variants = dict(config.get("phrase_variants") or {})
    kills = [str(phrase) for phrase in variants.get("kill") or []]
    if config.get("kill_phrase") and config["kill_phrase"] not in kills:
        variants["kill"] = [config["kill_phrase"], *kills]
        config["phrase_variants"] = variants
    config.update(voice_options_layer(options))
    config.update({
        "jarvis_url": f"http://127.0.0.1:{brain_port(options)}/voice/brain",
        "jarvis_token": token,
        "assistant_name": name,
        # The persona's forms of the name, plus any the advanced settings file adds.
        "assistant_heard_as": list(dict.fromkeys([*(heard_as or []), *(settings.get("assistant_heard_as") or [])])),
        "household_file": os.path.join(BRAIN_DATA, "household.json"),
        "local_voice_enabled": False,
        "assist_wyoming_bind_host": "127.0.0.1",
        "remote_tts_bind_host": "127.0.0.1",
        "ha_state_publish_url": f"{SUPERVISOR}/core",
        "ha_state_publish_token": supervisor_token,
        "ha_state_publish_client_id": "",
    })
    if config["ha_state_publish_enabled"] and not supervisor_token:
        config["ha_state_publish_enabled"] = False
    return config


def explain(config: dict, options: dict) -> None:
    """Plain words in the log for a choice that cannot work yet. Never prints a key."""
    needs = {
        "deepgram": "deepgram_api_key",
        "elevenlabs": "elevenlabs_api_key",
        "inworld": "inworld_api_key",
        "home_assistant": "ha_stt_entity",
    }.get(config["stt_backend"])
    if needs and not config.get(needs):
        log(f"hearing is {options.get('hearing')}, but {needs} is empty: turns fall back to local Whisper")
    if config.get("fish_audio_enabled") and not (config.get("fish_audio_api_key") and config.get("fish_audio_voice_id")):
        log("voice is Fish, but the Fish key or voice id is empty: replies use the fallback voice")
    if str(options.get("brain")) == "claude" and not (str(options.get("claude_token") or "").strip() or str(options.get("claude_api_key") or "").strip()):
        log("brain is Claude, but neither claude_token nor claude_api_key is set: chat answers stay in code until it is")


def write_private_json(path: str, value: dict) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)


def supervisor_get(path: str) -> dict:
    token = os.environ.get("SUPERVISOR_TOKEN", "")
    request = urllib.request.Request(f"{SUPERVISOR}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read() or b"{}").get("data") or {}


def supervisor_get_core(path: str) -> dict:
    """Home Assistant's own REST API through the Supervisor (no data wrapper)."""
    token = os.environ.get("SUPERVISOR_TOKEN", "")
    request = urllib.request.Request(f"{SUPERVISOR}/core{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read() or b"{}")


def discoveries(config: dict, name: str) -> list:
    """What HA is told about: the hearing/voice service (Wyoming) and the brain (Housemate Brain)."""
    return [
        ("wyoming", {"uri": f"tcp://127.0.0.1:{config['assist_wyoming_port']}"}),
        ("housemate", {"host": "127.0.0.1", "port": int(config["assist_turn_port"]), "name": name}),
    ]


def announce(service: str, config: dict) -> None:
    """HA offers it itself (Settings > Devices > Discovered); the brain once Housemate Brain is installed."""
    token = os.environ.get("SUPERVISOR_TOKEN", "")
    if not token:
        return
    request = urllib.request.Request(
        f"{SUPERVISOR}/discovery",
        data=json.dumps({"service": service, "config": config}).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
        log(f"announced {service} to Home Assistant")
    except Exception as err:
        log(f"could not announce {service}: {err}")


def self_test() -> None:
    """Both test suites inside this image, on throwaway data (never /data)."""
    with tempfile.TemporaryDirectory() as scratch:
        env = {key: value for key, value in os.environ.items() if key != "SUPERVISOR_TOKEN"}
        env.update(HOME=scratch, TMPDIR=scratch)
        runs = (
            ("voice", [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"], VOICE_DIR, {}),
            ("brain", ["npm", "run", "-s", "test:image"], BRAIN_DIR, {}),
        )
        for name, command, cwd, extra in runs:
            log(f"self test: {name}")
            result = subprocess.run(command, cwd=cwd, env={**env, **extra}, capture_output=True, text=True)
            lines = (result.stdout + result.stderr).strip().splitlines()
            summary = [line for line in lines if " passed" in line or " failed" in line or line.startswith(("# pass", "# fail"))][-2:]
            failures = [index for index, line in enumerate(lines) if line.startswith(("FAILED", "ERROR", "not ok"))]
            for index in failures[:20]:
                log(f"self test {name}: {lines[index]}")
                # The assertion's own words (expected/actual), so a failure can be read from the log.
                for detail in [line for line in lines[index + 1:index + 30] if any(word in line for word in ("expected", "actual", "+ ", "- ", "error:"))][:6]:
                    log(f"self test {name}:     {detail.strip()[:240]}")
            for line in summary or lines[-1:]:
                log(f"self test {name}: {line}")


def run(commands: list[tuple[str, list[str], str, dict]]) -> int:
    """Starts every process; when one stops, stops the rest and exits with its code (0 when asked to stop)."""
    children = []
    asked = []
    for name, command, cwd, env in commands:
        children.append((name, subprocess.Popen(command, cwd=cwd, env=env)))

    def stop(signum=None, _frame=None):
        if signum is not None:
            asked.append(signum)
        for _name, child in children:
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while True:
        for name, child in children:
            code = child.poll()
            if code is not None:
                log(f"the {name} stopped (exit {code}); stopping the app")
                stop()
                for _other, rest in children:
                    try:
                        rest.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        rest.kill()
                return 0 if asked else (code or 1)
        time.sleep(0.5)


def main() -> int:
    os.makedirs(BRAIN_DATA, exist_ok=True)
    os.makedirs(os.path.join(BRAIN_DATA, "logs"), exist_ok=True)
    os.makedirs(VOICE_HOME, exist_ok=True)
    check_store_version()
    for source in IMPORT_DIRS:
        import_files(source)
    options = read_json(OPTIONS_PATH)
    settings = read_json(SETTINGS_PATH)
    token = internal_token(options)
    link_wikipedia(options)
    try:
        ha = supervisor_get_core("/api/config")
        language, country = str(ha.get("language") or "").strip(), str(ha.get("country") or "").strip()
        options["_locale"] = f"{language.split('-')[0]}-{country}" if language and country else (language or "")
    except Exception as err:
        log(f"could not read Home Assistant's language and country: {err}")
    try:
        slug = str(supervisor_get("/addons/self/info").get("slug") or "")
        options["_dashboard_path"] = f"/{slug}/dashboard-ui" if slug else ""
    except Exception as err:
        log(f"could not read this app's own info: {err}")
    name = assistant_name()
    options = home_assistant_speech(options)
    config = voice_config(options, settings, token, name, os.environ.get("SUPERVISOR_TOKEN", ""), page_voice_words(), assistant_heard_as())
    explain(config, options)
    write_private_json(VOICE_CONFIG_PATH, config)
    log(f"{name}: brain {options.get('brain', 'claude')}, hearing {config['stt_backend']}, "
        f"voice {'fish' if config['fish_audio_enabled'] else options.get('voice')}")
    if options.get("self_test"):
        self_test()
    if config["assist_wyoming_enabled"] and options.get("announce_to_home_assistant", True):
        for service, found in discoveries(config, name):
            announce(service, found)
    voice_env = dict(os.environ, HOME=VOICE_HOME)
    return run([
        ("brain", ["node", os.path.join(BRAIN_DIR, "dist", "src", "index.js")], BRAIN_DIR, brain_env(options, token, voice_words=voice_words_in_use(config))),
        ("voice", [sys.executable, "housemate_voice_loop.py", "--config", VOICE_CONFIG_PATH], VOICE_DIR, voice_env),
    ])


if __name__ == "__main__":
    raise SystemExit(main())
