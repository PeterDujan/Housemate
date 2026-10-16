
import { boundedInteger } from "./value-guards.js";export type LocalMediaKind = "movie" | "show";

export interface LocalMediaRecommendation {
  readonly title: string;
  readonly year: number | null;
  readonly kind: LocalMediaKind;
  readonly available: boolean;
  readonly source: "plex" | "radarr" | "sonarr" | "seerr";
  readonly rating: number | null;
  readonly ratingSource: string | null;
  readonly genres: readonly string[];
  /** Film length, when Plex or Radarr knows it. */
  readonly minutes?: number;
}

/** "Before bed" or "something short": a film that fits. */
export const SHORT_FILM_MINUTES = 110;

export interface LocalMediaListItem extends LocalMediaRecommendation {
  readonly watched: boolean | null;
  readonly addedAt: number | null;
}

export interface LocalMediaCatalogOptions {
  readonly plexUrl?: string;
  readonly plexToken?: string | null;
  readonly radarrUrl?: string;
  readonly radarrApiKey?: string | null;
  readonly sonarrUrl?: string;
  readonly sonarrApiKey?: string | null;
  readonly seerrUrl?: string;
  readonly seerrApiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly maxSourceItems?: number;
}

export interface LocalMediaReadOptions {
  readonly signal?: AbortSignal;
}

export type LocalMediaSourceName = LocalMediaRecommendation["source"];
export type LocalMediaSourceStatus =
  | "available"
  | "not_configured"
  | "unavailable";
export type LocalMediaSourceErrorCode =
  | "http_error"
  | "invalid_response"
  | "network_error"
  | "timeout";

export interface LocalMediaSourceObservation {
  readonly source: LocalMediaSourceName;
  readonly status: LocalMediaSourceStatus;
  readonly errorCode: LocalMediaSourceErrorCode | null;
}

export interface LocalMediaAgentReadResult<T> {
  readonly result: T;
  /** True only when every configured source queried for this result answered. */
  readonly complete: boolean;
  readonly sources: readonly LocalMediaSourceObservation[];
}

interface Candidate extends LocalMediaRecommendation {
  readonly watched: boolean | null;
  readonly addedAt: number | null;
  /** Internal distinction between a confirmed empty genre list and no field. */
  readonly genresKnown: boolean;
}

type MutableMediaReadTrace = Map<
  LocalMediaSourceName,
  LocalMediaSourceObservation
>;

const MEDIA_SOURCE_TIMEOUT_MS = 8_000;
const DEFAULT_MEDIA_RESPONSE_BYTE_LIMIT = 16 * 1024 * 1024;
const MAX_MEDIA_RESPONSE_BYTE_LIMIT = 64 * 1024 * 1024;
const DEFAULT_MEDIA_SOURCE_ITEM_LIMIT = 5_000;
const MAX_MEDIA_SOURCE_ITEM_LIMIT = 20_000;
const MAX_MEDIA_NESTED_ITEMS = 100;

export class LocalMediaCatalogClient {
  private readonly options: LocalMediaCatalogOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxSourceItems: number;

  constructor(options: LocalMediaCatalogOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MEDIA_RESPONSE_BYTE_LIMIT,
      1,
      MAX_MEDIA_RESPONSE_BYTE_LIMIT,
      "media response byte limit",
    );
    this.maxSourceItems = boundedInteger(
      options.maxSourceItems ?? DEFAULT_MEDIA_SOURCE_ITEM_LIMIT,
      1,
      MAX_MEDIA_SOURCE_ITEM_LIMIT,
      "media source item limit",
    );
  }

  async recommend(
    kind: LocalMediaKind,
    genre?: string | null,
    options: LocalMediaReadOptions = {},
    maxMinutes: number | null = null,
  ): Promise<LocalMediaRecommendation | null> {
    return this.#recommend(kind, genre, options, undefined, undefined, maxMinutes);
  }

  async recommendForAgent(
    kind: LocalMediaKind,
    genre?: string | null,
    options: LocalMediaReadOptions = {},
    maxMinutes: number | null = null,
  ): Promise<LocalMediaAgentReadResult<LocalMediaRecommendation | null>> {
    const trace: MutableMediaReadTrace = new Map();
    const completeness = { semanticIncomplete: false };
    const result = await this.#recommend(
      kind,
      genre,
      options,
      trace,
      completeness,
      maxMinutes,
    );
    return agentReadResult(
      result,
      trace,
      undefined,
      !completeness.semanticIncomplete,
    );
  }

  async find(
    title: string,
    kind?: LocalMediaKind | null,
    options: LocalMediaReadOptions = {},
  ): Promise<LocalMediaRecommendation | null> {
    return this.#find(title, kind, options);
  }

  async findForAgent(
    title: string,
    kind?: LocalMediaKind | null,
    options: LocalMediaReadOptions = {},
  ): Promise<LocalMediaAgentReadResult<LocalMediaRecommendation | null>> {
    const trace: MutableMediaReadTrace = new Map();
    const result = await this.#find(title, kind, options, trace);
    return agentReadResult(result, trace);
  }

  async list(
    kind: LocalMediaKind,
    filter: "recent" | "unwatched",
    limit = 3,
    options: LocalMediaReadOptions = {},
  ): Promise<readonly LocalMediaListItem[]> {
    return this.#list(kind, filter, limit, options);
  }

  async listForAgent(
    kind: LocalMediaKind,
    filter: "recent" | "unwatched",
    limit = 3,
    options: LocalMediaReadOptions = {},
  ): Promise<LocalMediaAgentReadResult<readonly LocalMediaListItem[]>> {
    const trace: MutableMediaReadTrace = new Map();
    const result = await this.#list(kind, filter, limit, options, trace);
    return agentReadResult(result, trace, "plex");
  }

  async #recommend(
    kind: LocalMediaKind,
    genre: string | null | undefined,
    options: LocalMediaReadOptions,
    trace?: MutableMediaReadTrace,
    completeness?: { semanticIncomplete: boolean },
    maxMinutes: number | null = null,
  ): Promise<LocalMediaRecommendation | null> {
    options.signal?.throwIfAborted();
    const [plex, manager] = await Promise.all([
      this.plexCandidates(kind, options, trace),
      kind === "movie"
        ? this.radarrCandidates(options, trace)
        : this.sonarrCandidates(options, trace),
    ]);
    const enriched = enrichPlexCandidates(plex, manager);
    const available = enriched.length > 0
      ? enriched
      : manager.filter((candidate) => candidate.available);
    const genreFiltered = genre
      ? available.filter((candidate) => candidate.genres.some((value) => normalizeTitle(value) === normalizeTitle(genre)))
      : available;
    // A film that fits when one does; otherwise the best pick, whose length the answer then says.
    const fits = maxMinutes === null ? [] : genreFiltered.filter((candidate) => candidate.minutes !== undefined && candidate.minutes <= maxMinutes);
    const preferred = chooseCandidate(fits.length > 0 ? fits : genreFiltered);
    if (preferred) {
      return preferred;
    }
    if (genre) {
      if (
        completeness
        && available.some((candidate) => !candidate.genresKnown)
      ) {
        completeness.semanticIncomplete = true;
      }
      return null;
    }
    return chooseCandidate(await this.seerrCandidates(kind, options, trace));
  }

  async #find(
    title: string,
    kind: LocalMediaKind | null | undefined,
    options: LocalMediaReadOptions,
    trace?: MutableMediaReadTrace,
  ): Promise<LocalMediaRecommendation | null> {
    options.signal?.throwIfAborted();
    const kinds: readonly LocalMediaKind[] = kind ? [kind] : ["movie", "show"];
    for (const candidateKind of kinds) {
      const [plex, manager] = await Promise.all([
        this.plexCandidates(candidateKind, options, trace),
        candidateKind === "movie"
          ? this.radarrCandidates(options, trace)
          : this.sonarrCandidates(options, trace),
      ]);
      const match = enrichPlexCandidates(plex, manager)
        .find((candidate) => normalizeTitle(candidate.title) === normalizeTitle(title))
        ?? manager.find((candidate) => normalizeTitle(candidate.title) === normalizeTitle(title));
      if (match) {
        return publicCandidate(match);
      }
    }
    return null;
  }

  async #list(
    kind: LocalMediaKind,
    filter: "recent" | "unwatched",
    limit: number,
    options: LocalMediaReadOptions,
    trace?: MutableMediaReadTrace,
  ): Promise<readonly LocalMediaListItem[]> {
    options.signal?.throwIfAborted();
    const [plex, manager] = await Promise.all([
      this.plexCandidates(kind, options, trace),
      kind === "movie"
        ? this.radarrCandidates(options, trace)
        : this.sonarrCandidates(options, trace),
    ]);
    const candidates = enrichPlexCandidates(plex, manager)
      .filter((candidate) =>
        candidate.source === "plex"
        && (filter !== "unwatched" || candidate.watched === false))
      .sort((left, right) =>
        (right.addedAt ?? 0) - (left.addedAt ?? 0)
        || left.title.localeCompare(right.title))
      .slice(0, Math.max(1, Math.min(limit, 5)));
    return candidates.map((candidate) => ({ ...publicCandidate(candidate), watched: candidate.watched, addedAt: candidate.addedAt }));
  }

  private async plexCandidates(
    kind: LocalMediaKind,
    options: LocalMediaReadOptions,
    trace?: MutableMediaReadTrace,
  ): Promise<readonly Candidate[]> {
    const origin = normalizedOrigin(this.options.plexUrl);
    const token = normalizedSecret(this.options.plexToken);
    if (!origin || !token) {
      recordMediaSource(trace, "plex", "not_configured");
      return [];
    }
    try {
      const sections = await this.fetchJson(`${origin}/library/sections`, {
        "X-Plex-Token": token,
      }, options);
      const container = requiredNestedRecord(
        sections,
        "MediaContainer",
        "Plex section response",
      );
      const directories = requiredObjectArray(
        unknownValue(container, "Directory"),
        this.maxSourceItems,
        "Plex section response",
      );
      for (const entry of directories) {
        if (!nestedString(entry, "key") || !nestedString(entry, "type")) {
          throw new MediaSourceResponseError(
            "Plex section response contained an invalid directory",
          );
        }
      }
      const section = directories.find((entry) => nestedString(entry, "type") === kind);
      const sectionKey = section ? nestedString(section, "key") : "";
      if (!sectionKey) {
        recordMediaSource(trace, "plex", "available");
        return [];
      }
      const payload = await this.fetchJson(
        `${origin}/library/sections/${encodeURIComponent(sectionKey)}/all?type=${kind === "movie" ? "1" : "2"}&X-Plex-Container-Start=0&X-Plex-Container-Size=2500`,
        { "X-Plex-Token": token },
        options,
      );
      const candidates = requiredObjectArray(
        unknownValue(requiredNestedRecord(
          payload,
          "MediaContainer",
          "Plex catalogue response",
        ), "Metadata"),
        this.maxSourceItems,
        "Plex catalogue response",
      )
        .map((entry): Candidate | null => {
          const title = nestedString(entry, "title");
          if (!title) {
            throw new MediaSourceResponseError(
              "Plex catalogue response contained an item without a title",
            );
          }
          const viewCount = optionalNonnegativeIntegerValue(
            entry,
            "viewCount",
            "Plex viewCount",
          );
          const leafCount = optionalNonnegativeIntegerValue(
            entry,
            "leafCount",
            "Plex leafCount",
          );
          const viewedLeafCount = optionalNonnegativeIntegerValue(
            entry,
            "viewedLeafCount",
            "Plex viewedLeafCount",
          );
          return {
            title,
            year: integerValue(entry, "year"),
            kind,
            available: true,
            source: "plex",
            rating: firstNumber(entry, ["audienceRating", "rating"]),
            ratingSource: firstNumber(entry, ["audienceRating", "rating"]) === null ? null : "Plex",
            genres: plexGenres(entry),
            genresKnown: Object.hasOwn(entry, "Genre"),
            ...filmMinutes(kind === "movie" ? firstNumber(entry, ["duration"]) : null, 60_000),
            watched: kind === "movie"
              ? (viewCount ?? 0) > 0
              : leafCount === null || viewedLeafCount === null
                ? null
                : leafCount > 0 && viewedLeafCount >= leafCount,
            addedAt: epochMilliseconds(nestedNumber(entry, "addedAt")),
          };
        })
        .filter((entry): entry is Candidate => entry !== null);
      recordMediaSource(trace, "plex", "available");
      return candidates;
    } catch (error) {
      rethrowBoundedSourceFailure(error, options.signal);
      recordMediaSource(
        trace,
        "plex",
        "unavailable",
        mediaSourceErrorCode(error),
      );
      return [];
    }
  }

  private async radarrCandidates(
    options: LocalMediaReadOptions,
    trace?: MutableMediaReadTrace,
  ): Promise<readonly Candidate[]> {
    const origin = normalizedOrigin(this.options.radarrUrl);
    const apiKey = normalizedSecret(this.options.radarrApiKey);
    if (!origin || !apiKey) {
      recordMediaSource(trace, "radarr", "not_configured");
      return [];
    }
    try {
      const payload = await this.fetchJson(
        `${origin}/api/v3/movie`,
        { "X-Api-Key": apiKey },
        options,
      );
      const candidates = requiredObjectArray(
        payload,
        this.maxSourceItems,
        "Radarr catalogue response",
      ).map((entry): Candidate | null => {
        const title = nestedString(entry, "title");
        if (!title) {
          throw new MediaSourceResponseError(
            "Radarr catalogue response contained an item without a title",
          );
        }
        const ratings = optionalObjectValue(
          entry,
          "ratings",
          "Radarr ratings",
        );
        const imdbRating = firstNumber(nestedRecord(ratings, "imdb"), ["value"]);
        const tmdbRating = firstNumber(nestedRecord(ratings, "tmdb"), ["value"]);
        return {
          title,
          year: integerValue(entry, "year"),
          kind: "movie",
          available: requiredBooleanValue(
            entry,
            "hasFile",
            "Radarr hasFile",
          ),
          source: "radarr",
          rating: imdbRating ?? tmdbRating,
          ratingSource: imdbRating !== null
            ? "IMDb"
            : tmdbRating !== null ? "TMDB" : null,
          genres: optionalStringArray(
            unknownValue(entry, "genres"),
            MAX_MEDIA_NESTED_ITEMS,
            "Radarr genre response",
          ),
          genresKnown: Object.hasOwn(entry, "genres"),
          ...filmMinutes(firstNumber(entry, ["runtime"]), 1),
          watched: false,
          addedAt: dateNumber(nestedString(entry, "added")),
        };
      }).filter((entry): entry is Candidate => entry !== null);
      recordMediaSource(trace, "radarr", "available");
      return candidates;
    } catch (error) {
      rethrowBoundedSourceFailure(error, options.signal);
      recordMediaSource(
        trace,
        "radarr",
        "unavailable",
        mediaSourceErrorCode(error),
      );
      return [];
    }
  }

  private async sonarrCandidates(
    options: LocalMediaReadOptions,
    trace?: MutableMediaReadTrace,
  ): Promise<readonly Candidate[]> {
    const origin = normalizedOrigin(this.options.sonarrUrl);
    const apiKey = normalizedSecret(this.options.sonarrApiKey);
    if (!origin || !apiKey) {
      recordMediaSource(trace, "sonarr", "not_configured");
      return [];
    }
    try {
      const payload = await this.fetchJson(
        `${origin}/api/v3/series`,
        { "X-Api-Key": apiKey },
        options,
      );
      const candidates = requiredObjectArray(
        payload,
        this.maxSourceItems,
        "Sonarr catalogue response",
      ).map((entry): Candidate | null => {
        const title = nestedString(entry, "title");
        if (!title) {
          throw new MediaSourceResponseError(
            "Sonarr catalogue response contained an item without a title",
          );
        }
        const statistics = requiredNestedRecord(
          entry,
          "statistics",
          "Sonarr statistics",
        );
        const episodeFileCount = requiredNonnegativeIntegerValue(
          statistics,
          "episodeFileCount",
          "Sonarr episodeFileCount",
        );
        return {
          title,
          year: integerValue(entry, "year"),
          kind: "show",
          available: episodeFileCount > 0,
          source: "sonarr",
          rating: firstNumber(optionalObjectValue(
            entry,
            "ratings",
            "Sonarr ratings",
          ), ["value"]),
          ratingSource: firstNumber(optionalObjectValue(
            entry,
            "ratings",
            "Sonarr ratings",
          ), ["value"]) === null ? null : "Sonarr",
          genres: optionalStringArray(
            unknownValue(entry, "genres"),
            MAX_MEDIA_NESTED_ITEMS,
            "Sonarr genre response",
          ),
          genresKnown: Object.hasOwn(entry, "genres"),
          watched: false,
          addedAt: dateNumber(nestedString(entry, "added")),
        };
      }).filter((entry): entry is Candidate => entry !== null);
      recordMediaSource(trace, "sonarr", "available");
      return candidates;
    } catch (error) {
      rethrowBoundedSourceFailure(error, options.signal);
      recordMediaSource(
        trace,
        "sonarr",
        "unavailable",
        mediaSourceErrorCode(error),
      );
      return [];
    }
  }

  private async seerrCandidates(
    kind: LocalMediaKind,
    options: LocalMediaReadOptions,
    trace?: MutableMediaReadTrace,
  ): Promise<readonly Candidate[]> {
    const origin = normalizedOrigin(this.options.seerrUrl);
    const apiKey = normalizedSecret(this.options.seerrApiKey);
    if (!origin || !apiKey) {
      recordMediaSource(trace, "seerr", "not_configured");
      return [];
    }
    try {
      const path = kind === "movie" ? "movies" : "tv";
      const payload = await this.fetchJson(
        `${origin}/api/v1/discover/${path}?page=1`,
        { "X-Api-Key": apiKey },
        options,
      );
      const candidates = requiredObjectArray(
        unknownValue(payload, "results"),
        this.maxSourceItems,
        "Seerr discovery response",
      ).map((entry): Candidate | null => {
        const title = nestedString(entry, kind === "movie" ? "title" : "name");
        if (!title) {
          throw new MediaSourceResponseError(
            "Seerr discovery response contained an item without a title",
          );
        }
        const releaseDate = nestedString(entry, kind === "movie" ? "releaseDate" : "firstAirDate");
        return {
          title,
          year: releaseDate ? integerFromString(releaseDate.slice(0, 4)) : null,
          kind,
          available: false,
          source: "seerr",
          rating: nestedNumber(entry, "voteAverage"),
          ratingSource: nestedNumber(entry, "voteAverage") === null ? null : "TMDB",
          genres: [],
          genresKnown: false,
          watched: false,
          addedAt: null,
        };
      }).filter((entry): entry is Candidate => entry !== null);
      recordMediaSource(trace, "seerr", "available");
      return candidates;
    } catch (error) {
      rethrowBoundedSourceFailure(error, options.signal);
      recordMediaSource(
        trace,
        "seerr",
        "unavailable",
        mediaSourceErrorCode(error),
      );
      return [];
    }
  }

  private async fetchJson(
    url: string,
    headers: Readonly<Record<string, string>>,
    options: LocalMediaReadOptions,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(MEDIA_SOURCE_TIMEOUT_MS);
    const response = await this.fetchImpl(url, {
      headers: {
        accept: "application/json",
        ...headers,
      },
      signal: options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal,
    });
    if (!response.ok) {
      throw new Error(`media source HTTP ${response.status}`);
    }
    return readBoundedJsonResponse(response, this.maxResponseBytes);
  }
}

function agentReadResult<T>(
  result: T,
  trace: MutableMediaReadTrace,
  requiredSource?: LocalMediaSourceName,
  semanticComplete = true,
): LocalMediaAgentReadResult<T> {
  const sourceOrder: readonly LocalMediaSourceName[] = [
    "plex",
    "radarr",
    "sonarr",
    "seerr",
  ];
  const sources = sourceOrder
    .map((source) => trace.get(source))
    .filter((item): item is LocalMediaSourceObservation => item !== undefined);
  const queried = sources.filter((item) => item.status !== "not_configured");
  const requiredAvailable = requiredSource !== undefined
    && sources.some((item) =>
      item.source === requiredSource && item.status === "available");
  return Object.freeze({
    result,
    complete: semanticComplete && (requiredSource === undefined
      ? queried.length > 0
        && queried.every((item) => item.status === "available")
      : requiredAvailable),
    sources: Object.freeze(sources.map((item) => Object.freeze({ ...item }))),
  });
}

function recordMediaSource(
  trace: MutableMediaReadTrace | undefined,
  source: LocalMediaSourceName,
  status: LocalMediaSourceStatus,
  errorCode: LocalMediaSourceErrorCode | null = null,
): void {
  if (!trace) {
    return;
  }
  const previous = trace.get(source);
  if (previous?.status === "unavailable") {
    return;
  }
  if (previous?.status === "available" && status !== "unavailable") {
    return;
  }
  trace.set(source, Object.freeze({ source, status, errorCode }));
}

function mediaSourceErrorCode(error: unknown): LocalMediaSourceErrorCode {
  if (
    error instanceof Error
    && (
      error.name === "TimeoutError"
      || /\btime(?:d)?\s*out\b/iu.test(error.message)
    )
  ) {
    return "timeout";
  }
  if (
    error instanceof Error
    && /^media source HTTP \d{3}$/u.test(error.message)
  ) {
    return "http_error";
  }
  return error instanceof SyntaxError || error instanceof MediaSourceResponseError
    ? "invalid_response"
    : "network_error";
}

function enrichPlexCandidates(
  plex: readonly Candidate[],
  manager: readonly Candidate[],
): readonly Candidate[] {
  const managerByKey = new Map(manager.map((candidate) => [candidateKey(candidate), candidate]));
  return plex.map((candidate) => {
    const enrichment = managerByKey.get(candidateKey(candidate));
    if (!enrichment) {
      return candidate;
    }
    return {
      ...candidate,
      rating: enrichment.rating ?? candidate.rating,
      ratingSource: enrichment.rating !== null ? enrichment.ratingSource : candidate.ratingSource,
      genres: enrichment.genres.length > 0 ? enrichment.genres : candidate.genres,
      genresKnown: candidate.genresKnown || enrichment.genresKnown,
      ...(candidate.minutes ?? enrichment.minutes ? { minutes: candidate.minutes ?? enrichment.minutes } : {}),
    };
  });
}

function chooseCandidate(candidates: readonly Candidate[]): LocalMediaRecommendation | null {
  if (candidates.length === 0) {
    return null;
  }
  const unwatched = candidates.filter((candidate) => candidate.watched === false);
  const pool = unwatched.length > 0 ? unwatched : [...candidates];
  const selected = [...pool].sort((left, right) =>
    (right.rating ?? 0) - (left.rating ?? 0)
    || (right.addedAt ?? 0) - (left.addedAt ?? 0)
    || left.title.localeCompare(right.title))[0];
  if (!selected) {
    return null;
  }
  return publicCandidate(selected);
}

/** Plex counts milliseconds, Radarr minutes; nothing when unknown or zero. */
function filmMinutes(value: number | null, perMinute: number): { readonly minutes?: number } {
  return value !== null && value > 0 ? { minutes: Math.round(value / perMinute) } : {};
}

function publicCandidate(candidate: Candidate): LocalMediaRecommendation {
  const {
    watched: _watched,
    addedAt: _addedAt,
    genresKnown: _genresKnown,
    ...recommendation
  } = candidate;
  return recommendation;
}

function candidateKey(candidate: Pick<Candidate, "title" | "year">): string {
  return `${candidate.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")}:${candidate.year ?? ""}`;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizedOrigin(value: string | undefined): string {
  return String(value ?? "").trim().replace(/\/+$/g, "");
}

function normalizedSecret(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
}

function requiredNestedRecord(
  value: unknown,
  key: string,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaSourceResponseError(`${label} was not an object`);
  }
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new MediaSourceResponseError(
      `${label} did not contain an object ${key}`,
    );
  }
  return nested as Record<string, unknown>;
}

function optionalObjectValue(
  value: unknown,
  key: string,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaSourceResponseError(`${label} parent was not an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, key) || record[key] === null) {
    return {};
  }
  const nested = record[key];
  if (typeof nested !== "object" || Array.isArray(nested)) {
    throw new MediaSourceResponseError(`${label} was not an object`);
  }
  return nested as Record<string, unknown>;
}

function unknownValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function requiredObjectArray(
  value: unknown,
  maximum: number,
  label: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new MediaSourceResponseError(
      `${label} did not contain the expected array`,
    );
  }
  assertMediaSourceItemLimit(value.length, maximum, label);
  if (value.some((entry) =>
    !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new MediaSourceResponseError(
      `${label} contained a non-object item`,
    );
  }
  return value as readonly Record<string, unknown>[];
}

function optionalStringArray(
  value: unknown,
  maximum: number,
  label: string,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MediaSourceResponseError(`${label} was not an array`);
  }
  assertMediaSourceItemLimit(value.length, maximum, label);
  if (value.some((entry) =>
    typeof entry !== "string" || !entry.trim())) {
    throw new MediaSourceResponseError(
      `${label} contained an invalid genre`,
    );
  }
  return (value as readonly string[]).map((entry) => entry.trim());
}

function plexGenres(entry: Readonly<Record<string, unknown>>): readonly string[] {
  const rawGenres = entry.Genre;
  if (rawGenres === undefined) {
    return [];
  }
  const genres = requiredObjectArray(
    rawGenres,
    MAX_MEDIA_NESTED_ITEMS,
    "Plex genre response",
  );
  const tags = genres.map((genre) => nestedString(genre, "tag"));
  if (tags.some((tag) => !tag)) {
    throw new MediaSourceResponseError(
      "Plex genre response contained an item without a tag",
    );
  }
  return tags;
}

function assertMediaSourceItemLimit(
  count: number,
  maximum: number,
  label: string,
): void {
  if (count > maximum) {
    throw new MediaSourceLimitError(
      `${label} exceeded its ${maximum}-item limit`,
    );
  }
}

async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > maximumBytes) {
      throw new MediaSourceLimitError(
        `media source response exceeded its ${maximumBytes}-byte limit`,
      );
    }
  }

  const body = response.body;
  if (!body) {
    return null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        void reader.cancel();
        throw new MediaSourceLimitError(
          `media source response exceeded its ${maximumBytes}-byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(
    chunks.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    receivedBytes,
  ).toString("utf8");
  return JSON.parse(text) as unknown;
}

function rethrowBoundedSourceFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw signal.reason ?? abortError();
  }
  if (
    error instanceof MediaSourceLimitError
    || (error instanceof Error && error.name === "AbortError")
  ) {
    throw error;
  }
}

function abortError(): Error {
  const error = new Error("media source read aborted");
  error.name = "AbortError";
  return error;
}

class MediaSourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaSourceLimitError";
  }
}

class MediaSourceResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaSourceResponseError";
  }
}

function nestedString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested.trim() : "";
}

function nestedNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const nested = (value as Record<string, unknown>)[key];
  if (typeof nested === "number") {
    return Number.isFinite(nested) ? nested : null;
  }
  if (typeof nested !== "string" || !nested.trim()) {
    return null;
  }
  const parsed = Number(nested);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value: unknown, key: string): number | null {
  const nested = nestedNumber(value, key);
  return nested !== null && Number.isInteger(nested) ? nested : null;
}

function optionalBooleanValue(
  value: unknown,
  key: string,
  label: string,
): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaSourceResponseError(`${label} parent was not an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  if (typeof record[key] !== "boolean") {
    throw new MediaSourceResponseError(`${label} was not a boolean`);
  }
  return record[key] as boolean;
}

function requiredBooleanValue(
  value: unknown,
  key: string,
  label: string,
): boolean {
  const parsed = optionalBooleanValue(value, key, label);
  if (parsed === null) {
    throw new MediaSourceResponseError(`${label} was missing`);
  }
  return parsed;
}

function optionalNumberValue(
  value: unknown,
  key: string,
  label: string,
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaSourceResponseError(`${label} parent was not an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  const parsed = nestedNumber(record, key);
  if (parsed === null) {
    throw new MediaSourceResponseError(`${label} was not numeric`);
  }
  return parsed;
}

function optionalNonnegativeIntegerValue(
  value: unknown,
  key: string,
  label: string,
): number | null {
  const parsed = optionalNumberValue(value, key, label);
  if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
    throw new MediaSourceResponseError(
      `${label} was not a non-negative integer`,
    );
  }
  return parsed;
}

function requiredNonnegativeIntegerValue(
  value: unknown,
  key: string,
  label: string,
): number {
  const parsed = optionalNonnegativeIntegerValue(value, key, label);
  if (parsed === null) {
    throw new MediaSourceResponseError(`${label} was missing`);
  }
  return parsed;
}

function firstNumber(value: unknown, keys: readonly string[]): number | null {
  for (const key of keys) {
    const candidate = nestedNumber(value, key);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

function integerFromString(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function dateNumber(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochMilliseconds(value: number | null): number | null {
  if (value === null || value <= 0) {
    return null;
  }
  return Math.abs(value) < 1_000_000_000_000
    ? value * 1_000
    : value;
}
