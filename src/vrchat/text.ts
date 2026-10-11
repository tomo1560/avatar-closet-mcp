/**
 * Text normalisation helpers for VRChat compatibility matching.
 *
 * Matching happens on a "compact" form: NFKC, latin diacritics removed, lower-cased,
 * katakana folded to hiragana, and whitespace / punctuation / symbols removed (except
 * `+`, which is meaningful in avatar names such as `+Head`). Every compact character
 * keeps a pointer back to the original string so evidence can be quoted verbatim.
 */

export interface NormalizedText {
  /** Compact normalised text. */
  readonly text: string;
  /** Original start offset (UTF-16) of the cluster each compact char came from. */
  readonly starts: readonly number[];
  /** Original end offset (exclusive) of the cluster each compact char came from. */
  readonly ends: readonly number[];
  /**
   * `boundaries[i]` is true when a separator was removed right before compact char `i`
   * (or `i` is the start / end). Length is `text.length + 1`.
   */
  readonly boundaries: readonly boolean[];
  /** Whether compact char `i` came from a katakana character (incl. the long vowel mark). */
  readonly katakana: readonly boolean[];
}

export interface Occurrence {
  readonly start: number;
  readonly end: number;
}

export const MAX_EVIDENCE_LENGTH = 120;

const LATIN_COMBINING_MARKS = /[̀-ͯ]/g;
const SEPARATOR = /[\s\p{P}\p{S}]/u;
const COMBINING = /[\p{M}ﾞﾟ]/u;
const KATAKANA = /[ァ-ヺーヽヾ]/;
const ASCII_ALNUM = /[a-z0-9]/;
const ASCII_ALIAS = /^[a-z0-9+]+$/;
const URL_PATTERN = /https?:\/\/[^\s「」『』【】（）()<>]+/g;
const HANDLE_PATTERN = /@[A-Za-z0-9_]+/g;

function isSeparator(char: string): boolean {
  return char !== "+" && SEPARATOR.test(char);
}

function toHiragana(char: string): string {
  const code = char.charCodeAt(0);
  // Katakana ァ (U+30A1) .. ヶ (U+30F6) map to hiragana by subtracting 0x60.
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCharCode(code - 0x60);
  return char;
}

function normalizeCluster(cluster: string): string {
  return cluster.normalize("NFD").replace(LATIN_COMBINING_MARKS, "").normalize("NFKC").toLowerCase();
}

function splitClusters(input: string): { readonly value: string; readonly start: number; readonly end: number }[] {
  const clusters: { value: string; start: number; end: number }[] = [];
  let index = 0;
  for (const char of input) {
    const last = clusters[clusters.length - 1];
    if (last && COMBINING.test(char)) {
      last.value += char;
      last.end = index + char.length;
    } else {
      clusters.push({ value: char, start: index, end: index + char.length });
    }
    index += char.length;
  }
  return clusters;
}

/** Normalise `input` into the compact form, keeping a map back to the original offsets. */
export function normalizeText(input: string): NormalizedText {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const boundaries: boolean[] = [];
  const katakana: boolean[] = [];
  let pendingBoundary = true;

  for (const cluster of splitClusters(input)) {
    for (const char of normalizeCluster(cluster.value)) {
      if (isSeparator(char)) {
        pendingBoundary = true;
        continue;
      }
      chars.push(toHiragana(char));
      starts.push(cluster.start);
      ends.push(cluster.end);
      boundaries.push(pendingBoundary);
      katakana.push(KATAKANA.test(char));
      pendingBoundary = false;
    }
  }
  boundaries.push(true);

  return { text: chars.join(""), starts, ends, boundaries, katakana };
}

/** Compact normalised form of `input` (see module comment). */
export function normalizeCompact(input: string): string {
  return normalizeText(input).text;
}

export function isAsciiAlias(normalizedAlias: string): boolean {
  return ASCII_ALIAS.test(normalizedAlias);
}

function isBoundary(text: NormalizedText, index: number): boolean {
  return text.boundaries[index] ?? true;
}

function asciiBoundaryOk(text: NormalizedText, start: number, end: number): boolean {
  const before = text.text[start - 1];
  const after = text.text[end];
  const leftOk = isBoundary(text, start) || before === undefined || !ASCII_ALNUM.test(before);
  const rightOk = isBoundary(text, end) || after === undefined || !ASCII_ALNUM.test(after);
  return leftOk && rightOk;
}

function katakanaContinuationOk(text: NormalizedText, start: number, end: number): boolean {
  const continuesLeft = start > 0 && !isBoundary(text, start) && text.katakana[start] === true && text.katakana[start - 1] === true;
  const continuesRight =
    end < text.text.length && !isBoundary(text, end) && text.katakana[end - 1] === true && text.katakana[end] === true;
  return !continuesLeft && !continuesRight;
}

/**
 * Find occurrences of a normalised alias inside normalised text.
 * Latin aliases need ASCII word boundaries; katakana matches must not run into a longer
 * katakana word (ミルフィーユ is not ミルフィ).
 */
export function findOccurrences(text: NormalizedText, normalizedAlias: string): Occurrence[] {
  if (normalizedAlias.length === 0) return [];
  const ascii = isAsciiAlias(normalizedAlias);
  const occurrences: Occurrence[] = [];
  let from = 0;
  for (;;) {
    const start = text.text.indexOf(normalizedAlias, from);
    if (start < 0) break;
    const end = start + normalizedAlias.length;
    const ok = (ascii ? asciiBoundaryOk(text, start, end) : true) && katakanaContinuationOk(text, start, end);
    if (ok) occurrences.push({ start, end });
    from = start + 1;
  }
  return occurrences;
}

/** Split a short label (variation name, file name, tag) into normalised tokens. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const cluster of splitClusters(input)) {
    for (const char of normalizeCluster(cluster.value)) {
      if (isSeparator(char)) {
        if (current) tokens.push(current);
        current = "";
        continue;
      }
      current += toHiragana(char);
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Split camelCase words (`OutfitShinano` → `Outfit Shinano`) — used for file names only. */
export function splitCamelCase(input: string): string {
  return input.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Replace URLs and @handles with spaces of equal length so offsets stay aligned. */
export function maskUrls(input: string): string {
  const blank = (match: string): string => " ".repeat(match.length);
  return input.replace(URL_PATTERN, blank).replace(HANDLE_PATTERN, blank);
}

/** Map a compact occurrence back to original offsets. */
export function toOriginalRange(text: NormalizedText, occurrence: Occurrence): Occurrence {
  return {
    start: text.starts[occurrence.start] ?? 0,
    end: text.ends[occurrence.end - 1] ?? 0,
  };
}

/** Quote `original` around [start, end) in at most `max` characters, trimmed. */
export function quoteAround(original: string, start: number, end: number, max = MAX_EVIDENCE_LENGTH): string {
  const trimmed = original.trim();
  if (trimmed.length <= max) return trimmed;
  const ellipsis = "…";
  const budget = max - 2 * ellipsis.length;
  const matchLength = Math.min(end - start, budget);
  const context = Math.floor((budget - matchLength) / 2);
  const from = Math.max(0, Math.min(start - context, original.length - budget));
  const to = Math.min(original.length, from + budget);
  const prefix = from > 0 ? ellipsis : "";
  const suffix = to < original.length ? ellipsis : "";
  return `${prefix}${original.slice(from, to).trim()}${suffix}`;
}

/** Truncate a whole string to the evidence cap. */
export function capEvidence(input: string, max = MAX_EVIDENCE_LENGTH): string {
  const trimmed = input.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Split description text into lines (CRLF tolerant). */
export function splitLines(input: string): string[] {
  return input.split(/\r?\n/);
}
