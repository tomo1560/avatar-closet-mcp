import type { BoothResult, CompatibilityReport, ItemDetail, SearchResult, TagSuggestions, VrchatInfo } from "../types.js";
import { orDash, renderTable, yen } from "./format.js";

/** Human-readable output for the public item commands (item, search, tags, compat). */

export function formatItem({ data }: BoothResult<ItemDetail>): string {
  const lines = [
    data.name,
    `URL: ${data.url}`,
    `ショップ: ${data.shop.name}（${data.shop.url}）`,
    `価格: ${data.price}`,
    `カテゴリ: ${data.category.parent_name ? `${data.category.parent_name} > ` : ""}${data.category.name}（${data.category.id}）`,
    `公開日: ${orDash(data.published_at)}`,
    `タグ: ${data.tags.length > 0 ? data.tags.join(", ") : "-"}`,
  ];
  const variations =
    data.variations.length <= 1
      ? ""
      : renderTable(
          [{ header: "バリエーション", max: 40 }, { header: "価格" }, { header: "状態" }],
          data.variations.map((variation) => [orDash(variation.name), yen(variation.price), variation.status]),
        );
  const vrchat = data.vrchat ? formatVrchat(data.vrchat) : "";
  return `${lines.join("\n")}\n${variations ? `\n${variations}` : ""}${vrchat}`;
}

function formatVrchat(info: VrchatInfo): string {
  const lines = [``, `VRChat 種類: ${info.kind}${info.self_avatar ? `（アバター本体: ${info.self_avatar}）` : ""}`];
  const compatible =
    info.compatible_avatars.length === 0
      ? "対応アバター: 根拠なし（unknown）\n"
      : renderTable(
          [{ header: "対応アバター" }, { header: "確度" }, { header: "根拠元" }, { header: "根拠", max: 60 }],
          info.compatible_avatars.map((avatar) => [avatar.avatar, avatar.confidence, avatar.source, avatar.evidence]),
        );
  if (info.not_supported.length > 0) {
    lines.push(`非対応: ${info.not_supported.map((entry) => `${entry.avatar}「${entry.evidence}」`).join(", ")}`);
  }
  lines.push(`依存ツール: ${info.dependencies.length > 0 ? info.dependencies.map((dependency) => dependency.name).join(", ") : "-"}`);
  lines.push(`Quest 対応: ${info.quest_support}${info.quest_evidence ? `「${info.quest_evidence}」` : ""}`);
  return `${lines.join("\n")}\n${compatible}`;
}

export function formatSearch({ data }: BoothResult<SearchResult>): string {
  if (data.items.length === 0) return "該当する商品はありません。\n";
  const table = renderTable(
    [{ header: "商品ID" }, { header: "商品名", max: 50 }, { header: "ショップ", max: 20 }, { header: "価格" }, { header: "カテゴリ" }],
    data.items.map((item) => [item.item_id, item.name, orDash(item.shop_name), yen(item.price), item.category_id === null ? "-" : String(item.category_id)]),
  );
  const total = data.total_count === null ? "" : `（全 ${data.total_count.toLocaleString("ja-JP")} 件）`;
  const next = data.has_next && data.page < 5 ? `続き: --page ${data.page + 1}\n` : "";
  return `${table}ページ ${data.page}${total}\n${next}`;
}

export function formatTags({ data }: BoothResult<TagSuggestions>): string {
  return data.tags.length === 0 ? "タグ候補はありません。\n" : `${data.tags.join("\n")}\n`;
}

export function formatCompat({ data }: BoothResult<CompatibilityReport>): string {
  const confidence = data.confidence ? `（確度 ${data.confidence}）` : "";
  const lines = [`${data.item_name}（${data.item_id}, ${data.kind}）`, `${data.avatar}: ${data.result}${confidence}`];
  if (data.reason) lines.push(`理由: ${data.reason}`);
  lines.push(...data.evidence.map((quote) => `  根拠: ${quote}`));
  lines.push(data.note);
  return `${lines.join("\n")}\n`;
}

