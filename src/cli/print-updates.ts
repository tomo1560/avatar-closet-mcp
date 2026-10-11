import type { SnapshotFile } from "../library/update-snapshot.js";
import type { UpdateCheckResult } from "../service.js";
import type { BoothResult } from "../types.js";
import type { CompatibilityCheck } from "../vrchat/types.js";
import { orDash, renderTable } from "./format.js";
import { metadataLines } from "./print-library.js";

/** Human-readable output for `updates` (booth_check_updates). */
export function formatUpdates({ data }: BoothResult<UpdateCheckResult>): string {
  if (!data.complete) return `${data.warnings.map((warning) => `注意: ${warning}`).join("\n")}\n`;
  const sections = data.first_run ? [`${data.note}\n`] : comparisonSections(data);
  const footer = [
    ...(data.unknown_item_ids && data.unknown_item_ids.length > 0 ? [`ライブラリに無い商品 ID: ${data.unknown_item_ids.join(", ")}`] : []),
    ...metadataLines(data),
    ...data.warnings.map((warning) => `注意: ${warning}`),
  ];
  return `${sections.join("\n")}${footer.length > 0 ? `${footer.join("\n")}\n` : ""}`;
}

function comparisonSections(data: UpdateCheckResult): string[] {
  const withVerdict = data.filters.avatar !== undefined;
  const sections: string[] = [];
  if (data.changed.length > 0) {
    sections.push(
      `更新された商品: ${data.changed.length} 件\n` +
        renderTable(
          [
            { header: "商品ID" },
            { header: "商品名", max: 40 },
            ...(withVerdict ? [{ header: "判定" }] : []),
            { header: "追加", max: 40 },
            { header: "削除", max: 30 },
            { header: "改名", max: 30 },
          ],
          data.changed.map((entry) => [
            entry.item_id,
            entry.name,
            ...(withVerdict ? [verdict(entry.compatibility)] : []),
            fileList(entry.added_files),
            fileList(entry.removed_files),
            entry.renamed_files.map((file) => `${orDash(file.from)} → ${orDash(file.to)}`).join(", ") || "-",
          ]),
        ),
    );
  }
  if (data.new_items.length > 0) sections.push(`新しい購入品: ${data.new_items.length} 件\n${itemTable(data.new_items, withVerdict)}`);
  if (data.removed_items.length > 0) sections.push(`一覧から消えた商品: ${data.removed_items.length} 件\n${itemTable(data.removed_items, false)}`);
  const since = `前回の確認: ${orDash(data.previous_snapshot_taken_at)}`;
  const summary =
    sections.length === 0
      ? `前回の確認から変更はありません（${since}、変更なし ${data.unchanged_count} 件）。`
      : `更新 ${data.changed.length} 件 / 新規 ${data.new_items.length} 件 / 消えた ${data.removed_items.length} 件 / 変更なし ${data.unchanged_count} 件（${since}）`;
  return [...sections, `${summary}\n`];
}

function itemTable(items: ReadonlyArray<{ item_id: string; name: string; compatibility?: CompatibilityCheck }>, withVerdict: boolean): string {
  return renderTable(
    [{ header: "商品ID" }, { header: "商品名", max: 50 }, ...(withVerdict ? [{ header: "判定" }] : [])],
    items.map((item) => [item.item_id, item.name, ...(withVerdict ? [verdict(item.compatibility)] : [])]),
  );
}

function fileList(files: readonly SnapshotFile[]): string {
  return files.map((file) => file.file_name ?? file.downloadable_id).join(", ") || "-";
}

function verdict(check: CompatibilityCheck | undefined): string {
  if (!check) return "-";
  return `${check.result}${check.confidence ? ` (${check.confidence})` : ""}`;
}
