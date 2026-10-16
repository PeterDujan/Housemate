# Housemate

A voice-first assistant that lives in your house. The speakers in your house (Home Assistant
Assist satellites, Housemate speakers) send their turns here; Housemate hears the words, works
out who is talking, answers (most answers come straight from your house, the rest from the AI you
choose), and speaks the reply. Each house has its own people, personality and settings.

## What it needs

- **A 64-bit Intel or AMD box** running Home Assistant OS or Supervised (a mini PC, NUC or
  virtual machine). Raspberry Pi and other ARM boards are not supported yet.
- **Highly suggested: your own AI account** (Claude or Codex), at least while you set up: the
  Chat tab can then set things up and fix them for you. Without one, everything about your house
  still answers, but open chat, the Chat tab and learning from conversations are off. The full
  list: [with and without an AI account](FEATURES.md#with-and-without-an-ai-account).
- **Nothing else.** It hears and speaks with whatever speech-to-text and text-to-speech your Home
  Assistant already has.

## Setting up

1. **Install and start.** On the Info tab, start the app and turn on **Show in sidebar**.
2. **Open Housemate in the sidebar.** It has already looked over your Home Assistant and set
   itself up from it. **Finish setting up** on the Overview lists anything left; each step opens
   the right section:
   - **Assistant**: its name, pronoun, personality and spoken words (greeting, goodbye, and the
     stop phrase, made from its name).
   - **People**: who lives here, linked to their Home Assistant people. Then **Train voice** for
     each person, so it knows who is talking.
   - **System**: sign the AI in (below; highly suggested), and the app's settings.
   A new name or new people take a **Restart Housemate** (the button is on the page).
3. **Hearing and voice in Home Assistant.** Settings > Devices & services > Discovered shows the
   Wyoming service: add it (your assistant's Hearing and Voice).
4. **The brain in Home Assistant.** Install **Housemate Brain** from HACS and restart Home
   Assistant. It is found by itself (Discovered, under your assistant's name): add it.
5. **A voice assistant.** Settings > Voice assistants > Add: conversation agent your assistant,
   speech-to-text its Hearing, text-to-speech its Voice. Give it to your speakers. The wake word
   is set on each speaker, not by the name.

The app never writes into your Home Assistant configuration.

### Signing the AI in

- **Claude**: on any computer with Claude Code, run `claude setup-token` with your own Claude
  account and paste the token into System > Settings (or use your own Anthropic API key).
- **Codex**: System > Sign in with your OpenAI account, or your own OpenAI API key.

Every account and key is yours; nothing is billed through us.

## What it set up by itself

The **House** page lists what Housemate uses from your Home Assistant, found from your Energy
dashboard, devices and people: whole-house power and energy, solar and battery, each device's
power sensor, a monthly electricity budget, the doors and locks it watches, the robot vacuum,
weather, calendars, who lives here, and the Music Assistant player each speaker plays music on.
Change any of it there; press **Save** under a block. Anything new in Home Assistant is picked up
by itself (daily, or **Look again**). Routines (when people usually leave and get home) are
learned from your house's own history.

## The Chat tab

The Chat tab is your assistant with the keys to the app. Ask it to find, set or fix things the
way you would ask a person: "use the Shelly for house power", "untick the bins calendar", "change
your greeting to G'day", "why isn't music working?". It reads the page and the app's own log,
says what it will change, and changes it only when your next message is **yes**. It needs the AI
signed in. It never takes keys or tokens (put those in System > Settings), and it cannot change
Housemate's own program: that comes with each update.

## Hearing and voice

By default Housemate hears and speaks through your Home Assistant's own engines, picking the best
it finds (Home Assistant Cloud first, then local ones such as Whisper and Piper). It says what it
picked in its log. Choose another in System > Settings:

| Choice | Fast? | Leaves the house | Notes |
| --- | --- | --- | --- |
| Hearing: Home Assistant (default) | waits for silence | depends on the engine | local Whisper stays home |
| Hearing: Deepgram | fastest (hears the end of a sentence) | your words, to Deepgram | paid per minute |
| Hearing: ElevenLabs, Inworld | waits for silence | your words, to them | paid |
| Hearing: Whisper on this box | waits for silence, slower on small boxes | nothing | free |
| Voice: Home Assistant (default) | whole sentences, later start, no tone | depends on the voice | Piper stays home |
| Voice: Fish | starts while the reply is written; follows tone | the reply text, to Fish | paid, your own voice |
| Voice: basic | instant, robotic | nothing | emergencies |

**Words to listen for** only help Deepgram, ElevenLabs and Inworld.

## When something isn't working

Ask the Chat tab first ("why isn't the vacuum answering?"): it reads the status and the log for
you. The full log is on the app's Log tab.

## Your data

Everything that is your house's (people, personality, memories, voice profiles, speakers,
history, settings) lives in this app's own storage on this box and goes into HA's backups. Keep
backups encrypted (HA's default). Nothing is sent to us: no telemetry, no crash reports. The only
things that leave are what the engines you picked need (see the table).

One exception: questions other apps or agents leave for the household sit in
`/share/housemate/questions` (shared, so they can write there), outside the app's backups.

Updates replace the program only, never your data. The app refuses to open data written by a
newer version rather than damage it; restore the backup taken before the downgrade instead.

## Advanced settings

`settings.json` in this app's folder (`/addon_configs/<this app>/`, from Samba or the File
editor) takes any Voice Loop setting the screen does not show. The settings screen wins over it,
and an empty key on the screen leaves the file's value alone.

## Moving in from another box

Put the old box's files in an `import` folder inside this app's folder (or in
`/share/housemate/import`): the brain's data under `brain/`, the voice's home directory under
`voice/` (for example `voice/.local/share/housemate-voice/training/profiles/...`). A `settings.json` at the top of it
becomes the advanced settings file when there is none yet.
On the next start they are copied in, never over anything already here, and the folder is
renamed `import-done-<time>`. Delete that copy once everything works: it may hold keys.
Moving in again over data already here: put an empty `.replace` file in the `import` folder;
each file it replaces is first moved to `replaced-<time>` in the app's data.

## Ports

| Port | What | Who connects |
| --- | --- | --- |
| 8196 | speakers | Housemate speakers on your network |
| 3005 | the brain and its page | Home Assistant (the page), your network |
| 10310 | Wyoming hearing and voice | Home Assistant, on this box only |
| 10311 | turn link | the Housemate Brain integration, on this box only |
