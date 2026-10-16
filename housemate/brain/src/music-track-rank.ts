/**
 * Picks the recording "play X [by Y]" means from Music Assistant's search hits:
 * the original studio release over live, remix, karaoke and compilation copies.
 */
import type { MusicAssistantTrack } from "./ha-music-assistant.js";
import { normalizeMeasuredRoutingText as normalize } from "./routing-text.js";

export function nextDifferentMusicTrack(tracks: readonly MusicAssistantTrack[], selectedUri: string, selectedIsrc: string | null): MusicAssistantTrack | null {
  const selectedIndex = tracks.findIndex((track) => track.uri === selectedUri);
  const remaining = tracks.slice(selectedIndex >= 0 ? selectedIndex + 1 : 0);
  return remaining.find((track) => selectedIsrc && track.isrc && track.isrc !== selectedIsrc)
    ?? remaining.find((track) => track.uri !== selectedUri)
    ?? null;
}

export function musicTrackLabel(track: MusicAssistantTrack): string {
  const parts = [
    track.name,
    track.artist ? `by ${track.artist}` : null,
    track.version ? `(${track.version})` : null,
    track.album ? `from ${track.album}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

export function rankMusicTracks(tracks: readonly MusicAssistantTrack[], request: { readonly title: string; readonly artist: string | null }): readonly MusicAssistantTrack[] {
  if (tracks.length === 0) {
    return [];
  }
  const wantedTitle = normalize(request.title);
  // "the terminator theme song": nothing is called that, so the title is also matched without the
  // trailing "song"; "Love Song" keeps it.
  const withoutSong = wantedTitle.replace(/\s+(?:song|track|tune)$/, "");
  const wantedTitles = withoutSong !== wantedTitle && withoutSong.length >= 3 ? [wantedTitle, withoutSong] : [wantedTitle];
  const wantedArtist = request.artist ? normalize(request.artist) : null;
  const scored = tracks.map((track, index) => ({
    track,
    score: Math.max(...wantedTitles.map((title) => musicTrackScore(track, title, wantedArtist))) + recordingGroupScore(track, tracks) - index * 0.01,
  }));
  scored.sort((left, right) => right.score - left.score);
  return scored.map((entry) => entry.track);
}

function musicTrackScore(track: MusicAssistantTrack, wantedTitle: string, wantedArtist: string | null): number {
  let score = 0;
  const title = normalize(track.name);
  const plainTitle = normalizeVersionlessTitle(track.name);
  const artist = track.artist ? normalize(track.artist) : "";
  const album = track.album ? normalize(track.album) : "";
  const albumVersion = track.albumVersion ? normalize(track.albumVersion) : "";
  const albumType = track.albumType ? normalize(track.albumType) : "";
  const version = track.version ? normalize(track.version) : "";
  const requestedVariant = requestedMusicVariant(wantedTitle);
  const titleDistance = Math.min(editDistance(title, wantedTitle), editDistance(plainTitle, wantedTitle));
  if (title === wantedTitle) {
    score += 18;
  } else if (titleDistance <= 2) {
    score += 16;
  } else if (plainTitle === wantedTitle) {
    score += 14;
  } else if (title.includes(wantedTitle) || wantedTitle.includes(title) || plainTitle.includes(wantedTitle)) {
    score += 5;
  } else {
    score -= 12;
  }
  if (wantedArtist && artist === wantedArtist) {
    score += 24;
  } else if (wantedArtist && artist && (artist.includes(wantedArtist) || wantedArtist.includes(artist))) {
    score += 8;
  } else if (wantedArtist) {
    score -= 20;
  }
  if (isLikelyBadMusicVariant(`${title} ${version} ${album}`, requestedVariant)) {
    score -= 12;
  }
  if (isLikelyCoverOrKaraoke(`${title} ${artist} ${album}`) && requestedVariant !== "cover") {
    score -= 20;
  }
  score += albumReleaseScore(album, albumVersion, albumType);
  if (!titleHasExtraVersionWords(title, wantedTitle)) {
    score += 4;
  }
  if (!version) {
    score += 3;
  } else if (requestedVariant && version.includes(requestedVariant)) {
    score += 6;
  }
  if (track.provider !== null && track.provider !== "library") {
    score += 4;
  }
  return score;
}

function editDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const above = previous[j + 1] ?? (j + 1);
      const leftValue = previous[j] ?? j;
      const nextDiagonal = previous[j + 1] ?? 0;
      const cost = left[i] === right[j] ? 0 : 1;
      previous[j + 1] = Math.min(
        above + 1,
        leftValue + 1,
        diagonal + cost,
      );
      diagonal = nextDiagonal;
    }
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function recordingGroupScore(track: MusicAssistantTrack, tracks: readonly MusicAssistantTrack[]): number {
  if (!track.isrc) {
    return 0;
  }
  const group = tracks.filter((candidate) => candidate.isrc === track.isrc);
  if (group.length < 2) {
    return 0;
  }
  let score = 0;
  const album = track.album ? normalize(track.album) : "";
  const albumType = track.albumType ? normalize(track.albumType) : "";
  const years = group.map((candidate) => candidate.albumYear).filter((year): year is number => typeof year === "number");
  const earliestYear = years.length > 0 ? Math.min(...years) : null;
  if (earliestYear && track.albumYear) {
    if (track.albumYear === earliestYear) {
      score += 3;
    } else {
      score -= Math.min(6, Math.max(1, track.albumYear - earliestYear));
    }
  }
  if (albumType === "album" && !looksLikeSecondaryRelease(album, albumType)) {
    score += 3;
  }
  if (looksLikeSecondaryRelease(album, albumType)) {
    score -= 4;
  }
  return score;
}

function albumReleaseScore(album: string, albumVersion: string, albumType: string): number {
  let score = 0;
  switch (albumType) {
    case "album":
      score += 5;
      break;
    case "single":
    case "ep":
      score += 2;
      break;
    case "compilation":
      score -= 8;
      break;
    default:
      break;
  }
  if (/\bdeluxe\b/.test(albumVersion)) {
    score += 1;
  }
  if (looksLikeSecondaryRelease(album, albumType)) {
    score -= 5;
  }
  if (/^\[.+\]$/.test(album)) {
    score -= 2;
  }
  return score;
}

function looksLikeSecondaryRelease(album: string, albumType: string): boolean {
  if (albumType === "compilation") {
    return true;
  }
  return /\b(best of|greatest hits|essentials?|collection|anthology|compilation|playlist|hits|workout|covers?|karaoke|tribute)\b/.test(album)
    || /\b(ep|single)\b/.test(album);
}

function normalizeVersionlessTitle(value: string): string {
  return normalize(value)
    .replace(/\s+\b(?:live|remix|acoustic|karaoke|instrumental|demo|remaster(?:ed)?|re[-\s]?recorded|radio edit|single version|extended version)\b.*$/, "")
    .trim();
}

function requestedMusicVariant(wantedTitle: string): string | null {
  if (/\blive\b/.test(wantedTitle)) {
    return "live";
  }
  if (/\bremix\b/.test(wantedTitle)) {
    return "remix";
  }
  if (/\bacoustic\b/.test(wantedTitle)) {
    return "acoustic";
  }
  if (/\bcover\b/.test(wantedTitle)) {
    return "cover";
  }
  if (/\binstrumental\b/.test(wantedTitle)) {
    return "instrumental";
  }
  return null;
}

function isLikelyBadMusicVariant(value: string, requestedVariant: string | null): boolean {
  const variant = /\b(live|remix|acoustic|karaoke|instrumental|demo|re[-\s]?recorded|extended version)\b/.exec(value)?.[1] ?? null;
  return Boolean(variant && variant !== requestedVariant);
}

function isLikelyCoverOrKaraoke(value: string): boolean {
  return /\b(karaoke|tribute|cover|originally performed by|made famous by)\b/.test(value);
}

function titleHasExtraVersionWords(title: string, wantedTitle: string): boolean {
  if (title === wantedTitle) {
    return false;
  }
  return /\b(live|remix|acoustic|karaoke|instrumental|demo|remaster(?:ed)?|re[-\s]?recorded|radio edit|single version|extended version)\b/.test(title);
}
