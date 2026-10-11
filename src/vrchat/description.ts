import type { AvatarIndex, AvatarMatch } from "./matcher.js";
import { findAvatarMatches } from "./matcher.js";
import type { NormalizedText } from "./text.js";
import { maskUrls, normalizeCompact, normalizeText, quoteAround, splitLines, toOriginalRange } from "./text.js";

/** A line (or the inline tail of a heading line) inside a 対応アバター block. */
export interface BlockLine {
  readonly lineIndex: number;
  /** Text to match (heading keyword removed for inline content). */
  readonly text: string;
}

export interface HeadingBlock {
  /** True for 非対応アバター / Unsupported avatars blocks. */
  readonly negative: boolean;
  readonly headingLine: number;
  readonly lines: readonly BlockLine[];
}

export interface AvatarMention {
  readonly avatarId: string;
  readonly evidence: string;
}

const MAX_BLOCK_LINES = 60;
const HEADING_KEYWORD =
  /^(非|未)?対応(あばたー|もでる|素体|ぼでぃ|きゃらくたー)(一覧|様|さま|りすと)?|^(un|not)?(supported|compatible)(avatar|model)s?(list)?|^対応(?=$)/;
const BARE_TAIOU_HEADING = /^\s*(?:[【[［]\s*対応\s*[】\]］]|対応\s*[:：])\s*/;
const HEADING_LEAD_IN = /^(は以下|は下記|は次|について)/;
const HEADING_SEPARATOR = /^[\s:：】\]］>＞→\-－=＝■□◆◇●○★☆|｜/]+/;
const SECTION_MARKER = /^[■□◆◇●○★☆▼▽▶▷►♦◎◉#＃]/;
const BRACKET_LINE = /^(【[^】]*】|\[[^\]]*\])$/;
const SECTION_KEYWORD =
  /^(注意|利用規約|規約|内容物|内容|仕様|更新|履歴|導入|使い方|お問い合わせ|問い合わせ|免責|くれじっと|credit|ぽりごん|polygon|価格|terms|notes?|caution|contents|changelog)/;
const REDIRECT = /(こちら|別売|別商品|別ぺーじ|別途販売|別の商品|separately)/;
const BODY_LINK = /本体/;
const SENTENCE_SPLIT = /[。！!？?]/;
const CHAIN_GAP = /^(と|や|および|及び|and)?$/;
const NEGATION_AFTER =
  /^(ちゃん|くん|さん|様|さま)?(用|版|向け)?(には|では|へは|とは|への|での|は|に|へ|も|で)?(ご)?(着用|使用|利用|導入|着せ替え)?(は)?(非対応|未対応|対象外|対応外|さぽーと外|非さぽーと|対応不可|使用不可|不可|できません|いただけません|対応して(い|おり)?(ません|ない)|対応しません|対応しない|対応できません|さぽーとして(い|おり)?(ません|ない)|isnotsupported|notsupported|unsupported|isnotcompatible|notcompatible|isincompatible|incompatible)/;
const NEGATION_BEFORE = /(notcompatiblewith|notsupportedfor|doesnotsupport|incompatiblewith|cannotbeusedwith|cannotbeusedon|notfor)$/;

interface HeadingInfo {
  readonly negative: boolean;
  readonly inline: string;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && (normalizeCompact(trimmed) === "" || /^[ー\s]+$/.test(trimmed));
}

/** Detect a 対応アバター style heading; returns its inline tail (may be empty). */
export function parseHeading(line: string): HeadingInfo | null {
  const bare = BARE_TAIOU_HEADING.exec(line);
  if (bare) return { negative: false, inline: line.slice(bare[0].length).trim() };
  const normalized = normalizeText(line);
  const match = HEADING_KEYWORD.exec(normalized.text);
  if (!match) return null;
  const keywordEnd = normalized.ends[match[0].length - 1] ?? line.length;
  const tail = line.slice(keywordEnd);
  const separator = HEADING_SEPARATOR.exec(tail)?.[0] ?? "";
  const inline = tail.slice(separator.length).trim();
  const restCompact = normalized.text.slice(match[0].length);
  const isHeading = inline === "" || separator.trim() !== "" || HEADING_LEAD_IN.test(restCompact);
  if (!isHeading) return null;
  const negative = Boolean(match[1]) || /^(un|not)/.test(match[0]);
  return { negative, inline: HEADING_LEAD_IN.test(restCompact) ? "" : inline };
}

function hasAvatar(line: string, index: AvatarIndex): boolean {
  return findAvatarMatches(normalizeText(maskUrls(line)), index, "structured").length > 0;
}

function endsBlock(line: string, index: AvatarIndex): boolean {
  const trimmed = line.trim();
  if (isSeparatorLine(trimmed) || parseHeading(trimmed)) return true;
  const sectionLike =
    SECTION_MARKER.test(trimmed) || BRACKET_LINE.test(trimmed) || SECTION_KEYWORD.test(normalizeCompact(trimmed));
  return sectionLike && !hasAvatar(trimmed, index);
}

function collectBlockLines(lines: readonly string[], start: number, inline: boolean, index: AvatarIndex): BlockLine[] {
  const collected: BlockLine[] = [];
  let blankRun = 0;
  for (let i = start; i < Math.min(lines.length, start + MAX_BLOCK_LINES); i += 1) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      blankRun += 1;
      if (blankRun >= 2 || inline) break;
      continue;
    }
    if (endsBlock(line, index)) break;
    const needsAvatar = inline || (collected.length > 0 && blankRun > 0);
    if (needsAvatar && !hasAvatar(line, index)) break;
    blankRun = 0;
    collected.push({ lineIndex: i, text: line });
  }
  return collected;
}

/** Find 対応アバター / 非対応アバター heading blocks in a description. */
export function findHeadingBlocks(description: string, index: AvatarIndex): HeadingBlock[] {
  const lines = splitLines(description);
  const blocks: HeadingBlock[] = [];
  lines.forEach((line, i) => {
    const heading = parseHeading(line);
    if (!heading) return;
    const inlineLine: BlockLine[] = heading.inline ? [{ lineIndex: i, text: heading.inline }] : [];
    const following = collectBlockLines(lines, i + 1, heading.inline !== "", index);
    blocks.push({ negative: heading.negative, headingLine: i, lines: [...inlineLine, ...following] });
  });
  return blocks;
}

/**
 * Lines pointing to *other* products (「真冬用、サリア用はこちら」 + following URL lines).
 * Body links (「しなのちゃん本体はこちら」) are not redirects.
 */
export function findRedirectLines(description: string): ReadonlySet<number> {
  const lines = splitLines(description);
  const redirect = new Set<number>();
  let inRegion = false;
  lines.forEach((line, i) => {
    const compact = normalizeCompact(maskUrls(line));
    if (REDIRECT.test(compact) && !BODY_LINK.test(compact)) {
      redirect.add(i);
      inRegion = true;
      return;
    }
    const isLinkLine = /https?:\/\//.test(line);
    if (inRegion && (isBlank(line) || isLinkLine)) {
      redirect.add(i);
      return;
    }
    inRegion = false;
  });
  return redirect;
}

/** Quote the original text of a match (masked text keeps offsets aligned with `original`). */
export function quoteMatch(original: string, normalized: NormalizedText, match: AvatarMatch): string {
  const range = toOriginalRange(normalized, match);
  return quoteAround(original, range.start, range.end);
}

function chains(text: NormalizedText, matches: readonly AvatarMatch[]): AvatarMatch[][] {
  const result: AvatarMatch[][] = [];
  for (const match of matches) {
    const current = result[result.length - 1];
    const last = current?.[current.length - 1];
    if (current && last && CHAIN_GAP.test(text.text.slice(last.end, match.start))) {
      current.push(match);
    } else {
      result.push([match]);
    }
  }
  return result;
}

function negatedInSentence(sentence: string, index: AvatarIndex): AvatarMention[] {
  const normalized = normalizeText(maskUrls(sentence));
  const mentions: AvatarMention[] = [];
  for (const chain of chains(normalized, findAvatarMatches(normalized, index, "structured"))) {
    const first = chain[0];
    const last = chain[chain.length - 1];
    if (!first || !last) continue;
    const after = normalized.text.slice(last.end);
    const before = normalized.text.slice(0, first.start);
    if (!NEGATION_AFTER.test(after) && !NEGATION_BEFORE.test(before)) continue;
    const evidence = quoteMatch(sentence, normalized, first);
    mentions.push(...chain.map((m) => ({ avatarId: m.avatarId, evidence })));
  }
  return mentions;
}

/** Explicit negations: 「〇〇には非対応」「〇〇は対象外」「Not compatible with 〇〇」. */
export function findNegations(text: string, index: AvatarIndex): AvatarMention[] {
  return splitLines(text).flatMap((line) =>
    line
      .split(SENTENCE_SPLIT)
      .filter((sentence) => sentence.trim() !== "")
      .flatMap((sentence) => negatedInSentence(sentence, index)),
  );
}
