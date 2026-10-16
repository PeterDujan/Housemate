# What Housemate does

Housemate is a voice assistant that knows your house properly. Most assistants can switch a light.
Housemate knows the house: what's using power, who's home, which door is open, what's on the
calendar, who is talking to it, and what it was told last week. It answers house questions from
your Home Assistant straight away, with no AI needed. If you sign in your own Claude or
ChatGPT account, it can also chat about anything else.

Everything below works out of the box. It's found from your own Home Assistant, and you can change
any of it on the Housemate page.

## It sets itself up

- **Reads your Home Assistant on first start.** Whole-house power and energy from your Energy
  dashboard, solar and home battery, each device's power sensor, doors and locks, the robot vacuum,
  weather, calendars, the people who live here, and which Music Assistant player sits beside each
  speaker.
- **Keeps up with your house.** It checks every day for anything new, or straight away when you
  press **Look again**.
- **Learns your routines** from your house's own history: when each person usually leaves and gets
  home, on weekdays and on weekends.
- **Uses the speech your Home Assistant already has.** It picks Home Assistant Cloud or local
  Whisper and Piper by itself, so it can hear and talk with no extra accounts or keys.

## Your house, by voice

- **Power and energy.** "What's using the most power?", "How much did we use yesterday?", "How's
  the solar going?", "Are we on track for the month?" It covers live readings, rankings, history,
  comparisons and a monthly electricity budget.
- **Doors, locks and security.** "Is everything locked?", "Is the garage open?", "How long was the
  garage open?", "When did the doorbell last ring?"
- **Who's home.** "Who's home?", "Is Sam home yet?", "When does Alex usually get home?"
- **Calendars and plans.** "Have I got anything this week?", "What's on tomorrow?"
- **Weather.** Now, today and the coming hours and days, from your Home Assistant weather.
- **Catch-up.** "What did I miss?" It sums up what happened while you were out: doors, alarms,
  visitors and events.
- **History.** Follow-ups work: "And yesterday?", "What about last week?", "Why?"
- **Quick maths.** "What's 27 percent of 127?"

## It does things

- **Switches devices.** It controls lights, switches, the heating and the air-con, but only the
  ones you have exposed to Assist, and only for the household. "Turn on the office lights", "Put
  the aircon on 22".
- **Music on the speaker you're talking to**, through Music Assistant. "Play some Fleetwood
  Mac", "Skip", "Turn it down", "What's this?", "Shuffle it", "Add this to my running playlist",
  "Move it to the kitchen".
- **Robot vacuum**, through its own Home Assistant integration. "Vacuum the lounge", "Clean the
  kitchen on turbo".
- **Alarms.** "Set an alarm for 6:30." It rings on the speaker you asked from.
- **Smart reminders.** "Remind me when Sam gets home", "Tell me if it's going to rain before soccer",
  "Let me know when the garage opens." They're tied to things happening, not just to a time.
- **Movies and TV.** If you use Plex, Radarr, Sonarr or Overseerr, it can answer "What's new?",
  "Find me something to watch tonight" and "How long is that film?"

## It knows who's talking

- **Speaker recognition.** Train each person's voice once: ten sentences, read out on any speaker
  from the People page. After that it knows who is talking, so "my calendar" and "am I home?" mean
  the right person.
- **The household shares, strangers don't.** Everyone who lives here gets the household's answers.
  A voice it doesn't recognise gets nothing private.

## It remembers

- **Memories from conversations.** It remembers what people tell it about themselves and uses it
  when it answers. You can review what it keeps on the page, and anyone can ask it to forget
  something.
- **Corrections are kept.** Tell it it got something wrong and it writes the mistake down next to
  the answer it corrects, so it can be fixed instead of forgotten.
- **Long chats keep their thread.** A long conversation doesn't lose its beginning halfway through.

## It has a personality

- **Its own name, pronoun and personality**, set by you. Its stop phrase comes from its name,
  and you choose its greeting and goodbye.
- **Speaks with tone.** With the Fish voice it can sound warm, dry or sympathetic to suit the
  moment. It starts talking while the reply is still being written, so there's no awkward wait.
- **Optional: it grows.** Turn on **Grow its character** and each night it may adjust how it sees
  itself, within the rules you set. Ask it "How have you changed?"
- **Optional: it speaks up.** Turn on **Speak up on its own** and it can start a conversation when
  something matters. This starts in practice mode, so you review its ideas before it says anything
  out loud.

## Open chat (with your own AI account)

- **Chat about anything**, using your own Claude or ChatGPT/Codex sign-in. There's a monthly budget
  cap you can set.
- **Optional extras:** let chat look things up in the house, search the web (Claude), or read an
  offline copy of Wikipedia.

## With and without an AI account

Signing in an AI account is **highly suggested**, at least while you set up: the Chat tab can then
do most of the setting up and fixing for you. Housemate still runs without one (Brain: off).

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

## The Chat tab runs the app

Ask the Chat tab on the Housemate page to set or fix anything, the way you'd ask a person:

- "Use the Shelly for house power"
- "Change your greeting to G'day"
- "Stop speaking up on your own"
- "Why isn't music working?"

It reads the page and the app's own log, tells you what it will change, and changes it only when
you say **yes**. It never takes keys or passwords (those go in the settings page), and it can't
change Housemate's own program.

## Private by design

- **Your data stays on your box.** People, memories, voice profiles and settings live in the
  app's own storage and go into Home Assistant's backups.
- **No telemetry**, no crash reports and no account with us. The only things that leave the house
  are what the services you pick need: for example the words you say, if you choose a cloud
  speech service.
- **House answers need no AI.** Power, doors, people, calendars and the rest come straight from
  your Home Assistant, worked out on your box.

## Hearing and voice choices

| | Default | Options |
| --- | --- | --- |
| Hearing | Home Assistant's own speech-to-text | Deepgram (fastest), ElevenLabs, Inworld, Whisper on the box |
| Voice | Home Assistant's own text-to-speech | Fish (with tone, starts early, can be your own voice), basic |

See the [guide](DOCS.md) for what each one costs and what leaves the house.
