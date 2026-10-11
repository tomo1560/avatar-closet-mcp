import type { UnityCheckResult } from "../service.js";
import type { BoothResult } from "../types.js";
import type { UnityPackageRef } from "../unity/unity-check.js";
import { renderTable } from "./format.js";

const MATCHED_BY_LABEL: Readonly<Record<UnityCheckResult["matches"][number]["matched_by"], string>> = {
  file_name: "ファイル名",
  asset_folder: "フォルダ名",
  vpm_package: "VPM",
};

/** Human-readable output for `unity-check` (PLAN §3.5.8). */
export function formatUnityCheck({ data }: BoothResult<UnityCheckResult>): string {
  const table =
    data.matches.length === 0
      ? "プロジェクト内に購入品は見つかりませんでした。\n"
      : renderTable(
          [{ header: "商品ID" }, { header: "商品名", max: 40 }, { header: "一致" }, { header: "確度" }, { header: "根拠", max: 70 }],
          data.matches.map((match) => [match.item_id, match.name, MATCHED_BY_LABEL[match.matched_by], match.confidence, match.evidence]),
        );
  const lines = [
    `一致した購入品: ${data.matches.length} 件（ライブラリ + ギフト ${data.owned_items} 件、Assets/ のフォルダ ${data.asset_folder_count} 件と比較）`,
    `購入品と一致しないフォルダ: ${data.unmatched_asset_folders.length > 0 ? data.unmatched_asset_folders.map((folder) => `Assets/${folder}`).join(", ") : "なし"}`,
    `VPM パッケージ: ${packageList(data.vpm_packages)}`,
    `UPM パッケージ: ${packageList(data.upm_packages)}`,
    ...(data.truncated ? ["注意: ライブラリのページ数の上限で打ち切ったため、一部の購入品とは比較していません。"] : []),
    data.note,
  ];
  return `${table}${lines.join("\n")}\n`;
}

function packageList(packages: readonly UnityPackageRef[]): string {
  return packages.length > 0 ? packages.map((entry) => `${entry.id}@${entry.version}`).join(", ") : "なし";
}
