/*
 * The app's own settings on the System page: the ones a house needs to set
 * (which AI, hearing and voice, their keys, where the house is, the approval phone) without HA's
 * Configuration tab. Read and saved through the Supervisor (`/addons/self/info` and `/options`,
 * which an app may do for itself); keys are never sent back to the page, a blank key keeps the one
 * there. The app reads its settings at start, so a save asks for a restart. Ports, folders and the
 * other advanced ones stay on the Configuration tab.
 */

export type OptionKind = "choice" | "text" | "secret" | "number" | "switch" | "list";

export interface OptionField {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly kind: OptionKind;
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
}

export const OPTION_GROUPS: readonly { readonly title: string; readonly fields: readonly OptionField[] }[] = [
  {
    title: "Brain",
    fields: [
      { key: "brain", label: "AI for open chat", kind: "choice", help: "House questions are answered without AI either way.", choices: [{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }, { value: "off", label: "Off" }] },
      { key: "model", label: "Model", kind: "text", help: "e.g. claude-sonnet-5." },
      { key: "monthly_budget_usd", label: "Monthly AI budget (USD)", kind: "number", help: "The AI stops for the rest of the month once this is spent." },
      { key: "claude_token", label: "Claude sign-in token", kind: "secret", help: "From claude setup-token, run with your own Claude account on any computer with Claude Code." },
      { key: "claude_api_key", label: "Anthropic API key", kind: "secret", help: "Instead of signing in to Claude (paid per use)." },
      { key: "openai_api_key", label: "OpenAI API key", kind: "secret", help: "Instead of signing in to Codex (paid per use)." },
    ],
  },
  {
    title: "Hearing",
    fields: [
      { key: "hearing", label: "Speech to text", kind: "choice", help: "What turns speech into words.", choices: [
        { value: "home_assistant", label: "Home Assistant" }, { value: "deepgram", label: "Deepgram" }, { value: "elevenlabs", label: "ElevenLabs" },
        { value: "inworld", label: "Inworld" }, { value: "local_whisper", label: "Whisper on this box" },
      ] },
      { key: "language", label: "Language", kind: "text", help: "e.g. en-AU." },
      { key: "deepgram_api_key", label: "Deepgram key", kind: "secret", help: "" },
      { key: "elevenlabs_api_key", label: "ElevenLabs key", kind: "secret", help: "" },
      { key: "inworld_api_key", label: "Inworld key", kind: "secret", help: "" },
      { key: "ha_stt_entity", label: "Home Assistant speech-to-text", kind: "text", help: "Empty: Home Assistant's own, picked by itself (its Cloud first, then Whisper)." },
      { key: "keyterms", label: "Words to listen for", kind: "list", help: "Names and words it should hear right, separated by commas." },
    ],
  },
  {
    title: "Voice",
    fields: [
      { key: "voice", label: "Voice", kind: "choice", help: "What speaks the replies.", choices: [{ value: "home_assistant", label: "Home Assistant" }, { value: "fish", label: "Fish Audio" }, { value: "espeak", label: "Basic (on this box)" }] },
      { key: "fish_api_key", label: "Fish Audio key", kind: "secret", help: "" },
      { key: "fish_voice_id", label: "Fish voice", kind: "text", help: "The id of the Fish voice to speak with." },
      { key: "ha_tts_entity", label: "Home Assistant text-to-speech", kind: "text", help: "Empty: Home Assistant's own, picked by itself (its Cloud first, then Piper)." },
    ],
  },
  {
    title: "The house",
    fields: [
      { key: "place", label: "Where the house is", kind: "text", help: "Suburb or town, state and country. Empty: nothing local is assumed." },
      { key: "approval_phone", label: "Approval phone", kind: "text", help: "The phone that approves sensitive memories. Empty: the owner's phone, found in Home Assistant." },
      { key: "speaker_id", label: "Know who's speaking", kind: "switch", help: "Recognise household voices (train them on the People page)." },
    ],
  },
];

const FIELDS = new Map(OPTION_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));

export interface AppOptionsBody {
  readonly ok: true;
  readonly groups: readonly { readonly title: string; readonly fields: readonly (OptionField & { readonly value: string | number | boolean | null; readonly hasValue?: boolean })[] }[];
}

export interface SupervisorAccess {
  readonly token: string | null;
  readonly fetch: typeof fetch;
}

export function supervisorAccess(env: NodeJS.ProcessEnv = process.env): SupervisorAccess {
  return { token: env.SUPERVISOR_TOKEN?.trim() || null, fetch };
}

async function currentOptions(access: SupervisorAccess): Promise<Record<string, unknown>> {
  if (!access.token) throw new Error("these settings live in the app's Configuration tab here");
  const response = await access.fetch("http://supervisor/addons/self/info", { headers: { authorization: `Bearer ${access.token}` } });
  const body = await response.json().catch(() => ({})) as { data?: { options?: unknown } };
  const options = body.data?.options;
  if (!response.ok || !options || typeof options !== "object") throw new Error("Home Assistant didn't give the app's settings");
  return options as Record<string, unknown>;
}

export async function readAppOptionsForm(access: SupervisorAccess = supervisorAccess()): Promise<AppOptionsBody> {
  const options = await currentOptions(access);
  return {
    ok: true,
    groups: OPTION_GROUPS.map((group) => ({
      title: group.title,
      fields: group.fields.map((field) => {
        const value = options[field.key];
        if (field.kind === "secret") return { ...field, value: null, hasValue: typeof value === "string" && value.trim() !== "" };
        if (field.kind === "list") return { ...field, value: Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : "" };
        return { ...field, value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null };
      }),
    })),
  };
}

/** Saves the fields the page sends over the app's current settings; Home Assistant checks them too. */
export async function saveAppOptionsForm(input: unknown, access: SupervisorAccess = supervisorAccess()): Promise<AppOptionsBody & { readonly applied: "restart" }> {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const options = { ...await currentOptions(access) };
  for (const [key, raw] of Object.entries(value)) {
    const field = FIELDS.get(key);
    if (!field) throw new Error(`${key} isn't a setting the page changes`);
    options[key] = checkedValue(field, raw, options[key]);
  }
  const response = await access.fetch("http://supervisor/addons/self/options", {
    method: "POST",
    headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
    body: JSON.stringify({ options }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: unknown };
    throw new Error(typeof body.message === "string" ? body.message : "Home Assistant didn't take those settings");
  }
  return { ...await readAppOptionsForm(access), applied: "restart" };
}

function checkedValue(field: OptionField, raw: unknown, before: unknown): unknown {
  switch (field.kind) {
    case "switch":
      if (typeof raw !== "boolean") throw new Error(`${field.label} must be on or off`);
      return raw;
    case "number": {
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`${field.label} must be a number`);
      return amount;
    }
    case "choice":
      if (!field.choices?.some((choice) => choice.value === raw)) throw new Error(`${field.label}: pick one of the list`);
      return raw;
    case "secret": {
      // A blank key keeps the one there.
      const key = typeof raw === "string" ? raw.trim() : "";
      if (!key) return before ?? "";
      if (/\s/.test(key)) throw new Error(`${field.label} has spaces in it`);
      return key;
    }
    case "list":
      return (typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 100);
    case "text": {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text.length > 200 || /[<>"\\{}]/.test(text)) throw new Error(`${field.label} can't hold < > " \\ { }`);
      return text;
    }
  }
}
