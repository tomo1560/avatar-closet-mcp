import type { AvatarMention } from "./description.js";
import { findHeadingBlocks, findNegations, findRedirectLines, quoteMatch } from "./description.js";
import { extractAvatarDisplayName, isAvatarBody } from "./kind.js";
import type { AvatarIndex } from "./matcher.js";
import { buildAvatarIndex, findAvatarMatches, matchLabelTokens, matchTag, resolveAvatarId } from "./matcher.js";
import { capEvidence, maskUrls, normalizeCompact, normalizeText, splitLines } from "./text.js";
import type {
  AvatarDictionary,
  AvatarEvidence,
  CompatibilityCheck,
  CompatibilityResult,
  CompatibilitySource,
  CompatibleAvatar,
  Confidence,
  OwnershipContext,
  VrchatItemInput,
} from "./types.js";
import { uniqueBy } from "./util.js";

interface Hit extends CompatibleAvatar {
  /** Excluded from compatible_avatars (e.g. tag-only name in a per-avatar variation item). */
  readonly gatedReason?: string;
}

interface Analysis {
  readonly result: CompatibilityResult;
  readonly hits: readonly Hit[];
  readonly negations: readonly AvatarMention[];
}

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { high: 3, medium: 2, low: 1 };
const SOURCE_RANK: Readonly<Record<CompatibilitySource, number>> = {
  variation: 6, tag: 5, description_heading: 4, name: 3, file_name: 2, description: 1,
};
const FULL_SET = /(fullset|fullpack|ふるせっと|ふるぱっく|全部入り|全部いり|全入り|ばりゅーぱっく|allinone|こんぷりーと|complete)/;
const AUXILIARY = /(投げ銭|donat|支援|利用規約|規約|terms|readme|おまけ|さんぷる|sample)/;
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const GATED_BY_VARIATIONS = "named outside the per-avatar variations; no purchasable version for this avatar";

function hit(avatar: string, confidence: Confidence, source: CompatibilitySource, evidence: string): Hit {
  return { avatar, confidence, source, evidence: capEvidence(evidence) };
}

function variationAvatarIds(name: string, index: AvatarIndex): string[] {
  const ids = matchLabelTokens(name, index);
  if (ids.length > 0) return ids;
  return findAvatarMatches(normalizeText(maskUrls(name)), index, "strict").map((m) => m.avatarId);
}

interface VariationAnalysis {
  readonly hits: readonly Hit[];
  readonly avatars: ReadonlySet<string>;
  /** Item is sold as one variation per avatar (most variations name an avatar). */
  readonly split: boolean;
}

function analyzeVariations(names: readonly string[], index: AvatarIndex): VariationAnalysis {
  const hits: Hit[] = [];
  let avatarVariations = 0;
  let regularVariations = 0;
  for (const name of names) {
    const compact = normalizeCompact(name);
    const ids = variationAvatarIds(name, index);
    if (ids.length > 0) avatarVariations += 1;
    if (ids.length > 0 || !(FULL_SET.test(compact) || AUXILIARY.test(compact))) regularVariations += 1;
    hits.push(...ids.map((id) => hit(id, "high", "variation", name)));
  }
  const avatars = new Set(hits.map((h) => h.avatar));
  return { hits, avatars, split: avatarVariations > 0 && avatarVariations * 2 > regularVariations };
}

function analyzeTags(item: VrchatItemInput, index: AvatarIndex): { hits: Hit[]; negations: AvatarMention[] } {
  const hits: Hit[] = [];
  const negations: AvatarMention[] = [];
  for (const tag of item.tags) {
    const match = matchTag(tag.name, index);
    if (!match) continue;
    if (match.negated) negations.push({ avatarId: match.avatarId, evidence: capEvidence(tag.name) });
    else hits.push(hit(match.avatarId, "high", "tag", tag.name));
  }
  return { hits, negations };
}

function textHits(text: string, index: AvatarIndex, confidence: Confidence, source: CompatibilitySource): Hit[] {
  const normalized = normalizeText(maskUrls(text));
  return findAvatarMatches(normalized, index, "strict").map((m) =>
    hit(m.avatarId, confidence, source, quoteMatch(text, normalized, m)),
  );
}

interface DescriptionAnalysis {
  readonly headingHits: readonly Hit[];
  readonly freeHits: readonly Hit[];
  readonly negations: readonly AvatarMention[];
  readonly headingAvatars: ReadonlySet<string>;
}

function analyzeDescription(description: string, index: AvatarIndex): DescriptionAnalysis {
  const lines = splitLines(description);
  const blocks = findHeadingBlocks(description, index);
  const consumed = new Set<number>([...findRedirectLines(description)]);
  const headingHits: Hit[] = [];
  const negations: AvatarMention[] = [...findNegations(description, index)];
  for (const block of blocks) {
    consumed.add(block.headingLine);
    for (const line of block.lines) {
      consumed.add(line.lineIndex);
      const normalized = normalizeText(maskUrls(line.text));
      for (const m of findAvatarMatches(normalized, index, "structured")) {
        const evidence = quoteMatch(line.text, normalized, m);
        if (block.negative) negations.push({ avatarId: m.avatarId, evidence });
        else headingHits.push(hit(m.avatarId, "high", "description_heading", evidence));
      }
    }
  }
  const freeHits = lines.flatMap((line, i) => (consumed.has(i) ? [] : textHits(line, index, "low", "description")));
  return { headingHits, freeHits, negations, headingAvatars: new Set(headingHits.map((h) => h.avatar)) };
}

function fileHits(fileNames: readonly string[], index: AvatarIndex, known: ReadonlySet<string>): Hit[] {
  const restricted = new Set(index.aliases.filter((a) => a.restricted).map((a) => a.avatarId));
  return fileNames.flatMap((fileName) =>
    matchLabelTokens(fileName.replace(FILE_EXTENSION, ""), index, true)
      .filter((id) => !restricted.has(id) || known.has(id))
      .map((id) => hit(id, "medium", "file_name", fileName)),
  );
}

function detectSelfAvatar(item: VrchatItemInput, index: AvatarIndex): string | null {
  if (!isAvatarBody(item)) return null;
  const displayName = extractAvatarDisplayName(item.name);
  const fromName = displayName ? matchLabelTokens(displayName, index)[0] : undefined;
  return fromName ?? findAvatarMatches(normalizeText(item.name), index, "structured")[0]?.avatarId ?? null;
}

function better(a: Hit, b: Hit): boolean {
  const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  return byConfidence !== 0 ? byConfidence > 0 : SOURCE_RANK[a.source] > SOURCE_RANK[b.source];
}

function bestPerAvatar(hits: readonly Hit[]): Hit[] {
  const best = new Map<string, Hit>();
  for (const h of hits) {
    const current = best.get(h.avatar);
    if (!current || better(h, current)) best.set(h.avatar, h);
  }
  return [...best.values()].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
}

function applyListPolicy(hits: readonly Hit[], variations: VariationAnalysis, headingAvatars: ReadonlySet<string>): Hit[] {
  if (variations.split) {
    return hits.map((h) => (variations.avatars.has(h.avatar) ? h : { ...h, gatedReason: GATED_BY_VARIATIONS }));
  }
  if (headingAvatars.size === 0) return [...hits];
  // A 対応アバター list exists: names outside it are kept only as low-confidence hints.
  return hits.map((h) => (headingAvatars.has(h.avatar) || h.source === "variation" ? h : { ...h, confidence: "low" }));
}

function ownedVersions(
  ownership: OwnershipContext | undefined,
  variations: VariationAnalysis,
  index: AvatarIndex,
  fileAvatarHits: readonly Hit[],
): AvatarEvidence[] {
  const fromVariations = (ownership?.ownedVariationNames ?? []).flatMap((name) => {
    const ids = FULL_SET.test(normalizeCompact(name)) ? [...variations.avatars] : variationAvatarIds(name, index);
    return ids.map((avatar) => ({ avatar, evidence: capEvidence(name) }));
  });
  const fromFiles = fileAvatarHits.map((h) => ({ avatar: h.avatar, evidence: h.evidence }));
  return uniqueBy([...fromVariations, ...fromFiles], (entry) => entry.avatar);
}

function analyze(item: VrchatItemInput, dictionary: AvatarDictionary, ownership?: OwnershipContext): Analysis {
  const index = buildAvatarIndex(dictionary);
  const variationNames = [
    ...item.variations.map((v) => v.name).filter((n): n is string => typeof n === "string" && n.trim() !== ""),
    ...(ownership?.ownedVariationNames ?? []),
  ];
  const variations = analyzeVariations([...new Set(variationNames)], index);
  const tags = analyzeTags(item, index);
  const description = analyzeDescription(item.description, index);
  const nameHits = textHits(item.name, index, "medium", "name");
  const known = new Set([...variations.avatars, ...tags.hits.map((h) => h.avatar), ...description.headingAvatars]);
  const files = fileHits(ownership?.ownedFileNames ?? [], index, known);

  const selfAvatar = detectSelfAvatar(item, index);
  const negations = [...tags.negations, ...description.negations].filter((n) => n.avatarId !== selfAvatar);
  const negated = new Set(negations.map((n) => n.avatarId));
  const raw = [...variations.hits, ...tags.hits, ...description.headingHits, ...nameHits, ...files, ...description.freeHits];
  const hits = applyListPolicy(raw, variations, description.headingAvatars).filter(
    (h) => h.avatar !== selfAvatar && !negated.has(h.avatar),
  );

  const compatible = bestPerAvatar(hits.filter((h) => h.gatedReason === undefined)).map(
    ({ avatar, confidence, source, evidence }) => ({ avatar, confidence, source, evidence }),
  );
  const notSupported = bestNegations(negations);
  const owned = ownedVersions(ownership, variations, index, files).filter(
    (o) => o.avatar !== selfAvatar && !negated.has(o.avatar),
  );
  return {
    result: { compatible_avatars: compatible, not_supported: notSupported, owned_versions: owned, self_avatar: selfAvatar },
    hits,
    negations,
  };
}

function bestNegations(negations: readonly AvatarMention[]): AvatarEvidence[] {
  return uniqueBy(negations, (n) => n.avatarId).map((n) => ({ avatar: n.avatarId, evidence: n.evidence }));
}

/**
 * Extract avatar compatibility evidence from an item (PLAN §3.5.2).
 *
 * - variations / tags / 対応アバター heading block → high; item name → medium;
 *   downloaded file names → medium; free description text → low.
 * - Per-avatar variation items: names found only outside the variations are dropped
 *   (nothing to buy for them). When a heading list exists, names outside it become low.
 * - Explicit negations go to `not_supported` and are removed from `compatible_avatars`.
 * - Avatar bodies never list themselves; their own avatar is returned as `self_avatar`.
 */
export function extractCompatibility(
  item: VrchatItemInput,
  dictionary: AvatarDictionary,
  ownership?: OwnershipContext,
): CompatibilityResult {
  return analyze(item, dictionary, ownership).result;
}

function adHocDictionary(query: string, dictionary: AvatarDictionary): { id: string; dictionary: AvatarDictionary } {
  const id = normalizeCompact(query);
  return { id, dictionary: [...dictionary, { id, names: [query.trim()] }] };
}

function unknown(avatar: string, evidence: readonly string[] = [], reason?: string): CompatibilityCheck {
  return reason === undefined ? { avatar, result: "unknown", evidence } : { avatar, result: "unknown", evidence, reason };
}

/**
 * Answer "does this item support <avatar>?" with quoted evidence. `avatarQuery` may be a
 * dictionary id or any alias; names missing from the dictionary are matched literally.
 * Never returns `supported` without evidence.
 */
export function checkCompatibility(
  item: VrchatItemInput,
  avatarQuery: string,
  dictionary: AvatarDictionary,
  ownership?: OwnershipContext,
): CompatibilityCheck {
  const knownId = resolveAvatarId(avatarQuery, dictionary);
  const resolved = knownId ? { id: knownId, dictionary } : adHocDictionary(avatarQuery, dictionary);
  if (!resolved.id) return unknown(avatarQuery.trim());

  const analysis = analyze(item, resolved.dictionary, ownership);
  const avatar = resolved.id;
  if (analysis.result.self_avatar === avatar) {
    return unknown(avatar, [capEvidence(item.name)], "this item is the avatar body itself");
  }
  const negations = analysis.negations.filter((n) => n.avatarId === avatar).map((n) => n.evidence);
  if (negations.length > 0) return { avatar, result: "not_supported", evidence: [...new Set(negations)] };

  const best = analysis.result.compatible_avatars.find((c) => c.avatar === avatar);
  const avatarHits = analysis.hits.filter((h) => h.avatar === avatar);
  if (best) {
    const evidence = bestPerAvatarEvidence(avatarHits.filter((h) => h.gatedReason === undefined));
    return { avatar, result: "supported", confidence: best.confidence, evidence };
  }
  const gated = avatarHits.filter((h) => h.gatedReason !== undefined);
  if (gated.length > 0) return unknown(avatar, bestPerAvatarEvidence(gated), gated[0]?.gatedReason);
  return unknown(avatar);
}

function bestPerAvatarEvidence(hits: readonly Hit[]): string[] {
  const sorted = [...hits].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  return [...new Set(sorted.map((h) => h.evidence))].slice(0, 5);
}
