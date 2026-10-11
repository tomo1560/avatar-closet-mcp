import { classifyKind } from "./kind.js";
import type { NormalizedText } from "./text.js";
import {
  capEvidence,
  findOccurrences,
  maskUrls,
  normalizeCompact,
  normalizeText,
  quoteAround,
  splitLines,
  toOriginalRange,
} from "./text.js";
import type { DependencyHit, DependencyResult, DependencySource, QuestSupport, VrchatItemInput } from "./types.js";

export interface DependencyDefinition {
  readonly id: string;
  readonly name: string;
  /** Aliases matched on normalised text with ASCII word boundaries. */
  readonly aliases: readonly string[];
  /** Case-sensitive pattern on the raw text, for short acronyms that need context (MA, AAO). */
  readonly pattern?: RegExp;
  /** Extra whole-tag aliases (`MA`, `MA対応`). */
  readonly tagAliases?: readonly string[];
}

/**
 * "MA" alone is far too ambiguous (MA-1 jackets, names, MAYA …): it only counts as
 * Modular Avatar when written in upper case as a standalone token followed by a
 * dependency context word (MA対応 / MA必須 / MA導入 / MAで / MA compatible …).
 */
const MA_PATTERN =
  /(?<![A-Za-z0-9])MA(?![A-Za-z0-9])\s*(対応|必須|前提|導入|使用|仕様|版|ベース|方式|用|化|済|で|に|を|が|compatible|support|ready)/;
const AAO_PATTERN = /(?<![A-Za-z0-9])AAO(?![A-Za-z0-9])/;

export const DEPENDENCY_DICTIONARY: readonly DependencyDefinition[] = [
  { id: "liltoon", name: "lilToon", aliases: ["lilToon", "リルトゥーン"] },
  { id: "poiyomi", name: "Poiyomi Toon Shader", aliases: ["Poiyomi", "ポイヨミ"] },
  {
    id: "uts",
    name: "UnityChanToonShader (UTS)",
    aliases: ["UTS2", "UTS3", "UTS", "UCTS", "UnityChanToonShader", "ユニティちゃんトゥーンシェーダー"],
  },
  { id: "sunao", name: "Sunao Shader", aliases: ["Sunao Shader", "Sunaoシェーダー", "スナオシェーダー"] },
  { id: "arktoon", name: "Arktoon Shaders", aliases: ["arktoon"] },
  {
    id: "modular_avatar",
    name: "Modular Avatar",
    aliases: ["Modular Avatar", "ModuleAvatar", "モジュラーアバター"],
    pattern: MA_PATTERN,
    tagAliases: ["MA"],
  },
  { id: "vrcfury", name: "VRCFury", aliases: ["VRCFury"] },
  {
    id: "avatar_optimizer",
    name: "Avatar Optimizer (AAO)",
    aliases: ["Avatar Optimizer", "アバターオプティマイザー"],
    pattern: AAO_PATTERN,
    tagAliases: ["AAO"],
  },
  { id: "ndmf", name: "NDMF", aliases: ["NDMF", "Non-Destructive Modular Framework"] },
  { id: "faceemo", name: "FaceEmo", aliases: ["FaceEmo"] },
  { id: "vrcquesttools", name: "VRCQuestTools", aliases: ["VRCQuestTools"] },
  { id: "lilycal_inventory", name: "lilycalInventory", aliases: ["lilycalInventory", "リリカルインベントリ"] },
];

const TAG_SUFFIX = /^(対応|必須|用|前提|使用|導入|ベース|べーす)?$/;
const NOT_REQUIRED = /^(は|が|の)?(不要|非対応|未対応|なし|無し|不使用|使用しません|notrequired|notneeded|unnecessary)/;
/** After a tool's own name in its item title: anything else means "for/with" that tool. */
const DEPENDENCY_CONTEXT = /^(対応|用|必須|前提|向け|版|べーす|使用|導入|compatible|support)/;

const QUEST_WORD = "(quest|くえすと|android|あんどろいど)";
const QUEST_NO = new RegExp(
  `${QUEST_WORD}(版|では|には|は|への|に|で)?(非対応|未対応|対応外|対象外|不可|なし|無し|対応して(い|おり)?(ません|ない)|対応しません|対応できません|使用不可|使用できません|notsupported|isnotsupported|notcompatible|isnotcompatible|incompatible|unsupported)` +
    "|(pc|ぴーしー)(版)?(専用|のみ|only)|not(quest|android)(compatible|supported|ready)|noquest",
);
const QUEST_YES = new RegExp(
  `${QUEST_WORD}(版|両)?(対応|可|あり|有り|compatible|supported|ready|用)(?!して(い|おり)?(ません|ない)|しません|できません|不可)`,
);
const QUEST_TAG = /^(quest|くえすと|android|あんどろいど)$/;

interface QuestSignal {
  readonly value: "yes" | "no";
  readonly source: DependencySource;
  readonly evidence: string;
}

function definitionAliases(definition: DependencyDefinition): string[] {
  return definition.aliases.map(normalizeCompact);
}

function isNegated(text: NormalizedText, end: number): boolean {
  return NOT_REQUIRED.test(text.text.slice(end, end + 12));
}

function matchInText(line: string, definition: DependencyDefinition): string | null {
  const masked = maskUrls(line);
  const normalized = normalizeText(masked);
  for (const alias of definitionAliases(definition)) {
    const occurrence = findOccurrences(normalized, alias).find((o) => !isNegated(normalized, o.end));
    if (occurrence) {
      const range = toOriginalRange(normalized, occurrence);
      return quoteAround(line, range.start, range.end);
    }
  }
  const special = definition.pattern?.exec(masked);
  return special ? quoteAround(line, special.index, special.index + special[0].length) : null;
}

function matchTagName(tag: string, definition: DependencyDefinition): boolean {
  const normalized = normalizeCompact(tag);
  const aliases = [...definitionAliases(definition), ...(definition.tagAliases ?? []).map(normalizeCompact)];
  return aliases.some((alias) => normalized.startsWith(alias) && TAG_SUFFIX.test(normalized.slice(alias.length)));
}

/** A tool item (e.g. lilToon itself, category 215) does not depend on itself. */
function isSelf(item: VrchatItemInput, definition: DependencyDefinition): boolean {
  if (classifyKind(item) !== "tool") return false;
  const normalized = normalizeText(item.name);
  return definitionAliases(definition).some((alias) =>
    findOccurrences(normalized, alias).some((o) => !DEPENDENCY_CONTEXT.test(normalized.text.slice(o.end))),
  );
}

function findDependency(item: VrchatItemInput, definition: DependencyDefinition): DependencyHit | null {
  const make = (source: DependencySource, evidence: string): DependencyHit => ({
    id: definition.id,
    name: definition.name,
    source,
    evidence: capEvidence(evidence),
  });
  const tag = item.tags.find((t) => matchTagName(t.name, definition));
  if (tag) return make("tag", tag.name);
  const fromName = matchInText(item.name, definition);
  if (fromName) return make("name", fromName);
  for (const variation of item.variations) {
    const fromVariation = variation.name ? matchInText(variation.name, definition) : null;
    if (fromVariation) return make("variation", fromVariation);
  }
  for (const line of splitLines(item.description)) {
    const fromLine = matchInText(line, definition);
    if (fromLine) return make("description", fromLine);
  }
  return null;
}

function questSignal(text: string, source: DependencySource): QuestSignal | null {
  const normalized = normalizeText(maskUrls(text));
  for (const [value, pattern] of [["no", QUEST_NO], ["yes", QUEST_YES]] as const) {
    const match = pattern.exec(normalized.text);
    if (match) {
      const range = toOriginalRange(normalized, { start: match.index, end: match.index + match[0].length });
      return { value, source, evidence: quoteAround(text, range.start, range.end) };
    }
  }
  return null;
}

function questSignals(item: VrchatItemInput): QuestSignal[] {
  const tagSignals = item.tags.map((tag) =>
    QUEST_TAG.test(normalizeCompact(tag.name))
      ? { value: "yes" as const, source: "tag" as const, evidence: capEvidence(tag.name) }
      : questSignal(tag.name, "tag"),
  );
  const variationSignals = item.variations.map((v) => (v.name ? questVariationSignal(v.name) : null));
  const textSignals = [item.name, ...splitLines(item.description)].map((line, i) =>
    questSignal(line, i === 0 ? "name" : "description"),
  );
  return [...variationSignals, ...tagSignals, ...textSignals].filter((s): s is QuestSignal => s !== null);
}

function questVariationSignal(name: string): QuestSignal | null {
  const explicit = questSignal(name, "variation");
  if (explicit) return explicit;
  return new RegExp(QUEST_WORD).test(normalizeCompact(name))
    ? { value: "yes", source: "variation", evidence: capEvidence(name) }
    : null;
}

/**
 * Quest/Android support. A dedicated Quest variation wins (you can buy that version);
 * otherwise any explicit "no" (PC専用, Quest非対応) wins over "yes" because claiming
 * Quest support wrongly is the costlier mistake; otherwise "yes"; otherwise unknown.
 */
function resolveQuest(signals: readonly QuestSignal[]): { support: QuestSupport; evidence: string | null } {
  const pick =
    signals.find((s) => s.source === "variation" && s.value === "yes") ??
    signals.find((s) => s.value === "no") ??
    signals.find((s) => s.value === "yes");
  return pick ? { support: pick.value, evidence: pick.evidence } : { support: "unknown", evidence: null };
}

/** Shader / tool dependencies and Quest support, each with quoted evidence (PLAN §3.5.4). */
export function extractDependencies(item: VrchatItemInput): DependencyResult {
  const dependencies = DEPENDENCY_DICTIONARY.filter((definition) => !isSelf(item, definition))
    .map((definition) => findDependency(item, definition))
    .filter((hit): hit is DependencyHit => hit !== null);
  const quest = resolveQuest(questSignals(item));
  return { dependencies, quest_support: quest.support, quest_evidence: quest.evidence };
}
