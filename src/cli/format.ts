/** Terminal formatting helpers: CJK-aware column widths and aligned tables. */

const WIDE = new RegExp(
  "[\\u1100-\\u115F\\u2E80-\\u303E\\u3041-\\u33FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA000-\\uA4CF\\uAC00-\\uD7A3" +
    "\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFF60\\uFFE0-\\uFFE6]|[\\u{20000}-\\u{3FFFD}]",
  "u",
);
/** C0 / C1 control characters except tab and newline: seller-controlled names must not drive the terminal. */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this pattern
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "gu");
const ELLIPSIS = "…";
const COLUMN_GAP = "  ";

/** Removes terminal control characters (ESC, CR, CSI …) from text printed to the terminal. */
export function stripControl(text: string): string {
  return text.replace(CONTROL, "");
}

/** Display width in terminal columns (East Asian wide / full-width characters count as 2). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? 2 : 1;
  return width;
}

/** Cuts `text` to at most `maxWidth` columns, ending with `…` when shortened. */
export function truncate(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let result = "";
  let width = 0;
  for (const char of text) {
    const charWidth = WIDE.test(char) ? 2 : 1;
    if (width + charWidth > maxWidth - 1) break;
    result += char;
    width += charWidth;
  }
  return `${result}${ELLIPSIS}`;
}

export function padEnd(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

export interface Column {
  readonly header: string;
  /** Maximum display width; longer cells are truncated. */
  readonly max?: number;
}

/** Aligned plain-text table with a header row and a separator line. */
export function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const cells = rows.map((row) => columns.map((column, index) => clean(row[index] ?? "", column.max)));
  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column.header), ...cells.map((row) => displayWidth(row[index] ?? ""))),
  );
  const line = (row: readonly string[]): string =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : padEnd(cell, widths[index] ?? 0)))
      .join(COLUMN_GAP)
      .trimEnd();
  const header = line(columns.map((column) => column.header));
  const separator = widths.map((width) => "-".repeat(width)).join(COLUMN_GAP);
  return [header, separator, ...cells.map(line)].join("\n") + "\n";
}

/** `¥ 1,500`, or `-` when unknown. */
export function yen(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `¥ ${value.toLocaleString("ja-JP")}`;
}

export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "-" : value;
}

function clean(text: string, max: number | undefined): string {
  const singleLine = stripControl(text.replace(/\s+/gu, " ")).trim();
  return max === undefined ? singleLine : truncate(singleLine, max);
}
