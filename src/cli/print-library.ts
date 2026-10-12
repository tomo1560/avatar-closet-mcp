import type {
  AvatarInitResult,
  BoothResult,
  LibraryEntry,
  LibraryListing,
  LibrarySource,
  MetadataStatus,
  MyAvatarsResult,
  OrderResult,
  OrdersListing,
  SyncResult,
} from "../types.js";
import type { SyncProgress } from "../services/sync.js";
import { orDash, renderTable, yen } from "./format.js";

/** Human-readable output for the buyer commands (library, gifts, free, orders, avatars, sync). */

const SOURCE_LABELS: Readonly<Record<LibrarySource, string>> = { library: "ライブラリ", gifts: "ギフト", free_downloads: "無料ダウンロード" };

export function formatLibrary({ data }: BoothResult<LibraryListing>): string {
  const filtered = data.filters.avatar !== undefined || data.filters.kind !== undefined || data.filters.dependency !== undefined;
  const label = SOURCE_LABELS[data.source];
  const table =
    data.items.length === 0
      ? "該当する商品はありません。\n"
      : renderTable(
          [
            { header: "商品ID" },
            { header: "商品名", max: 44 },
            { header: "ショップ", max: 20 },
            ...(filtered ? [{ header: "種類" }, { header: "判定" }, { header: "所持版", max: 24 }] : []),
            { header: "ファイル", max: 40 },
          ],
          data.items.map((item) => libraryRow(item, filtered)),
        );
  const pages = `ページ ${data.first_page}${data.last_page_read !== data.first_page ? `〜${data.last_page_read}` : ""}`;
  const total = data.last_page === null ? "" : ` / 全 ${data.last_page} ページ`;
  const lines = [`${data.count} 件（${label}、${pages}${total}）`];
  if (data.has_next) lines.push(`続き: --page ${data.last_page_read + 1}${data.truncated ? " --all（ページ数の上限で打ち切りました）" : ""}`);
  return `${table}${[...lines, ...metadataLines(data)].join("\n")}\n`;
}

function libraryRow(item: LibraryEntry, filtered: boolean): string[] {
  const files = item.downloadables.map((file) => file.file_name ?? file.downloadable_id);
  const fileText = files.length === 0 ? "-" : files.length === 1 ? (files[0] ?? "-") : `${files[0] ?? ""} 他 ${files.length - 1} 件`;
  if (!filtered) return [item.item_id, item.name, orDash(item.shop_name), fileText];
  const compatibility = item.vrchat?.compatibility;
  const verdict = compatibility ? `${compatibility.result}${compatibility.confidence ? ` (${compatibility.confidence})` : ""}` : "-";
  const owned = (item.vrchat?.owned_versions ?? []).map((version) => version.avatar).join(", ");
  return [item.item_id, item.name, orDash(item.shop_name), item.vrchat?.kind ?? "-", verdict, orDash(owned), fileText];
}

export function metadataLines(status: Partial<MetadataStatus>): string[] {
  const lines: string[] = [];
  if ((status.metadata_pending ?? 0) > 0) {
    lines.push(`商品データ未取得: ${status.metadata_pending} 件（\`booth-library-mcp sync\` で事前に取り込めます）`);
  }
  if ((status.metadata_unavailable ?? 0) > 0) lines.push(`削除・非公開の商品: ${status.metadata_unavailable} 件`);
  const errors = status.metadata_errors ?? [];
  if (errors.length > 0) lines.push(`取得エラー: ${errors.map((error) => `${error.item_id} (${error.code})`).join(", ")}`);
  return lines;
}

export function formatOrders({ data }: BoothResult<OrdersListing>): string {
  if (data.orders.length === 0) return "注文はありません。\n";
  const table = renderTable(
    [{ header: "注文ID" }, { header: "注文日時" }, { header: "金額" }, { header: "状態", max: 16 }, { header: "商品", max: 50 }],
    data.orders.map((order) => [order.order_id, orDash(order.ordered_at), yen(order.total_price), orDash(order.status), order.item_names.join(" / ")]),
  );
  const next = data.has_next ? `続き: --page ${data.page + 1}\n` : "";
  return `${table}ページ ${data.page}${data.last_page === null ? "" : ` / 全 ${data.last_page} ページ`}\n${next}`;
}

export function formatOrder({ data, meta }: BoothResult<OrderResult>): string {
  const header = [
    `注文 ${data.order_id}`,
    `注文日時: ${orDash(data.ordered_at)}`,
    `状態: ${orDash(data.status)}`,
    `支払い方法: ${orDash(data.payment_method)}`,
    `合計: ${yen(data.total_price)}`,
  ].join("\n");
  const table = renderTable(
    [{ header: "商品ID" }, { header: "商品名", max: 44 }, { header: "バリエーション", max: 20 }, { header: "価格" }, { header: "ファイル", max: 40 }],
    data.items.map((item) => [
      item.item_id,
      item.name,
      orDash(item.variation_name),
      yen(item.price),
      item.downloadables.map((file) => file.file_name ?? file.downloadable_id).join(", ") || "-",
    ]),
  );
  const masked = meta.redactions.length > 0 ? `一部の情報を非表示にしました（${meta.redactions.join(", ")}）。\n` : "";
  return `${header}\n\n${table}${masked}`;
}

export function formatAvatars({ data }: BoothResult<MyAvatarsResult>): string {
  const owned =
    data.avatars.length === 0
      ? "所持しているアバター本体は見つかりませんでした。\n"
      : renderTable(
          [{ header: "商品ID" }, { header: "商品名", max: 44 }, { header: "ショップ", max: 20 }, { header: "辞書ID" }],
          data.avatars.map((avatar) => [avatar.item_id, avatar.name, avatar.shop_name, avatar.avatar_id ?? `(未登録: ${avatar.suggested_id ?? "-"})`]),
        );
  const lines = [`辞書: ${data.dictionary.length} 件（組み込み + avatars.json）`];
  if (data.suggestions.length > 0) {
    lines.push(`辞書に無いアバター: ${data.suggestions.map((suggestion) => suggestion.names.join("/")).join(", ")}（\`booth-library-mcp avatars init\` で追加）`);
  }
  return `${owned}${[...lines, ...metadataLines(data)].join("\n")}\n`;
}

export function formatAvatarInit({ data }: BoothResult<AvatarInitResult>, file: string): string {
  const lines =
    data.added.length === 0
      ? ["追加するアバターはありませんでした（既存の avatars.json は変更していません）。"]
      : [
          `${data.added.length} 件を avatars.json に追加しました: ${file}`,
          ...data.added.map((entry) => `  ${entry.id}: ${entry.names.join(", ")}（商品 ${entry.source_item_id}）`),
          "別名（ひらがな・英字など）は avatars.json を編集して追記してください。",
        ];
  if (data.metadata_pending > 0) lines.push(`商品データ未取得: ${data.metadata_pending} 件（先に \`booth-library-mcp sync\` を実行してください）`);
  return `${lines.join("\n")}\n`;
}

export function formatSyncProgress(progress: SyncProgress): string {
  return `取得済み ${progress.fetched} 件 / 残り ${progress.remaining} 件（全 ${progress.total_items} 件）\n`;
}

export function formatSync({ data }: BoothResult<SyncResult>): string {
  const lines = [
    `購入品 ${data.total_items} 件: キャッシュ済み ${data.cached} 件、今回取得 ${data.fetched} 件、残り ${data.remaining} 件`,
  ];
  if (data.unavailable > 0) lines.push(`削除・非公開の商品: ${data.unavailable} 件`);
  for (const error of data.errors) lines.push(`エラー: 商品 ${error.item_id} ${error.code} ${error.message}`);
  if (data.truncated) lines.push("注意: ライブラリのページ数の上限で打ち切りました。");
  if (data.remaining > 0) lines.push("残りがあります。時間をおいて再度 `booth-library-mcp sync` を実行してください。");
  return `${lines.join("\n")}\n`;
}
