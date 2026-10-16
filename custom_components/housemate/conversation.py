"""The Housemate conversation agent: a satellite's transcript to the Housemate app, its turn back."""

from __future__ import annotations

import logging
import time
from typing import Any, Literal

import aiohttp
from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED, MATCH_ALL
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr, entity_registry as er, intent, llm
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import (
    CALIBRATE_ACTION,
    CALIBRATION_DONE_EVENT,
    CALIBRATION_PATH,
    CALIBRATION_START_KEEP_SECONDS,
    CONF_HOST,
    CONF_PORT,
    MUSIC_PATH,
    MUSIC_STATES,
    START_EVENT,
    START_KEEP_SECONDS,
    TRAINING_BEEP_URL,
    TURN_PATH,
    TURN_TIMEOUT_SECONDS,
)
from .turn_stream import SPEAKING_TOOL, turn_deltas

_LOGGER = logging.getLogger(__name__)
UNREACHABLE_LINE = "I can't hear myself think. My voice box isn't answering."


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([HousemateAgent(entry)])


class HousemateAgent(conversation.ConversationEntity):
    """The assistant's own turn in the Housemate app: speaker ID, session, brain, voice. Nothing decided here."""

    _attr_has_entity_name = False
    _attr_supports_streaming = True

    def __init__(self, entry: ConfigEntry) -> None:
        base = f"http://{entry.data[CONF_HOST]}:{entry.data[CONF_PORT]}"
        self._url = base + TURN_PATH
        self._music_url = base + MUSIC_PATH
        self._calibration_url = base + CALIBRATION_PATH
        self._attr_unique_id = entry.entry_id
        # Named after the assistant (the entry title): the entity id follows the assistant's name.
        self._attr_name = entry.title
        # device_id > (start, wake word, when): what started that satellite's current run.
        self._starts: dict[str, tuple[str, str, float]] = {}
        # device_id > (calibrate command, when): started once the reply announcing it has played.
        self._calibrations: dict[str, tuple[dict, float]] = {}

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self.hass.bus.async_listen(START_EVENT, self._on_start))
        self.async_on_remove(self.hass.bus.async_listen(CALIBRATION_DONE_EVENT, self._on_calibration_done))
        self.async_on_remove(
            self.hass.bus.async_listen(EVENT_STATE_CHANGED, self._on_satellite_state, event_filter=_satellite_moved)
        )

    @callback
    def _on_satellite_state(self, event: Event[EventStateChangedData]) -> None:
        """A satellite started listening or went idle: the Voice Loop pauses or plays its dot's music,
        and may want a voice training beep."""
        entry = er.async_get(self.hass).async_get(event.data["entity_id"])
        if entry is None or not entry.device_id:
            return
        state = event.data["new_state"].state
        self.hass.async_create_background_task(
            self._post_music(entry.device_id, entry.entity_id, state), f"{self.entity_id} music {state}"
        )
        if state == "idle" and (pending := self._calibrations.pop(entry.device_id, None)):
            command, at = pending
            if time.monotonic() - at <= CALIBRATION_START_KEEP_SECONDS:
                self.hass.async_create_background_task(
                    self._start_calibration(entry.device_id, command), f"{self.entity_id} calibrate"
                )

    def _esphome_entry(self, device_id: str):
        device = dr.async_get(self.hass).async_get(device_id)
        for entry_id in device.config_entries if device else ():
            entry = self.hass.config_entries.async_get_entry(entry_id)
            if entry is not None and entry.domain == "esphome":
                return entry
        return None

    async def _start_calibration(self, device_id: str, command: dict) -> None:
        """The dot's own action: its next wakes are calibration takes."""
        entry = self._esphome_entry(device_id)
        name = str(entry.data.get("device_name") or "") if entry else ""
        action = f"{name.replace('-', '_')}_{CALIBRATE_ACTION}"
        if not name or not self.hass.services.has_service("esphome", action):
            _LOGGER.warning("Housemate calibration: device %s has no %s action", device_id, CALIBRATE_ACTION)
            return
        await self.hass.services.async_call(
            "esphome", action,
            {"takes": int(command.get("takes") or 8), "timeout_ms": int(command.get("timeout_ms") or 120000)},
        )

    @callback
    def _on_calibration_done(self, event: Event) -> None:
        if device_id := event.data.get("device_id"):
            self.hass.async_create_background_task(
                self._calibration_done(device_id, int(event.data.get("takes") or 0)), f"{self.entity_id} calibrated"
            )

    async def _calibration_done(self, device_id: str, takes: int) -> None:
        """The dot's session is over: the Voice Loop takes the takes and says what to announce."""
        entry = self._esphome_entry(device_id)
        host = str(entry.data.get("host") or "") if entry else ""
        satellite = next((e.entity_id for e in er.async_entries_for_device(er.async_get(self.hass), device_id)
                          if e.domain == "assist_satellite"), None)
        if not host or satellite is None:
            return
        try:
            async with async_get_clientsession(self.hass).post(
                self._calibration_url, json={"device_id": device_id, "host": host, "takes": takes},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as response:
                response.raise_for_status()
                say = str((await response.json()).get("say") or "")
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            _LOGGER.warning("Housemate calibration hook unreachable at %s: %s", self._calibration_url, err)
            return
        if say:
            await self.hass.services.async_call(
                "assist_satellite", "announce", {"entity_id": satellite, "message": say, "preannounce": False}
            )

    async def _post_music(self, device_id: str, satellite: str, state: str) -> None:
        try:
            async with async_get_clientsession(self.hass).post(
                self._music_url, json={"device_id": device_id, "state": state}, timeout=aiohttp.ClientTimeout(total=5)
            ) as response:
                response.raise_for_status()
                beep = state == "idle" and response.status == 200 and bool((await response.json()).get("beep_then_listen"))
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            _LOGGER.debug("Housemate music hook unreachable at %s: %s", self._music_url, err)
            return
        if beep:
            await self._beep_then_listen(satellite)

    async def _beep_then_listen(self, satellite: str) -> None:
        """Voice training: the sentence has been said; the satellite beeps (a file, so any TTS) and listens."""
        try:
            await self.hass.services.async_call(
                "assist_satellite", "start_conversation",
                {"entity_id": satellite, "start_media_id": TRAINING_BEEP_URL, "preannounce": False},
                blocking=True,
            )
        except HomeAssistantError as err:
            _LOGGER.warning("Housemate voice training: %s could not beep and listen: %s", satellite, err)

    @callback
    def _on_start(self, event: Event) -> None:
        if device_id := event.data.get("device_id"):
            self._starts[device_id] = (
                str(event.data.get("start") or ""),
                str(event.data.get("wake_word") or ""),
                time.monotonic(),
            )

    def _take_start(self, device_id: str | None) -> tuple[str, str]:
        """The run's start, once: a follow-up in the same run has none and is taken as said."""
        start, wake_word, at = self._starts.pop(device_id, ("", "", 0.0)) if device_id else ("", "", 0.0)
        return (start, wake_word) if time.monotonic() - at <= START_KEEP_SECONDS else ("", "")

    async def _ha_intent(
        self, user_input: conversation.ConversationInput, chat_log: conversation.ChatLog, text: str
    ) -> conversation.ConversationResult:
        """Words the Voice Loop handed back (timers, asst M5): HA's own agent runs them on the satellite,
        so the timer belongs to it and rings there. The reply is spoken by the pipeline's TTS."""
        result = await conversation.async_converse(
            self.hass,
            text=text,
            conversation_id=None,
            context=user_input.context,
            language=user_input.language,
            agent_id=conversation.HOME_ASSISTANT_AGENT,
            device_id=user_input.device_id,
            satellite_id=user_input.satellite_id,
        )
        speech = result.response.speech.get("plain", {}).get("speech", "")
        chat_log.async_add_assistant_content_without_tools(
            conversation.AssistantContent(agent_id=self.entity_id, content=speech)
        )
        return conversation.ConversationResult(
            response=result.response, conversation_id=chat_log.conversation_id, continue_conversation=False
        )

    @property
    def supported_languages(self) -> Literal["*"]:
        return MATCH_ALL

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        done: dict[str, Any] = {}
        start, wake_word = self._take_start(user_input.device_id)
        body = {
            "text": user_input.text,
            "device_id": user_input.device_id,
            "satellite_id": user_input.satellite_id,
            "conversation_id": chat_log.conversation_id,
            "start": start,
            "wake_word": wake_word,
        }
        session = async_get_clientsession(self.hass)
        try:
            async with session.post(
                self._url, json=body, timeout=aiohttp.ClientTimeout(total=TURN_TIMEOUT_SECONDS)
            ) as response:
                response.raise_for_status()
                async for _content in chat_log.async_add_delta_content_stream(
                    self.entity_id,
                    turn_deltas(response.content, done, _speaking_call, _speaking_result),
                ):
                    pass
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.warning("Housemate turn API unreachable at %s: %s", self._url, err)
            done = {"reply_text": UNREACHABLE_LINE, "continue": False}
            chat_log.async_add_assistant_content_without_tools(
                conversation.AssistantContent(agent_id=self.entity_id, content=UNREACHABLE_LINE)
            )

        command = done.get("endpoint_command")
        if isinstance(command, dict) and command.get("type") == "calibrate" and user_input.device_id:
            self._calibrations[user_input.device_id] = (command, time.monotonic())
        if done.get("status") == "ha_intent" and done.get("heard_text"):
            return await self._ha_intent(user_input, chat_log, str(done["heard_text"]))

        response_intent = intent.IntentResponse(language=user_input.language)
        response_intent.async_set_speech(str(done.get("reply_text") or ""))
        return conversation.ConversationResult(
            response=response_intent,
            conversation_id=chat_log.conversation_id,
            continue_conversation=bool(done.get("continue")),
        )


@callback
def _satellite_moved(data: EventStateChangedData) -> bool:
    """An Assist satellite moved into listening or idle."""
    new, old = data["new_state"], data["old_state"]
    return (
        data["entity_id"].startswith("assist_satellite.")
        and new is not None
        and new.state in MUSIC_STATES
        and (old is None or old.state != new.state)
    )


def _speaking_call() -> llm.ToolInput:
    return llm.ToolInput(tool_name=SPEAKING_TOOL, tool_args={}, external=True)


def _speaking_result(call: llm.ToolInput) -> dict:
    return {
        "role": "tool_result",
        "tool_call_id": call.id,
        "tool_name": SPEAKING_TOOL,
        "result": llm.ToolResult(data={}),
    }
