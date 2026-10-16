# What Housemate does

Most voice assistants can switch a light on. Housemate knows your house. It knows what's using
power, which doors are open, who's home, what's on the calendar, who is talking to it and what
they told it last week. It answers questions about your house straight from Home Assistant, in
code, so those answers are quick, accurate and free. If you connect your own Claude or ChatGPT
account, it can also chat about anything at all, and it gets to know your household better the
more you talk to it.

Everything below works as soon as it's installed. It finds what it needs in your own Home
Assistant, and you can change any of it on the Housemate page.

## A memory that actually remembers

- **It learns from conversations.** After a chat, it picks out what's worth remembering about the
  people in it (a new job, a favourite food, a trip coming up) and keeps it. Every fact is checked
  against what was actually said, so it never "remembers" something nobody told it.
- **Sensitive things wait for your say-so.** Anything about health, money, relationships, children
  or someone else's whereabouts is held back until the owner approves it, using Keep and Bin
  buttons on their phone or on the Housemate page.
- **It remembers on demand.** Ask "what did I do for my birthday last year?", "what did we talk
  about on Tuesday?" or "did I mention the plumber?" and it searches its memory and your past
  conversations for the answer.
- **It uses what it knows when it matters.** Mention your partner or the holiday you've been
  planning and it brings in what it knows about them. Unrelated memories stay out of the way, so
  it doesn't keep dragging up old topics.
- **It can keep things for good.** What people say about themselves can be kept permanently
  instead of fading after 90 days.
- **You stay in charge.** "Forget what I said about that" works, and the page lets you review,
  keep or remove anything it has learned.
- **Long conversations keep their thread.** Even a long chat doesn't lose its beginning.

## A character that grows

- **Its own name, pronoun and personality**, which you set. Its greeting, its goodbye and the
  phrase that ends a conversation are yours to choose.
- **It grows over time** (optional). Each night it reads the day's conversations and may adjust a
  little of how it sees itself, within firm rules: it never invents facts about the household,
  never takes on worries or wants, and only changes a small part of itself at a time. Every
  version is kept, you can see what changed each night and why, and you can roll back to any
  earlier version.
- **It picks up its own ways of speaking**, and drops the ones that don't work.
- **It has real opinions and tastes**: favourite films, music, colours and more. It sticks to them,
  defends them, and only changes its mind when someone gives it a good reason. A weekly review
  weighs up what it has heard and played, and you can see what changed. Ask "how have you
  changed?" and it tells you, from its own history.
- **It's honest about itself.** Ask what it is, whether it's conscious, how its memory works or
  which AI model is behind it, and you get straight, consistent answers.

## Your house, by voice

- **Power and energy.** "What's using the most power?", "How much did we use yesterday?",
  "How's the solar going?", "Are we on track for the month?" It handles live readings, rankings,
  history, comparisons ("more than last week?") and a monthly electricity budget, with a forecast
  of where the month will end up.
- **Doors, locks and security.** "Is everything locked?", "Is the garage open?", "How long was the
  garage open?", "When did the doorbell last ring?"
- **Anything in your house.** "Is the heater on?" ("No, but the aircon is."), "What's the
  bathroom humidity?", "Which lights have been on longest?", "Was the back door open this
  morning?" It reads current and past states for any device you have.
- **Who's home**, and when people usually leave and get home, learned from your house's own
  history. It reports home or away, never anyone's exact location.
- **Calendars, to-do lists and plans.** "Have I got anything this week?", "What's on tomorrow?",
  "What's on the shopping list?", "When's bin night?"
- **Weather**, now and for the coming hours and days, plus advice such as "Do I need a jacket?"
  It also remembers what each person likes to wear in different conditions.
- **Catch-up.** "What did I miss?" sums up what happened while you were out: doors, the doorbell,
  alarms, visitors and events. "What happened today?" works too.
- **Natural follow-ups.** "And yesterday?", "What about the kitchen?", "Why?", "What do you
  mean?", "Say that again." If something is ambiguous it asks which one you meant, and "I meant
  the lamp, not the main light" works the way you'd expect.
- **Quick maths and the time.** "What's 27 percent of 127?", "What's the square root of 144?",
  "What's the time?"
- **General knowledge.** It answers from an offline copy of Wikipedia if you add one, and from
  the AI otherwise.

## It does things

- **Switches devices.** Lights, switches, locks, the heating and the air-con: whatever you have
  shared with Assist in Home Assistant, and only for the household ("Turn on the office lights",
  "Put the aircon on 22"). Guests can only control lights.
- **Music on the speaker you're talking to**, through Music Assistant: "Play some Fleetwood Mac",
  "Skip", "Go back", "Turn it down", "What's this?", "Shuffle it", "Play a different version",
  "Add this to my running playlist", "Move it to the kitchen". It picks the original studio
  recording over live and karaoke versions, and pauses the music while it's listening to you.
- **Robot vacuum.** Start, pause, stop, resume or send it home, and ask what it's doing.
  Room-by-room cleaning ("vacuum the lounge on turbo") works once its room list is set up.
- **Alarms and timers.** "Set an alarm for 6:30" rings on the speaker you asked from, and timers
  use Home Assistant's own.
- **Smart reminders** tied to things happening, not just to a time: "Remind me when Sam gets
  home", "Tell me if it's going to rain before soccer", "Let me know when the garage opens."
- **Movies and TV.** If you use Plex, Radarr, Sonarr or Overseerr, it can tell you what's new and
  what you haven't watched, recommend something for tonight, and tell you how long a film is.

## It knows who's talking

- **Speaker recognition.** Train each person's voice once by reading ten sentences on any
  speaker. After that it knows who is talking, so "my calendar", "am I home?" and "remind me" mean
  the right person.
- **The household shares, guests don't.** Everyone who lives with you gets the household's
  answers and memories. A voice it doesn't recognise gets general help, never anything private,
  and is never told it's in a "guest mode".
- **Each person can have their own pace.** In the advanced settings, someone who pauses
  mid-sentence can be given more time before it decides they've finished.

## Built to be quick and cheap to run

- **Code first, AI second.** Questions about your house, device control, music, alarms and
  reminders are all handled in code, so they're instant, cost nothing and don't depend on an AI
  service. The AI is only used for open chat and the jobs that genuinely need it.
- **Uses your existing subscription.** It signs in with your own Claude or ChatGPT account, the
  same way the official Claude Code and Codex apps do, so there's no per-word API bill unless you
  choose to use an API key.
- **A monthly budget you set.** Once it's spent, the AI stops for the rest of the month, and
  everything that runs in code carries on.
- **Lean requests.** Only the memories that matter to the current conversation are sent to the
  AI, answers are kept short, and web searches are capped per turn. Every AI call is logged.
- **Fast replies.** It keeps an AI session warmed up and ready, starts speaking while the reply is
  still being written, and says "Let me check" when a lookup will take a moment.

## The Chat tab runs the app

Ask the Chat tab on the Housemate page to set or fix anything, the way you'd ask a person:

- "Use the Shelly for house power"
- "Change your greeting to G'day"
- "Stop speaking up on your own"
- "Why isn't music working?"

It reads the page and the app's own log, tells you what it's going to change, and only changes it
when you say **yes**. It never takes keys or passwords (those go in System, Settings), and it
can't change Housemate's own program.

## It sets itself up

- **It reads your Home Assistant on first start**: whole-house power and energy from your Energy
  dashboard, solar and home battery, each device's power sensor, doors and locks, the robot
  vacuum, weather, calendars, the people who live with you, and which Music Assistant player is
  next to each speaker.
- **It keeps up with your house.** It checks every day for anything new, or straight away when
  you press **Look again**.
- **It uses the speech Home Assistant already has**, picking Home Assistant Cloud or local
  Whisper and Piper by itself, so it can hear and talk without extra accounts or keys.
- **Easy to correct.** Anything it found can be changed on the House page, and your own names for
  things ("Sam's computer") can be added on the Names page.

## Sounding natural

- **Tone of voice.** With the Fish voice it can sound warm, dry, amused or concerned to suit the
  moment, and it starts talking while the reply is still being written.
- **It keeps listening when it asks you something**, so you can answer without saying its name
  again.
- **Corrections are kept.** If you tell it that it got something wrong, it writes the mistake down next to
  the answer, and next time it asks what you meant instead of guessing.
- **Coming soon: speaking up on its own.** It can already notice things worth mentioning, such as
  a door left open or rain on the way, but speaking them aloud isn't available yet.

## Open chat (with your own AI account)

- **Chat about anything**, using your own Claude or ChatGPT/Codex account, with a monthly budget
  cap you set.
- **Optional extras:** let chat look things up in the house, search the web (Claude only), or read
  an offline copy of Wikipedia.

## With and without an AI account

Connecting an AI account is **highly recommended**, at least while you set up, because the Chat
tab can then do most of the setting up and fixing for you. Housemate still works without one.

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

## Private by design

- **Your data stays on your machine.** People, memories, voice profiles and settings live in the
  app's own storage and are included in Home Assistant's backups.
- **No telemetry**, no crash reports and no account with us. The only things that leave your home
  are what the services you choose need, such as the words you say if you pick a cloud
  speech-to-text service.
- **House questions need no AI.** Power, doors, people, calendars and the rest are answered from
  your own Home Assistant, on your own machine.

## Hearing and voice choices

| | Default | Other options |
| --- | --- | --- |
| Hearing | Home Assistant's own speech-to-text | Deepgram (fastest), ElevenLabs, Inworld, Whisper on your machine |
| Voice | Home Assistant's own text-to-speech | Fish (with tone, starts speaking sooner, can use your own voice), basic |

See the [guide](DOCS.md) for what each one costs and what leaves your home.
