/*
 * The app's own settings on the System page: the ones a house needs to set
 * (which AI, hearing and voice, their keys, where the house is, the approval phone) without HA's
 * Configuration tab. Read and saved through the Supervisor (`/addons/self/info` and `/options`,
 * which an app may do for itself); keys are never sent back to the page, a blank key keeps the one
 * there. The app reads its settings at start, so a save asks for a restart. Ports, folders and the
 * other advanced ones stay on the Configuration tab.
 */

export type OptionKind = "choice" | "pick" | "text" | "secret" | "number" | "switch" | "list";

export interface OptionChoice {
  readonly value: string;
  readonly label: string;
  /** Shown only with this AI picked (the Model list). */
  readonly brain?: string;
}

/** Lists a pick fills from the house: Home Assistant's speech engines and phones, the Fish account's voices. */
export type DynamicChoices = "stt" | "tts" | "phones" | "fish_voices";

export interface OptionField {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly kind: OptionKind;
  readonly choices?: readonly OptionChoice[];
  /** A pick's list from the house, after its fixed choices. */
  readonly from?: DynamicChoices;
  /** A pick that also takes a typed value ("Other..."). */
  readonly other?: boolean;
}

export type OptionChoices = Partial<Record<DynamicChoices, readonly OptionChoice[]>>;

const LANGUAGES: readonly OptionChoice[] = [
  ["en-AU", "English (Australia)"], ["en-GB", "English (UK)"], ["en-US", "English (US)"], ["en-NZ", "English (New Zealand)"],
  ["en-IE", "English (Ireland)"], ["en-CA", "English (Canada)"], ["en-ZA", "English (South Africa)"], ["en-IN", "English (India)"],
  ["de-DE", "Deutsch"], ["fr-FR", "Français"], ["es-ES", "Español"], ["it-IT", "Italiano"], ["nl-NL", "Nederlands"],
  ["pt-BR", "Português (Brasil)"], ["pt-PT", "Português (Portugal)"], ["sv-SE", "Svenska"], ["da-DK", "Dansk"], ["nb-NO", "Norsk"],
  ["fi-FI", "Suomi"], ["pl-PL", "Polski"], ["ja-JP", "日本語"], ["zh-CN", "中文 (简体)"],
].map(([value, label]) => ({ value: value!, label: label! }));

export const OPTION_GROUPS: readonly { readonly title: string; readonly fields: readonly OptionField[] }[] = [
  {
    title: "AI",
    fields: [
      { key: "brain", label: "AI for open chat", kind: "choice", help: "House questions are answered without AI either way.", choices: [{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }, { value: "off", label: "Off" }] },
      { key: "model", label: "Model", kind: "pick", other: true, help: "Default suits most houses.", choices: [
        { value: "claude-sonnet-5", label: "Default" },
        { value: "opus", label: "Claude Opus: more careful, slower", brain: "claude" },
        { value: "haiku", label: "Claude Haiku: quickest", brain: "claude" },
        { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", brain: "codex" },
      ] },
      { key: "monthly_budget_usd", label: "Monthly AI budget (USD)", kind: "number", help: "The AI stops for the rest of the month once this is spent." },
      { key: "claude_token", label: "Claude sign-in token", kind: "secret", help: "Easiest: Sign in with your Claude account, above. Or paste one from claude setup-token, run on any computer with Claude Code." },
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
      { key: "language", label: "Language", kind: "pick", other: true, help: "The language people speak to it in.", choices: LANGUAGES },
      { key: "deepgram_api_key", label: "Deepgram key", kind: "secret", help: "" },
      { key: "elevenlabs_api_key", label: "ElevenLabs key", kind: "secret", help: "" },
      { key: "inworld_api_key", label: "Inworld key", kind: "secret", help: "" },
      { key: "ha_stt_entity", label: "Home Assistant speech to text", kind: "pick", from: "stt", help: "With Speech to text on Home Assistant. Default picks the best it has (its Cloud first, then Whisper).", choices: [{ value: "", label: "Default" }] },
      { key: "keyterms", label: "Words to listen for", kind: "list", help: "Names and words it should hear right, separated by commas." },
    ],
  },
  {
    title: "Voice",
    fields: [
      { key: "voice", label: "Voice", kind: "choice", help: "What speaks the replies.", choices: [{ value: "home_assistant", label: "Home Assistant" }, { value: "fish", label: "Fish Audio" }, { value: "espeak", label: "Basic (on this box)" }] },
      { key: "fish_api_key", label: "Fish Audio key", kind: "secret", help: "" },
      { key: "fish_voice_id", label: "Fish voice", kind: "pick", from: "fish_voices", other: true, help: "Your Fish Audio voices are listed once the key is saved.", choices: [{ value: "", label: "None picked" }] },
      { key: "ha_tts_entity", label: "Home Assistant text to speech", kind: "pick", from: "tts", help: "With Voice on Home Assistant. Default picks the best it has (its Cloud first, then Piper).", choices: [{ value: "", label: "Default" }] },
    ],
  },
  {
    title: "The house",
    fields: [
      { key: "place", label: "Where the house is", kind: "text", help: "Suburb or town, state and country. Empty: nothing local is assumed." },
      { key: "approval_phone", label: "Approval phone", kind: "pick", from: "phones", other: true, help: "The phone that approves sensitive memories.", choices: [{ value: "", label: "Default: the owner's phone" }] },
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

/** The app's settings as saved (keys included: for the brain's own use, never for the page). */
export async function readAppOptions(access: SupervisorAccess = supervisorAccess()): Promise<Record<string, unknown>> {
  return currentOptions(access);
}

/** The app's own log; "x-log" has a UTC time on every line. */
export async function readAppLog(access: SupervisorAccess = supervisorAccess(), format: "plain" | "x-log" = "plain"): Promise<string | null> {
  if (!access.token) return null;
  const response = await access.fetch("http://supervisor/addons/self/logs", {
    headers: { authorization: `Bearer ${access.token}`, accept: `text/${format}` },
  });
  return response.ok ? response.text() : null;
}

/** The Fish Audio account's own voices, for the Fish voice pick; none when the key is missing or Fish doesn't answer. */
export async function fishVoices(key: string, fetchImpl: typeof fetch = fetch): Promise<readonly OptionChoice[]> {
  if (!key.trim()) return [];
  try {
    const response = await fetchImpl("https://api.fish.audio/model?self=true&page_size=100", {
      headers: { authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const body = await response.json() as { items?: unknown };
    return (Array.isArray(body.items) ? body.items : [])
      .map((item) => item as { _id?: unknown; title?: unknown })
      .filter((item) => typeof item._id === "string" && item._id)
      .map((item) => ({ value: item._id as string, label: typeof item.title === "string" && item.title.trim() ? item.title.trim() : item._id as string }));
  } catch {
    return [];
  }
}

async function currentOptions(access: SupervisorAccess): Promise<Record<string, unknown>> {
  if (!access.token) throw new Error("these settings live in the app's Configuration tab here");
  const response = await access.fetch("http://supervisor/addons/self/info", { headers: { authorization: `Bearer ${access.token}` } });
  const body = await response.json().catch(() => ({})) as { data?: { options?: unknown } };
  const options = body.data?.options;
  if (!response.ok || !options || typeof options !== "object") throw new Error("Home Assistant didn't give the app's settings");
  return options as Record<string, unknown>;
}

export async function readAppOptionsForm(access: SupervisorAccess = supervisorAccess(), choices: OptionChoices = {}): Promise<AppOptionsBody> {
  const options = await currentOptions(access);
  return {
    ok: true,
    groups: OPTION_GROUPS.map((group) => ({
      title: group.title,
      fields: group.fields.map((field) => {
        const value = options[field.key];
        if (field.kind === "secret") return { ...field, value: null, hasValue: typeof value === "string" && value.trim() !== "" };
        if (field.kind === "list") return { ...field, value: Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : "" };
        if (field.kind === "pick") return pickField(field, typeof value === "string" ? value : "", choices);
        return { ...field, value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null };
      }),
    })),
  };
}

/** A pick with the house's list after its own, and the value in use kept even when nothing lists it. */
function pickField(field: OptionField, value: string, choices: OptionChoices): OptionField & { readonly value: string } {
  const all = [...(field.choices ?? []), ...(field.from ? choices[field.from] ?? [] : [])];
  const listed = all.some((choice) => choice.value === value);
  // A pick its list never came for (no key, Home Assistant not connected) is typed in instead.
  const typed = field.from === "fish_voices" && !choices.fish_voices?.length;
  return {
    ...field,
    kind: typed ? "text" : "pick",
    choices: listed || !value || field.other ? all : [...all, { value, label: `${value} (not found now)` }],
    value,
  };
}

/** Saves the fields the page sends over the app's current settings; Home Assistant checks them too. */
export async function saveAppOptionsForm(input: unknown, access: SupervisorAccess = supervisorAccess(), choices: OptionChoices = {}): Promise<AppOptionsBody & { readonly applied: "restart" }> {
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
  return { ...await readAppOptionsForm(access, choices), applied: "restart" };
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
    case "pick":
    case "text": {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text.length > 200 || /[<>"\\{}]/.test(text)) throw new Error(`${field.label} can't hold < > " \\ { }`);
      return text;
    }
  }
}
