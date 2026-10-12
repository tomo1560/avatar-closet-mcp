/**
 * Local-only evaluation of the VRChat extractors on the developer's own BOOTH library (PLAN §7-11, Phase 2.5).
 *
 * Data lives in the gitignored tests/fixtures/private/library-eval/:
 * - items/{id}.json: cached `items/{id}.json` of purchased items (categories 208 / 209 / 210 / 217 / 230)
 * - labels.json: hand labels in the tests/fixtures/public/compat-labels.json format. `compatible`, `not_supported`
 *   and `must_not_match` may hold dictionary ids or raw avatar names (raw names outside the dictionary are counted
 *   as "not in dictionary", not as extractor misses).
 *
 * The purchase list is personal, so the suite is skipped when that directory is absent (CI, other clones), and test
 * names and assertions carry aggregate counts only, never ids, names or quotes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mergeAvatarDictionaries, suggestAvatarsFromLibrary } from "../src/vrchat/avatars.js";
import { extractCompatibility } from "../src/vrchat/compatibility.js";
import { extractDependencies } from "../src/vrchat/dependencies.js";
import { classifyKind } from "../src/vrchat/kind.js";
import { resolveAvatarId } from "../src/vrchat/matcher.js";
import { SEED_AVATARS } from "../src/vrchat/seed-avatars.js";
import { normalizeCompact } from "../src/vrchat/text.js";
import type { AvatarDictionary, VrchatItemInput, VrchatKind } from "../src/vrchat/types.js";

interface Label {
  readonly kind: VrchatKind;
  readonly avatar_id?: string;
  readonly compatible: readonly string[];
  readonly not_supported: readonly string[];
  readonly dependencies: readonly string[];
  readonly quest_support: string;
  readonly must_not_match: readonly string[];
}

interface Metrics {
  readonly items: number;
  readonly pairs: number;
  readonly notInDictionary: number;
  readonly highFalsePositives: number;
  readonly anyFalsePositives: number;
  readonly mustNotMatchHits: number;
  /** must_not_match terms reported at medium or high confidence. */
  readonly mustNotMatchConfident: number;
  readonly found: number;
  readonly foundHigh: number;
  readonly kindCorrect: number;
  readonly questCorrect: number;
  readonly depsCorrect: number;
  readonly notSupportedCorrect: number;
  readonly bodies: number;
  readonly bodiesCorrect: number;
}

const EVAL_DIR = join(import.meta.dirname, "fixtures", "private", "library-eval");
const ITEMS_DIR = join(EVAL_DIR, "items");
const LABELS_FILE = join(EVAL_DIR, "labels.json");
const hasEvalData = existsSync(LABELS_FILE) && existsSync(ITEMS_DIR);
// Floors measured on the private set (2026-10-12, 52 labelled items); a drop below them is a regression.
// The one tolerated false positive is a low-confidence name in a body-scale table.
const ANY_FALSE_POSITIVE_BUDGET = 1;
const MIN_RECALL_ANY = 0.99;
const MIN_RECALL_HIGH = 0.98;
const MIN_KIND_ACCURACY = 0.9;
const MIN_QUEST_ACCURACY = 0.95;
const MIN_DEPENDENCY_ACCURACY = 0.95;

function loadLabels(): Record<string, Label> {
  return JSON.parse(readFileSync(LABELS_FILE, "utf8")) as Record<string, Label>;
}

function loadItems(): VrchatItemInput[] {
  return readdirSync(ITEMS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(ITEMS_DIR, file), "utf8")) as VrchatItemInput);
}

/** Label terms outside the dictionary get a synthetic id so they never count as found. */
function resolveTerm(term: string, dictionary: AvatarDictionary): string {
  return resolveAvatarId(term, dictionary) ?? `unknown:${normalizeCompact(term)}`;
}

/** must_not_match raw strings are added to the dictionary so a false positive on them is observable. */
function withMustNotMatch(base: AvatarDictionary, labels: readonly Label[]): AvatarDictionary {
  const extra = labels
    .flatMap((label) => label.must_not_match)
    .filter((term) => resolveAvatarId(term, base) === null)
    .map((term) => ({ id: `mnm:${normalizeCompact(term)}`, names: [term] }));
  return [...base, ...extra];
}

/** SEED plus the entries `avatars init` would add from the owned avatar bodies (category 208). */
function libraryDictionary(items: readonly VrchatItemInput[]): AvatarDictionary {
  const additions = suggestAvatarsFromLibrary(items, SEED_AVATARS)
    .filter((suggestion) => !suggestion.in_dictionary)
    .map((suggestion) => ({ id: suggestion.id_suggestion, names: suggestion.names }));
  return mergeAvatarDictionaries(SEED_AVATARS, additions);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return [...new Set(a)].sort().join("\n") === [...new Set(b)].sort().join("\n");
}

function measure(items: readonly VrchatItemInput[], labels: Record<string, Label>, base: AvatarDictionary): Metrics {
  const labelled = items.filter((item) => labels[String(item.id)] !== undefined);
  const dictionary = withMustNotMatch(base, labelled.map((item) => labels[String(item.id)] as Label));
  let pairs = 0;
  let notInDictionary = 0;
  let highFalsePositives = 0;
  let anyFalsePositives = 0;
  let mustNotMatchHits = 0;
  let mustNotMatchConfident = 0;
  let found = 0;
  let foundHigh = 0;
  let kindCorrect = 0;
  let questCorrect = 0;
  let depsCorrect = 0;
  let notSupportedCorrect = 0;
  let bodies = 0;
  let bodiesCorrect = 0;
  for (const item of labelled) {
    const label = labels[String(item.id)] as Label;
    const compat = extractCompatibility(item, dictionary);
    const deps = extractDependencies(item);
    const expected = new Set(label.compatible.map((term) => resolveTerm(term, dictionary)));
    const mustNot = new Set(label.must_not_match.map((term) => resolveTerm(term, dictionary)));
    for (const avatar of compat.compatible_avatars) {
      const wrong = !expected.has(avatar.avatar) || mustNot.has(avatar.avatar);
      if (wrong) anyFalsePositives += 1;
      if (wrong && avatar.confidence === "high") highFalsePositives += 1;
      if (mustNot.has(avatar.avatar)) mustNotMatchHits += 1;
      if (mustNot.has(avatar.avatar) && avatar.confidence !== "low") mustNotMatchConfident += 1;
    }
    for (const avatar of expected) {
      pairs += 1;
      if (avatar.startsWith("unknown:")) {
        notInDictionary += 1;
        continue;
      }
      const hit = compat.compatible_avatars.find((a) => a.avatar === avatar);
      if (hit) found += 1;
      if (hit?.confidence === "high") foundHigh += 1;
    }
    if (classifyKind(item) === label.kind) kindCorrect += 1;
    if (deps.quest_support === label.quest_support) questCorrect += 1;
    if (sameSet(deps.dependencies.map((d) => d.id), label.dependencies)) depsCorrect += 1;
    const negated = label.not_supported.map((term) => resolveTerm(term, dictionary));
    if (sameSet(compat.not_supported.map((n) => n.avatar), negated)) notSupportedCorrect += 1;
    if (label.kind === "avatar") {
      bodies += 1;
      // A body whose avatar is not in the dictionary cannot be named, so null is the right answer there.
      const resolvedSelf = label.avatar_id === undefined ? null : resolveTerm(label.avatar_id, dictionary);
      const expectedSelf = resolvedSelf?.startsWith("unknown:") ? null : resolvedSelf;
      if (compat.self_avatar === expectedSelf) bodiesCorrect += 1;
    }
  }
  return {
    items: labelled.length,
    pairs,
    notInDictionary,
    highFalsePositives,
    anyFalsePositives,
    mustNotMatchHits,
    mustNotMatchConfident,
    found,
    foundHigh,
    kindCorrect,
    questCorrect,
    depsCorrect,
    notSupportedCorrect,
    bodies,
    bodiesCorrect,
  };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}% (${part}/${whole})`;
}

const labels = hasEvalData ? loadLabels() : {};
const items = hasEvalData ? loadItems() : [];
const seed = hasEvalData ? measure(items, labels, SEED_AVATARS) : undefined;
const library = hasEvalData ? measure(items, labels, libraryDictionary(items)) : undefined;

describe.skipIf(!hasEvalData)("VRChat extractors on the private library set (local only)", () => {
  const m = seed as Metrics;
  const reachable = m === undefined ? 0 : m.pairs - m.notInDictionary;

  it(`labels every evaluated item (${m?.items ?? 0} labelled)`, () => {
    expect(m.items).toBeGreaterThanOrEqual(40);
  });

  it(`has zero high-confidence false positives (found ${m?.highFalsePositives ?? 0})`, () => {
    expect(m.highFalsePositives).toBe(0);
  });

  it(`never reports a must_not_match term above low confidence (low: ${m?.mustNotMatchHits ?? 0})`, () => {
    expect(m.mustNotMatchConfident).toBe(0);
    expect(m.mustNotMatchHits).toBeLessThanOrEqual(ANY_FALSE_POSITIVE_BUDGET);
  });

  it(`false positives at any confidence: ${m?.anyFalsePositives ?? 0}`, () => {
    expect(m.anyFalsePositives).toBeLessThanOrEqual(ANY_FALSE_POSITIVE_BUDGET);
  });

  it(`recall (seed dictionary) any ${pct(m?.found ?? 0, reachable)}, high ${pct(m?.foundHigh ?? 0, reachable)}; not in dictionary ${m?.notInDictionary ?? 0}/${m?.pairs ?? 0}`, () => {
    expect(m.found / reachable).toBeGreaterThanOrEqual(MIN_RECALL_ANY);
    expect(m.foundHigh / reachable).toBeGreaterThanOrEqual(MIN_RECALL_HIGH);
  });

  it(`recall with library-derived avatars: any ${pct(library?.found ?? 0, (library?.pairs ?? 0) - (library?.notInDictionary ?? 0))}, not in dictionary ${library?.notInDictionary ?? 0}; high FP ${library?.highFalsePositives ?? 0}`, () => {
    const lib = library as Metrics;
    expect(lib.highFalsePositives).toBe(0);
    expect(lib.notInDictionary).toBeLessThanOrEqual(m.notInDictionary);
  });

  it(`kind accuracy ${pct(m?.kindCorrect ?? 0, m?.items ?? 0)}`, () => {
    expect(m.kindCorrect / m.items).toBeGreaterThanOrEqual(MIN_KIND_ACCURACY);
  });

  it(`quest_support accuracy ${pct(m?.questCorrect ?? 0, m?.items ?? 0)}`, () => {
    expect(m.questCorrect / m.items).toBeGreaterThanOrEqual(MIN_QUEST_ACCURACY);
  });

  it(`dependency sets exact ${pct(m?.depsCorrect ?? 0, m?.items ?? 0)}; not_supported exact ${pct(m?.notSupportedCorrect ?? 0, m?.items ?? 0)}`, () => {
    expect(m.depsCorrect / m.items).toBeGreaterThanOrEqual(MIN_DEPENDENCY_ACCURACY);
    expect(m.notSupportedCorrect).toBe(m.items);
  });

  it(`identifies avatar bodies as self_avatar ${pct(m?.bodiesCorrect ?? 0, m?.bodies ?? 0)}`, () => {
    expect(m.bodiesCorrect).toBe(m.bodies);
  });
});

