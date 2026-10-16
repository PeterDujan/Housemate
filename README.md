## ⚠️ This entire project was VibeCoded and is unsupported. Use at your own risk!

# Housemate

Housemate is a voice assistant for your home, built for Home Assistant. Ask it about your house
and it answers straight away: what's using power, whether the doors are locked, who's home,
what's on the calendar. It can also turn things on and off, play music, run the robot vacuum and
set reminders. It recognises each person's voice, remembers what the household tells it, and has
a name and personality you choose. If you connect your own Claude or ChatGPT account, it can
chat about anything else too.

## What it does

- **Answers questions about your house** using Home Assistant directly, with no AI needed:
  power and solar, doors and locks, who's home, calendars, the weather, and "what did I miss?"
- **Gets things done.** It switches the devices you've shared with Assist, plays music on the
  speaker you're talking to, runs the robot vacuum, and sets alarms and smart reminders
  ("tell me when Sam gets home").
- **Remembers.** It learns what matters about the people it talks to, keeps sensitive things back
  until you approve them, and can search its memory and past conversations when you ask ("what
  did I do for my birthday last year?").
- **Knows who's talking** from their voice, and keeps the household's details away from guests.
- **Has a character of its own.** It has a name, a personality, opinions and tastes, and if you
  let it, it develops a little each night from the day's conversations. Every version is kept, so
  any change is easy to roll back.
- **Is quick and cheap to run.** Everything about your house runs in code, so it's instant and
  free. The AI is only used for chatting and for learning from conversations, through your own
  Claude or ChatGPT subscription, with a monthly budget you set.
- **Sets itself up** from your Home Assistant, learns your household's routines from its history,
  and can be run from a chat window ("use the Shelly for house power", "why isn't music
  working?").
- **Keeps your data at home.** Everything stays on your own machine, and nothing is reported back.

**[See the full feature list](housemate/FEATURES.md)**

## With and without an AI account

We highly recommend connecting your own Claude or ChatGPT/Codex account, at least while you set
up, because the Chat tab can then do most of the setting up and fixing for you. Housemate still
works without one, though.

| | Without AI | With an AI account |
| --- | --- | --- |
| Setup (the House, Assistant and People pages, voice training) | Yes, by hand | Yes, and the Chat tab can do it for you |
| Questions about power, doors, people, calendars, weather and "what did I miss?" | Yes | Yes |
| Switching devices, music, the vacuum, alarms and smart reminders | Yes | Yes |
| Recognising who's talking | Yes | Yes |
| Learning your routines from the house's history | Yes | Yes |
| Remembering things when you ask it to | Yes | Yes |
| Chatting about anything | No | Yes |
| The Chat tab (changing settings, troubleshooting from the log) | No | Yes |
| Picking up facts from everyday conversation | No | Yes |
| A bit of personality in its answers | No | Yes |
| Developing its own character and tastes over time | No | Yes |
| Looking things up in the house or on the web while chatting | No | Yes |

## What's in this repository

You need both parts:

- **Housemate**, a Home Assistant app. This is the assistant itself: its brain, its hearing and its
  voice.
- **Housemate Brain**, an integration you install through HACS. It lets Home Assistant's voice
  assistants talk to Housemate.

## Before you start

You'll need:

- **Home Assistant OS or Supervised, running on a 64-bit Intel or AMD machine**, such as a mini PC,
  a NUC or a virtual machine. Raspberry Pi and other ARM boards aren't supported yet.
- **About 1 GB of free memory** for Housemate, on top of what Home Assistant uses. A machine with
  at least 4 GB is comfortable.
- **Home Assistant 2026.10 or newer.**
- **HACS.** If you don't have it yet, see [hacs.xyz](https://hacs.xyz/docs/use/).

We also highly recommend **a Claude or ChatGPT/Codex account**, at least for setup. Without one,
house questions, switching, music, alarms and voice recognition all still work, but chatting, the
Chat tab and learning from conversations are switched off. See
[With and without an AI account](#with-and-without-an-ai-account).

## Installing

**1. Add this repository to Home Assistant.**

[![Add the repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FPeterDujan%2FHousemate)

To do it by hand instead, go to Settings > Apps > Install app, open the three-dot menu in the top
right and choose Repositories. Paste `https://github.com/PeterDujan/Housemate` and press Add. (Older versions of Home Assistant
call these "Add-ons" rather than "Apps".)

**2. Install the Housemate app.** Close the Repositories window, find **Housemate** in the list
(refresh the page if it hasn't appeared yet) and press **Install**. Home Assistant builds the app
on your machine the first time, so this can take a while. Leave it to finish.

**3. Start it.** On the app's Info tab, turn on **Start on boot** and **Show in sidebar**, then
press **Start**. Give it a minute; the Log tab shows when it's running.

**4. Install Housemate Brain through HACS.**

[![Open this repository in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=PeterDujan&repository=Housemate&category=integration)

To do it by hand instead, open HACS, choose Custom repositories from the three-dot menu in the top
right, paste `https://github.com/PeterDujan/Housemate`, set the type to **Integration** and press Add. Then search HACS for
**Housemate Brain** and press **Download**.

**5. Restart Home Assistant.** Go to Settings > System, press the power button in the top right and
choose Restart Home Assistant. Housemate Brain only loads after a restart.

**6. Add the two new services Home Assistant has found.** Go to Settings > Devices & services. Under
**Discovered** you'll see two new entries:

- **Wyoming**, which is the assistant's hearing and voice. Press **Add**, then **Submit**.
- **Housemate Brain**, which is the assistant itself. Press **Add**, then **Submit**.

If either one is missing, wait a minute after the app has started and refresh the page.

**7. Open Housemate.** Click **Housemate** in the sidebar. It has already looked through your Home
Assistant and set itself up. The **Overview** page shows a **Finish setting up** list, and each
item takes you to the right place:

- **Name your assistant**: choose its name, pronoun and personality.
- **Add who lives here**: add each person and link them to their Home Assistant person. Then use
  **Train voice** for each person so it can tell who's talking.
- **Connect an AI account** (highly recommended), under System > Settings. Once that's done, the
  Chat tab can help you with everything else on the list.
- **Add Housemate Brain to Home Assistant**: in Home Assistant, go to Settings > Voice assistants
  and add an assistant that uses Housemate Brain as the conversation agent, with your assistant's
  Hearing and Voice for speech. Then assign it to your speakers.

Once you've worked through the list, you're done. If you change the assistant's name or add new
people, press **Restart Housemate** (the button is on the page).

Stuck? Ask in the **Chat** tab on the Housemate page, for example "why isn't music working?" It
checks the app's status and log for you. This needs an AI account.

For everything else, see the [full guide](housemate/DOCS.md).

## Licence

Housemate is released under the MIT licence ([LICENSE](LICENSE)). Home Assistant builds the app on
your own machine and downloads the software it needs (Debian packages such as ffmpeg and espeak-ng,
Node.js, Python packages, Claude Code and Codex) from their original sources, under their own
licences.
