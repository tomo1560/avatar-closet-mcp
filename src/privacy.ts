export interface RedactionResult {
  text: string;
  redactions: string[];
}

const patterns: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: "[非表示: メールアドレス]",
  },
  {
    name: "phone",
    pattern: /(?<!\d)(?:\+?81[-\s]?)?(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?!\d)/gu,
    replacement: "[非表示: 電話番号]",
  },
  {
    name: "postal_code",
    pattern: /(?<!\d)〒?\s*\d{3}[-ー]\d{4}(?!\d)/gu,
    replacement: "[非表示: 郵便番号]",
  },
];

export function redactSensitiveText(value: string): RedactionResult {
  let text = value;
  const redactions = new Set<string>();

  for (const entry of patterns) {
    if (entry.pattern.test(text)) {
      redactions.add(entry.name);
      entry.pattern.lastIndex = 0;
      text = text.replace(entry.pattern, entry.replacement);
    }
    entry.pattern.lastIndex = 0;
  }

  return { text, redactions: [...redactions] };
}

/** Names of the redactions whose placeholder appears in already-masked texts (for `meta.redactions`). */
export function redactionsIn(texts: readonly (string | null | undefined)[]): string[] {
  return patterns
    .filter((entry) => texts.some((text) => text?.includes(entry.replacement) === true))
    .map((entry) => entry.name);
}

export function maskDirectIdentifier(value: string | undefined): string | undefined {
  return value?.trim() ? "[非表示]" : undefined;
}

/** Longer raw texts are rejected before normalizing them. */
const MAX_LABEL_INPUT_LENGTH = 1_000;

/**
 * Short page labels that may carry seller- or buyer-written text (order status, payment method) are
 * returned only when they are a known value: the normalized text (NFKC, whitespace collapsed, case-
 * insensitive) must equal a vocabulary entry and be at most `maxLength` characters. Anything else (free
 * text, contact details, injected instructions) becomes null. The vocabulary's own spelling is returned.
 */
export function restrictToVocabulary(value: string | null, vocabulary: readonly string[], maxLength: number): string | null {
  if (value === null || value.length > MAX_LABEL_INPUT_LENGTH) return null;
  const normalized = normalizeLabel(value);
  if (normalized === "" || normalized.length > maxLength) return null;
  return vocabulary.find((entry) => normalizeLabel(entry) === normalized) ?? null;
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}
