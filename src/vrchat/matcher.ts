import type { NormalizedText, Occurrence } from "./text.js";
import { findOccurrences, isAsciiAlias, normalizeCompact, splitCamelCase, tokenize } from "./text.js";
import type { AvatarDictionary } from "./types.js";

export interface AliasEntry {
  readonly avatarId: string;
  /** Compact normalised alias. */
  readonly alias: string;
  readonly restricted: boolean;
}

export interface AvatarIndex {
  readonly aliases: readonly AliasEntry[];
  readonly byAlias: ReadonlyMap<string, readonly AliasEntry[]>;
}

export interface AvatarMatch extends Occurrence {
  readonly avatarId: string;
  readonly restricted: boolean;
}

/**
 * `strict`: free text (item name, description) — restricted names need context.
 * `structured`: heading blocks, negation scans — restricted names are accepted.
 */
export type MatchMode = "strict" | "structured";

/** Suffixes that may follow an avatar name in a tag / token (しなの対応, kikyo用, kumaly3d). */
const LABEL_SUFFIXES = [
  "ちゃん対応", "ちゃん専用", "ちゃん向け", "ちゃん用", "くん対応", "くん用", "対応衣装", "専用衣装", "用衣装",
  "version", "ちゃん", "くん", "さん", "さま", "専用", "対応", "向け", "衣装", "ver", "様", "用", "版", "3d",
] as const;

const NEGATION_SUFFIXES = ["非対応", "未対応", "対象外", "対応外", "不可"] as const;

/** Context after a restricted name in free text that makes it an avatar reference. */
const COMPAT_CONTEXT = /^(ちゃん|くん|様|さま)?(用|対応|専用|向け|版)/;
const COMPAT_HONORIFIC = /^(ちゃん|くん)/;

const MAX_SHORT_JAPANESE = 2;
const MAX_SHORT_LATIN = 3;

const indexCache = new WeakMap<AvatarDictionary, AvatarIndex>();

function isShortAlias(alias: string): boolean {
  return alias.length <= (isAsciiAlias(alias) ? MAX_SHORT_LATIN : MAX_SHORT_JAPANESE);
}

/** Build (and memoise) the alias index for a dictionary. */
export function buildAvatarIndex(dictionary: AvatarDictionary): AvatarIndex {
  const cached = indexCache.get(dictionary);
  if (cached) return cached;

  const aliases: AliasEntry[] = [];
  const byAlias = new Map<string, AliasEntry[]>();
  for (const entry of dictionary) {
    const restrictedNames = new Set((entry.restricted_names ?? []).map(normalizeCompact));
    const seen = new Set<string>();
    for (const name of entry.names) {
      const alias = normalizeCompact(name);
      if (!alias || seen.has(alias)) continue;
      seen.add(alias);
      const restricted = entry.restricted === true || restrictedNames.has(alias) || isShortAlias(alias);
      const aliasEntry: AliasEntry = { avatarId: entry.id, alias, restricted };
      aliases.push(aliasEntry);
      byAlias.set(alias, [...(byAlias.get(alias) ?? []), aliasEntry]);
    }
  }
  const index: AvatarIndex = { aliases, byAlias };
  indexCache.set(dictionary, index);
  return index;
}

function stripLabelSuffix(token: string): string[] {
  const candidates = [token];
  let current = token;
  for (let pass = 0; pass < 2; pass += 1) {
    const suffix = LABEL_SUFFIXES.find((s) => current.length > s.length && current.endsWith(s));
    if (!suffix) break;
    current = current.slice(0, -suffix.length);
    candidates.push(current);
  }
  return candidates;
}

function lookupToken(token: string, index: AvatarIndex): string | null {
  for (const candidate of stripLabelSuffix(token)) {
    const entries = index.byAlias.get(candidate);
    if (entries?.[0]) return entries[0].avatarId;
  }
  return null;
}

/**
 * Avatars named in a short structured label (variation name, file name): whole tokens
 * after suffix stripping, so restricted names are allowed (`萌 - Moe`, `ばつ-Batsu-`).
 */
export function matchLabelTokens(label: string, index: AvatarIndex, splitCamel = false): string[] {
  const source = splitCamel ? `${label} ${splitCamelCase(label)}` : label;
  const ids = tokenize(source)
    .map((token) => lookupToken(token, index))
    .filter((id): id is string => id !== null);
  return [...new Set(ids)];
}

export interface TagMatch {
  readonly avatarId: string;
  readonly negated: boolean;
}

/** Whole-tag match: `しなの`, `しなの対応`, `Shinano用`, `kumaly3d`; `しなの非対応` is negated. */
export function matchTag(tag: string, index: AvatarIndex): TagMatch | null {
  const normalized = normalizeCompact(tag);
  if (!normalized) return null;
  for (const negation of NEGATION_SUFFIXES) {
    if (normalized.endsWith(negation)) {
      const id = lookupToken(normalized.slice(0, -negation.length), index);
      if (id) return { avatarId: id, negated: true };
    }
  }
  const id = lookupToken(normalized, index);
  return id ? { avatarId: id, negated: false } : null;
}

function allOccurrences(text: NormalizedText, index: AvatarIndex): AvatarMatch[] {
  const found: AvatarMatch[] = [];
  for (const entry of index.aliases) {
    for (const occurrence of findOccurrences(text, entry.alias)) {
      found.push({ ...occurrence, avatarId: entry.avatarId, restricted: entry.restricted });
    }
  }
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: AvatarMatch[] = [];
  for (const match of sorted) {
    const last = kept[kept.length - 1];
    if (!last || match.start >= last.end) kept.push(match);
  }
  return kept;
}

function hasCompatContext(text: NormalizedText, match: AvatarMatch): boolean {
  const rest = text.text.slice(match.end, match.end + 8);
  return COMPAT_CONTEXT.test(rest) || COMPAT_HONORIFIC.test(rest);
}

function isAdjacent(text: NormalizedText, left: AvatarMatch, right: AvatarMatch): boolean {
  return left.end === right.start && text.boundaries[right.start] === true;
}

function acceptStrict(text: NormalizedText, matches: readonly AvatarMatch[]): AvatarMatch[] {
  const accepted = matches.map((m) => !m.restricted || hasCompatContext(text, m));
  let changed = true;
  while (changed) {
    changed = false;
    matches.forEach((match, i) => {
      if (accepted[i]) return;
      const prev = matches[i - 1];
      const next = matches[i + 1];
      const nearPrev = prev !== undefined && accepted[i - 1] === true && isAdjacent(text, prev, match);
      const nearNext = next !== undefined && accepted[i + 1] === true && isAdjacent(text, match, next);
      if (nearPrev || nearNext) {
        accepted[i] = true;
        changed = true;
      }
    });
  }
  return matches.filter((_, i) => accepted[i]);
}

/** Find avatar references inside normalised free text. */
export function findAvatarMatches(text: NormalizedText, index: AvatarIndex, mode: MatchMode): AvatarMatch[] {
  const matches = allOccurrences(text, index);
  return mode === "structured" ? matches : acceptStrict(text, matches);
}

/**
 * Resolve a user query (`shinano`, `しなの`, `シナノちゃん`) to a dictionary id.
 * Returns null when the query is not in the dictionary.
 */
export function resolveAvatarId(query: string, dictionary: AvatarDictionary): string | null {
  const trimmed = query.trim().toLowerCase();
  const byId = dictionary.find((entry) => entry.id.toLowerCase() === trimmed);
  if (byId) return byId.id;
  return lookupToken(normalizeCompact(query), buildAvatarIndex(dictionary));
}
