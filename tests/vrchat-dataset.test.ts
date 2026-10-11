/**
 * Evaluation of the VRChat extractors on real public BOOTH items (captured 2026-10-12)
 * against the hand labels in tests/fixtures/public/compat-labels.json (PLAN §3.5.2).
 * Metrics are computed once and surfaced in the test names.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractCompatibility } from "../src/vrchat/compatibility.js";
import { extractDependencies } from "../src/vrchat/dependencies.js";
import { classifyKind } from "../src/vrchat/kind.js";
import { resolveAvatarId } from "../src/vrchat/matcher.js";
import { SEED_AVATARS } from "../src/vrchat/seed-avatars.js";
import { normalizeCompact } from "../src/vrchat/text.js";
import type { AvatarDictionary, CompatibilityResult, DependencyResult, VrchatItemInput, VrchatKind } from "../src/vrchat/types.js";

interface Label {
  readonly kind: VrchatKind;
  readonly avatar_id?: string;
  readonly compatible: readonly string[];
  readonly not_supported: readonly string[];
  readonly dependencies: readonly string[];
  readonly quest_support: string;
  readonly must_not_match: readonly string[];
}

interface Case {
  readonly item: VrchatItemInput;
  readonly label: Label;
  readonly compat: CompatibilityResult;
  readonly deps: DependencyResult;
  readonly mustNotMatch: ReadonlySet<string>;
}

const FIXTURES = join(import.meta.dirname, "fixtures", "public");
const labels = JSON.parse(readFileSync(join(FIXTURES, "compat-labels.json"), "utf8")) as Record<string, Label>;
const items = readdirSync(join(FIXTURES, "items")).map(
  (file) => JSON.parse(readFileSync(join(FIXTURES, "items", file), "utf8")) as VrchatItemInput,
);

/**
 * must_not_match mixes dictionary ids (`maya`) and raw strings (`真冬`, `ルキフェル`). Unknown
 * strings are added to the evaluation dictionary so a false positive on them is observable.
 */
const extraEntries = Object.values(labels)
  .flatMap((label) => label.must_not_match)
  .filter((term) => resolveAvatarId(term, SEED_AVATARS) === null)
  .map((term) => ({ id: `mnm:${normalizeCompact(term)}`, names: [term] }));
const dictionary: AvatarDictionary = [...SEED_AVATARS, ...extraEntries];

function resolveTerm(term: string): string {
  return resolveAvatarId(term, dictionary) ?? `mnm:${normalizeCompact(term)}`;
}

const cases: Case[] = items.map((item) => {
  const label = labels[String(item.id)];
  if (!label) throw new Error(`No label for item ${item.id}`);
  return {
    item,
    label,
    compat: extractCompatibility(item, dictionary),
    deps: extractDependencies(item),
    mustNotMatch: new Set(label.must_not_match.map(resolveTerm)),
  };
});

function itemText(item: VrchatItemInput): string {
  return normalizeCompact(
    [item.name, item.description, ...item.tags.map((t) => t.name), ...item.variations.map((v) => v.name ?? "")].join("\n"),
  );
}

function isReachable(item: VrchatItemInput, avatar: string): boolean {
  const entry = SEED_AVATARS.find((e) => e.id === avatar);
  const text = itemText(item);
  return (entry?.names ?? []).some((name) => text.includes(normalizeCompact(name)));
}

const highFalsePositives = cases.flatMap((c) =>
  c.compat.compatible_avatars
    .filter((a) => a.confidence === "high" && (!c.label.compatible.includes(a.avatar) || c.mustNotMatch.has(a.avatar)))
    .map((a) => `${c.item.id}:${a.avatar}`),
);
const anyFalsePositives = cases.flatMap((c) =>
  c.compat.compatible_avatars.filter((a) => !c.label.compatible.includes(a.avatar)).map((a) => `${c.item.id}:${a.avatar}:${a.confidence}`),
);
const mustNotMatchHits = cases.flatMap((c) =>
  c.compat.compatible_avatars.filter((a) => c.mustNotMatch.has(a.avatar)).map((a) => `${c.item.id}:${a.avatar}`),
);
const labelled = cases.flatMap((c) => c.label.compatible.map((avatar) => ({ c, avatar })));
const found = labelled.filter(({ c, avatar }) => c.compat.compatible_avatars.some((a) => a.avatar === avatar));
const foundHigh = labelled.filter(({ c, avatar }) =>
  c.compat.compatible_avatars.some((a) => a.avatar === avatar && a.confidence === "high"),
);
const missed = labelled.filter((l) => !found.includes(l));
const unreachable = missed.filter(({ c, avatar }) => !isReachable(c.item, avatar));
const kindCorrect = cases.filter((c) => classifyKind(c.item) === c.label.kind);
const questCorrect = cases.filter((c) => c.deps.quest_support === c.label.quest_support);
const depsCorrect = cases.filter(
  (c) => [...c.deps.dependencies.map((d) => d.id)].sort().join() === [...c.label.dependencies].sort().join(),
);

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}% (${part}/${whole})`;
}

const missedHigh = labelled.filter((l) => !foundHigh.includes(l)).map(({ c, avatar }) => `${c.item.id}:${avatar}`);

describe(`VRChat dataset (${cases.length} real items, ${labelled.length} labelled avatar pairs)`, () => {
  it(`has zero high-confidence false positives (found ${highFalsePositives.length})`, () => {
    expect(highFalsePositives).toEqual([]);
  });

  it(`never reports a must_not_match term at any confidence (found ${mustNotMatchHits.length})`, () => {
    expect(mustNotMatchHits).toEqual([]);
  });

  it(`reports no false positives at any confidence (found ${anyFalsePositives.length})`, () => {
    expect(anyFalsePositives).toEqual([]);
  });

  it(`recall overall ${pct(found.length, labelled.length)}; missed ${missed.length} (unreachable from JSON ${unreachable.length})`, () => {
    expect(missed.map(({ c, avatar }) => `${c.item.id}:${avatar}`)).toEqual([]);
  });

  it(`recall high-only ${pct(foundHigh.length, labelled.length)} (not high: ${missedHigh.join(", ") || "none"})`, () => {
    // 8831909:plushead is claimed only by tags while the description has its own 対応アバター
    // list without it; the label notes call it "low confidence 相当", so it is reported as low.
    expect(missedHigh).toEqual(["8831909:plushead"]);
  });

  it(`kind accuracy ${pct(kindCorrect.length, cases.length)}`, () => {
    expect(cases.map((c) => [c.item.id, classifyKind(c.item)])).toEqual(cases.map((c) => [c.item.id, c.label.kind]));
  });

  it(`quest_support accuracy ${pct(questCorrect.length, cases.length)}`, () => {
    expect(cases.map((c) => [c.item.id, c.deps.quest_support])).toEqual(cases.map((c) => [c.item.id, c.label.quest_support]));
  });

  it(`dependency sets exact ${pct(depsCorrect.length, cases.length)}`, () => {
    const actual = cases.map((c) => [c.item.id, c.deps.dependencies.map((d) => d.id).sort()]);
    expect(actual).toEqual(cases.map((c) => [c.item.id, [...c.label.dependencies].sort()]));
  });

  it("matches labelled not_supported (none in this dataset — guards against false negations)", () => {
    expect(cases.map((c) => [c.item.id, c.compat.not_supported.map((n) => n.avatar)])).toEqual(
      cases.map((c) => [c.item.id, [...c.label.not_supported]]),
    );
  });

  it("identifies avatar bodies as self_avatar instead of compatible", () => {
    const bodies = cases.filter((c) => c.label.kind === "avatar");
    expect(bodies.map((c) => c.compat.self_avatar)).toEqual(bodies.map((c) => c.label.avatar_id));
  });

  it("keeps every evidence quote within 120 characters", () => {
    const evidence = cases.flatMap((c) => [
      ...c.compat.compatible_avatars.map((a) => a.evidence),
      ...c.deps.dependencies.map((d) => d.evidence),
    ]);
    expect(evidence.filter((e) => e.length > 120 || e.length === 0)).toEqual([]);
  });
});
