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
