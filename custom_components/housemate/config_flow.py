"""Config flow for Housemate Brain: the Housemate app announces itself; typing it in is the fallback."""

from __future__ import annotations

from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
import voluptuous as vol

from .const import CONF_HOST, CONF_NAME, CONF_PORT, DEFAULT_HOST, DEFAULT_PORT, DOMAIN, TURN_PATH
from .turn_stream import parse_line

DEFAULT_NAME = "Housemate"


class HousemateConfigFlow(ConfigFlow, domain=DOMAIN):
    """One agent per Housemate app."""

    VERSION = 1

    def __init__(self) -> None:
        self._found: dict[str, Any] = {}

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        """The app's Supervisor discovery: host, turn port and the assistant's name. Keyed by the app."""
        config = discovery_info.config
        host = str(config.get(CONF_HOST) or DEFAULT_HOST)
        port = int(config.get(CONF_PORT) or DEFAULT_PORT)
        await self.async_set_unique_id(discovery_info.slug)
        self._abort_if_unique_id_configured(updates={CONF_HOST: host, CONF_PORT: port})
        # One added by hand at the same address is this app: it is kept, and follows the app from now on.
        for entry in self._async_current_entries(include_ignore=False):
            if entry.data.get(CONF_HOST) == host and int(entry.data.get(CONF_PORT) or 0) == port:
                self.hass.config_entries.async_update_entry(entry, unique_id=discovery_info.slug)
                return self.async_abort(reason="already_configured")
        self._found = {CONF_HOST: host, CONF_PORT: port, CONF_NAME: str(config.get(CONF_NAME) or DEFAULT_NAME)}
        self.context["title_placeholders"] = {"name": self._found[CONF_NAME]}
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        found = self._found
        if user_input is not None:
            if not await _async_reachable(self, found[CONF_HOST], found[CONF_PORT]):
                return self.async_abort(reason="cannot_connect")
            return self.async_create_entry(
                title=found[CONF_NAME], data={CONF_HOST: found[CONF_HOST], CONF_PORT: found[CONF_PORT]}
            )
        return self.async_show_form(step_id="hassio_confirm", description_placeholders={"name": found[CONF_NAME]})

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host = str(user_input[CONF_HOST]).strip()
            port = int(user_input[CONF_PORT])
            await self.async_set_unique_id(f"{host}:{port}")
            self._abort_if_unique_id_configured()
            if await _async_reachable(self, host, port):
                name = str(user_input.get(CONF_NAME) or "").strip() or DEFAULT_NAME
                return self.async_create_entry(title=name, data={CONF_HOST: host, CONF_PORT: port})
            errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_NAME, default=DEFAULT_NAME): str,
                    vol.Required(CONF_HOST, default=DEFAULT_HOST): str,
                    vol.Required(CONF_PORT, default=DEFAULT_PORT): vol.All(int, vol.Range(min=1, max=65535)),
                }
            ),
            errors=errors,
        )


async def _async_reachable(flow: ConfigFlow, host: str, port: int) -> bool:
    """An empty transcript has no held audio, so the turn API answers without running a turn."""
    session = async_get_clientsession(flow.hass)
    try:
        async with session.post(
            f"http://{host}:{port}{TURN_PATH}", json={"text": ""}, timeout=aiohttp.ClientTimeout(total=10)
        ) as response:
            response.raise_for_status()
            event = parse_line(await response.text())
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return False
    return bool(event and event.get("event") == "done")
