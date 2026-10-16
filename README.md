## ⚠️ This entire project was VibeCoded and is unsupported. Use at your own risk!

# Housemate

A voice assistant that lives in your house. Talk to your Home Assistant speakers and it answers
from your house (lights, power, doors, calendars, music, the vacuum) and, if you sign in your own
AI account, chats about anything else. It knows who is talking, remembers the household, and has
a name and personality you choose.

## What it does

- **Answers about your house straight from Home Assistant, no AI needed**: power and solar, doors and locks, who's
  home, calendars, weather, "what did I miss?"
- **Does things**: switches what you expose to Assist, plays music on the speaker you're talking
  to, runs the robot vacuum, sets alarms and smart reminders ("tell me when Sam gets home").
- **Knows who's talking** from their voice, and remembers what the household tells it.
- **Sets itself up** from your Home Assistant, and learns your routines from its history.
- **Its own name and personality**, plus open chat about anything with your own Claude or ChatGPT
  account.
- **The Chat tab runs the app**: "use the Shelly for house power", "why isn't music working?"
- **Private**: your data stays on your box. No telemetry.

**[Everything it does: the full feature list](housemate/FEATURES.md)**

## With and without an AI account

Signing in your own Claude or ChatGPT/Codex account is **highly suggested**, at least while you
set up: the Chat tab can then do most of the setting up and fixing for you. Housemate still runs
without one.

| | Without AI (code only) | With an AI account |
| --- | --- | --- |
| Setup (House, Assistant, People pages, voice training) | Yes, by hand | Yes, and the Chat tab can do it for you |
| House questions: power, doors, people, calendars, weather, catch-up | Yes | Yes |
| Switching devices, music, the vacuum, alarms, smart reminders | Yes | Yes |
| Knowing who's talking | Yes | Yes |
| Routines learned from the house's history | Yes | Yes |
| Remembering what you tell it to remember | Yes | Yes |
| Open chat about anything | No | Yes |
| The Chat tab (change settings, troubleshoot from the log) | No | Yes |
| Learning facts from ordinary conversations | No | Yes |
| Personality touches on its answers | No | Yes |
| Growing its character, forming its own tastes | No | Yes |
| Chat that looks things up in the house or on the web | No | Yes |

This repo holds two parts, and you need both:

- **Housemate**, a Home Assistant app: the brain, its hearing and its voice.
- **Housemate Brain**, an integration (installed through HACS) that lets Home Assistant's voice
  assistants talk to it.

## Before you start

- **Home Assistant OS or Supervised, on a 64-bit Intel or AMD box** (a mini PC, NUC, or virtual
  machine). Raspberry Pi and other ARM boards are not supported yet.
- **About 1 GB of free memory** for Housemate, on top of Home Assistant (4 GB in the box is a
  comfortable minimum).
- **Home Assistant 2026.10 or newer.**
- **HACS**. If you don't have it yet: [hacs.xyz](https://hacs.xyz/docs/use/).
- **Highly suggested: a Claude or ChatGPT/Codex account**, at least while you set up. With it, the
  Chat tab on the Housemate page can set things up and fix them for you ("use the Shelly for house
  power", "why isn't music working?"). Without it, house answers, switching, music, alarms and
  voice recognition all still work, but open chat, the Chat tab and learning from conversations
  are off. See [with and without an AI account](#with-and-without-an-ai-account).

## Install

**1. Add this repository to Home Assistant.**

[![Add the repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FPeterDujan%2FHousemate)

Or by hand: Settings > Apps > Install app, then the three-dot menu (top right) > Repositories.
Paste `https://github.com/PeterDujan/Housemate` and press Add. (On older Home Assistant, "Apps" is called "Add-ons".)

**2. Install the Housemate app.** Close the Repositories box, find **Housemate** in the list
(refresh the page if it isn't there yet) and press **Install**. The app is built on your own
box the first time, so this takes a while. Leave it running.

**3. Start it.** On the app's Info tab, turn on **Start on boot** and **Show in sidebar**, then
press **Start**. Give it a minute: the Log tab shows when it is up.

**4. Install Housemate Brain through HACS.**

[![Open this repository in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=PeterDujan&repository=Housemate&category=integration)

Or by hand: HACS > three-dot menu (top right) > Custom repositories. Paste `https://github.com/PeterDujan/Housemate`, pick type
**Integration**, press Add. Then search HACS for **Housemate Brain** and press **Download**.

**5. Restart Home Assistant.** Settings > System > the power button (top right) > Restart Home
Assistant. Housemate Brain is only loaded after a restart.

**6. Add what Home Assistant found.** Settings > Devices & services. Under **Discovered** you will
see two new items:

- **Wyoming**: the assistant's hearing and voice. Press **Add**, then **Submit**.
- **Housemate Brain**: the assistant itself. Press **Add**, then **Submit**.

If either is missing, wait a minute after the app starts and refresh the page.

**7. Open Housemate.** Click **Housemate** in the sidebar. It has already looked over your Home
Assistant and set itself up from it. The **Overview** shows a **Finish setting up** list; each step
opens the right part of the page:

- **Assistant**: its name, personality and the words it says.
- **People**: who lives here and which Home Assistant person each one is. Then **Train voice**
  for each person, so it knows who is talking.
- **Sign in the AI** (highly suggested): System > Settings. Then the Chat tab can help with
  everything else on this list.
- **Voice assistant**: in Settings > Voice assistants, add an assistant with Housemate Brain as the
  conversation agent and your assistant's Hearing and Voice for speech. Give it to your speakers.

Work down that list and you're done. A new name or new people take a **Restart Housemate** (the
button is on the page).

Stuck? Ask the **Chat** tab on the Housemate page ("why isn't music working?"): it reads the app's
status and log for you. It needs the AI signed in.

Full guide: [housemate/DOCS.md](housemate/DOCS.md).

## Licence

MIT ([LICENSE](LICENSE)). The app's image is built on your own Home Assistant, which downloads the
software it needs (Debian packages such as ffmpeg and espeak-ng, Node.js, Python packages, Claude
Code, Codex) from their own sources under their own licences.
