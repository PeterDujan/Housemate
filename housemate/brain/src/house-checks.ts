import type { AssistSetup } from "./assist-setup.js";

/*
 * The page's Checks: one code-built list of what works and what does not, each line with a plain
 * reason and where to fix it (a page section, or a Home Assistant page). The Chat tab reads the same
 * list (`read_housemate` section `checks`), so the page and chat agree.
 */

export type CheckState = "ok" | "bad" | "warn";

export interface CheckFix {
  readonly label: string;
  /** A section of this page ("system", "people", ...). */
  readonly view?: string;
  /** A Home Assistant page, by its path ("/config/voice-assistants/assistants"). */
  readonly ha?: string;
}

export interface HouseCheck {
  readonly id: string;
  readonly state: CheckState;
  readonly title: string;
  readonly why: string;
  readonly fix: CheckFix | null;
}

export interface HouseChecks {
  readonly ok: true;
  readonly checks: readonly HouseCheck[];
  /** Lines that need fixing (bad), and the ones worth a look (warn). */
  readonly bad: number;
  readonly warn: number;
}

export interface HouseCheckInput {
  readonly name: string;
  readonly signIn: { readonly backend: string; readonly signedIn: boolean };
  /** The app's hearing and voice choices; null outside a Home Assistant app. */
  readonly speech: { readonly hearing: string; readonly voice: string } | null;
  /** null when Home Assistant is not connected. */
  readonly assist: AssistSetup | null;
  readonly house: {
    readonly power: string | null;
    readonly powerName: string | null;
    readonly musicPlayers: number;
    /** Speaker device id to its Music Assistant player. */
    readonly speakerMusic: Readonly<Record<string, string | null>>;
  } | null;
  readonly people: readonly { readonly id: string; readonly name: string; readonly linked: boolean }[];
  /** Household ids with a trained voice; null when the voice could not say. */
  readonly trained: readonly string[] | null;
  readonly speakerId: boolean;
  /** Error lines in the app's log in the last hour; null when the log could not be read. */
  readonly logErrors: { readonly count: number; readonly last: string | null } | null;
}

const VOICE_ASSISTANTS = "/config/voice-assistants/assistants";
const INTEGRATIONS = "/config/integrations/dashboard";

export function buildHouseChecks(input: HouseCheckInput): HouseChecks {
  const { name, assist } = input;
  const checks: HouseCheck[] = [];
  const add = (id: string, state: CheckState, title: string, why: string, fix: CheckFix | null = null) => checks.push({ id, state, title, why, fix });

  const vendor = input.signIn.backend === "codex" ? "Codex" : "Claude";
  if (input.signIn.backend === "off") add("ai", "ok", "AI is off", "House questions are still answered. Open chat about anything else needs an AI account.", { label: "AI settings", view: "system" });
  else if (input.signIn.signedIn) add("ai", "ok", `Signed in to ${vendor}`, "Open chat works.");
  else add("ai", "bad", `Not signed in to ${vendor}`, "House questions still work, but open chat can't answer until you sign in.", { label: "Sign in", view: "system" });

  if (!assist) {
    add("home_assistant", "bad", "Home Assistant not connected", `${name} can't read the house right now. Restart Housemate; if it stays, check the app's log.`);
  } else {
    const hearing = input.speech?.hearing ?? "home_assistant";
    const voice = input.speech?.voice ?? "home_assistant";
    if (hearing === "home_assistant") {
      if (assist.stt.length) add("stt", "ok", "Speech to text found", `Home Assistant's ${assist.stt[0]!.name} turns speech into words${assist.stt.length > 1 ? ` (${assist.stt.length} found)` : ""}.`);
      else add("stt", "bad", "No speech to text in Home Assistant", `${name} falls back to its own basic hearing. Add Whisper or Home Assistant Cloud in Home Assistant.`, { label: "Integrations", ha: INTEGRATIONS });
    }
    if (voice === "home_assistant") {
      if (assist.tts.length) add("tts", "ok", "Text to speech found", `Home Assistant's ${assist.tts[0]!.name} speaks the replies${assist.tts.length > 1 ? ` (${assist.tts.length} found)` : ""}.`);
      else add("tts", "bad", "No text to speech in Home Assistant", `${name} falls back to a basic robot voice. Add Piper or Home Assistant Cloud in Home Assistant.`, { label: "Integrations", ha: INTEGRATIONS });
    }
    if (assist.hearing && assist.voice) add("wyoming", "ok", `${assist.hearing.name} and ${assist.voice.name} added`, "Home Assistant can hear and speak through Housemate.");
    else add("wyoming", "bad", `${name} Hearing and Voice not added`, "In Home Assistant, Settings > Devices & services: add the Wyoming one it found (Discovered).", { label: "Devices & services", ha: INTEGRATIONS });
    if (assist.agent) add("agent", "ok", "Housemate Brain added", `Home Assistant's voice assistants can use ${assist.agentName ?? name}.`);
    else add("agent", "bad", "Housemate Brain not added", "Install Housemate Brain from HACS, restart Home Assistant, then add it under Settings > Devices & services (Discovered).", { label: "Devices & services", ha: INTEGRATIONS });

    if (!assist.speakers.length) {
      add("speakers", "warn", "No voice speakers yet", "Add a voice speaker to Home Assistant (like a Home Assistant Voice or an ESPHome speaker), then come back.");
    }
    for (const speaker of assist.speakers) {
      if (speaker.usesHousemate) add(`speaker:${speaker.id}`, "ok", `${speaker.name} uses ${name}`, `Its voice assistant is ${speaker.assistant}.`);
      else {
        add(`speaker:${speaker.id}`, "bad", `${speaker.name} doesn't use ${name} yet`,
          `${speaker.assistant ? `It uses ${speaker.assistant}. ` : ""}${pipelineHelp(name, assist)} Then pick it as this speaker's Assistant on its device page.`,
          speaker.deviceId ? { label: "Speaker's page", ha: `/config/devices/device/${speaker.deviceId}` } : { label: "Voice assistants", ha: VOICE_ASSISTANTS });
      }
      if (input.house) {
        const player = input.house.speakerMusic[speaker.deviceId ?? ""];
        if (player) add(`music:${speaker.id}`, "ok", `${speaker.name} plays music`, "It has a Music Assistant player.");
        else add(`music:${speaker.id}`, "warn", `${speaker.name} has no music player`, input.house.musicPlayers
          ? "Pick its Music Assistant player on the House page."
          : "Music needs Music Assistant in Home Assistant.", input.house.musicPlayers ? { label: "House", view: "house" } : null);
      }
    }
    if (assist.error) add("assistants", "warn", "Couldn't read the voice assistants", `Home Assistant said: ${assist.error}.`);
  }

  if (!input.people.length) add("people", "bad", "Nobody added yet", "Add who lives here, so everyone else is treated as a guest.", { label: "People", view: "people" });
  for (const person of input.people) {
    const trained = input.trained?.includes(person.id) ?? false;
    if (!person.linked) add(`person:${person.id}`, "bad", `${person.name} isn't linked`, "Link them to their Home Assistant person, so it knows who is home.", { label: "People", view: "people" });
    else if (input.speakerId && input.trained && !trained) add(`person:${person.id}`, "warn", `${person.name}'s voice isn't trained`, "Train it so their voice is known on the speakers.", { label: "People", view: "people" });
    else add(`person:${person.id}`, "ok", `${person.name} is set up`, input.speakerId && trained ? "Linked, and their voice is trained." : "Linked to their Home Assistant person.");
  }

  if (input.house) {
    if (input.house.power) add("power", "ok", "House power found", `It reads ${input.house.powerName ?? input.house.power}.`);
    else add("power", "warn", "No house power sensor", "Questions about the house's power have nothing to read. Pick one on the House page, if you have one.", { label: "House", view: "house" });
  }

  if (input.logErrors) {
    if (!input.logErrors.count) add("log", "ok", "No errors in the last hour", "The app's log is clean.");
    else add("log", "bad", `${input.logErrors.count} error${input.logErrors.count === 1 ? "" : "s"} in the last hour`,
      `${input.logErrors.last ? `Latest: ${input.logErrors.last}. ` : ""}Read the log in Home Assistant: Settings > Apps > Housemate > Log.`);
  }

  return {
    ok: true,
    checks,
    bad: checks.filter((check) => check.state === "bad").length,
    warn: checks.filter((check) => check.state === "warn").length,
  };
}

/** How to make a voice assistant that uses the app, with the names Home Assistant shows. */
export function pipelineHelp(name: string, assist: Pick<AssistSetup, "agentName" | "hearing" | "voice">): string {
  return `In Settings > Voice assistants, add an assistant with conversation agent ${assist.agentName ?? name}, speech-to-text ${assist.hearing?.name ?? `${name} Hearing`} and text-to-speech ${assist.voice?.name ?? `${name} Voice`}.`;
}

const LOG_ERROR = /\b(?:error|exception|traceback)\b/i;
const LOG_NOISE = /ExperimentalWarning|no errors?\b/i;
const LOG_STAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? \S+ \S+: (.*)$/;

/** Error lines in the app's journal log (Supervisor's text/x-log: UTC stamps) since `since`. */
export function recentLogErrors(log: string, since: Date, hide: (line: string) => string): { readonly count: number; readonly last: string | null } {
  let count = 0;
  let last: string | null = null;
  for (const raw of log.split("\n")) {
    const match = LOG_STAMP.exec(raw.trimEnd());
    if (!match) continue;
    if (Date.parse(`${match[1]}T${match[2]}Z`) < since.getTime()) continue;
    // eslint-disable-next-line no-control-regex
    const line = match[3]!.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!LOG_ERROR.test(line) || LOG_NOISE.test(line)) continue;
    count += 1;
    last = hide(line).slice(0, 200);
  }
  return { count, last };
}
