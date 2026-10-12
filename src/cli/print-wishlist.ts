import type { BoothResult, WishlistEntry, WishlistListing, WishlistNamesResult } from "../types.js";
import { orDash, renderTable } from "./format.js";
import { metadataLines } from "./print-library.js";

/** Human-readable output for `wishlist` and `wishlist names`. */

export function formatWishlist({ data }: BoothResult<WishlistListing>): string {
  const withVrchat = data.note !== undefined;
  const table =
    data.items.length === 0
      ? "該当する商品はありません。\n"
      : renderTable(
          [
            { header: "商品ID" },
            { header: "商品名", max: 44 },
            { header: "ショップ", max: 20 },
            { header: "価格" },
            { header: "状態", max: 24 },
            ...(withVrchat ? [{ header: "種類" }, { header: "対応アバター", max: 32 }] : []),
          ],
          data.items.map((item) => wishlistRow(item, withVrchat)),
        );
  const scope = data.list === null ? "すべて" : `リスト「${data.list.name}」`;
  const pages = `ページ ${data.first_page}${data.last_page_read !== data.first_page ? `〜${data.last_page_read}` : ""}`;
  const lines = [`${data.count} 件（ほしいものリスト ${scope}、${pages} / 全 ${data.total_pages} ページ、全 ${data.total_count} 件）`];
  if (data.has_next) lines.push(`続き: --page ${data.last_page_read + 1}${data.truncated ? " --all（ページ数の上限で打ち切りました）" : ""}`);
  return `${table}${[...lines, ...wishlistMetadataLines(data)].join("\n")}\n`;
}

export function formatWishlistNames({ data }: BoothResult<WishlistNamesResult>): string {
  if (data.lists.length === 0) return "名前付きのほしいものリストはありません。\n";
  const table = renderTable(
    [{ header: "コード" }, { header: "名前", max: 40 }],
    data.lists.map((list) => [list.code, list.name]),
  );
  return `${table}${data.count} 件（\`wishlist --list <コード|名前>\` で絞り込めます）\n`;
}

function wishlistRow(item: WishlistEntry, withVrchat: boolean): string[] {
  const row = [item.item_id, item.name, orDash(item.shop_name), orDash(item.price), orDash(statusText(item))];
  if (!withVrchat) return row;
  const avatars = (item.vrchat?.compatible_avatars ?? []).map((avatar) => `${avatar.avatar}(${avatar.confidence})`).join(", ");
  return [...row, item.vrchat?.kind ?? "-", orDash(avatars)];
}

function statusText(item: WishlistEntry): string {
  const flags: Array<[boolean | undefined, string]> = [
    [item.is_sold_out, "売り切れ"],
    [item.is_end_of_sale, "販売終了"],
    [item.is_adult, "成人向け"],
    [item.is_vrchat, "VRChat"],
  ];
  return flags
    .filter(([flag]) => flag === true)
    .map(([, label]) => label)
    .join(" ");
}

/** Wished items are not covered by `sync`: a pending count means "run the same command again". */
function wishlistMetadataLines(data: WishlistListing): string[] {
  const pending = data.metadata_pending ?? 0;
  const head = pending > 0 ? [`商品データ未取得: ${pending} 件（同じコマンドをもう一度実行すると続きを取得します）`] : [];
  return [...head, ...metadataLines({ ...data, metadata_pending: 0 })];
}
