import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BoothService } from "../service.js";
import { MAX_UPDATE_ITEM_IDS } from "../services/updates.js";
import { avatarSchema } from "./item-tools.js";
import { register, UNOFFICIAL_NOTE } from "./register.js";

/**
 * BOOTH is only read (GET), but the local baseline moves with every call, so a repeated call reports
 * nothing new: not read-only and not idempotent from the client's point of view.
 */
export const UPDATE_CHECK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const DESCRIPTION =
  "購入品（ライブラリとギフト）のダウンロードファイル構成を前回の確認（前回 booth_check_updates を呼んだとき）と比べ、" +
  "ファイルが追加・削除・改名された商品（changed）、新しい購入品（new_items）、一覧から消えた商品（removed_items）を返します。" +
  "added_files は商品の更新を示すことが多いです。初回は比較対象が無いので基準を記録するだけです（first_run）。" +
  "今回の一覧が次回の基準になります（BOOTH のデータは変更せず、ローカルのスナップショットだけを書き込みます）。" +
  "item_ids で対象の商品を絞れます（対象外の変更は次回も報告されます）。" +
  "avatar を指定すると、そのアバター対応（根拠付きヒューリスティックで supported）の商品だけを返します。商品データはキャッシュ優先で 1 回あたり最大 20 件取得し、未取得は metadata_pending です。" +
  "ライブラリかギフトが 20 ページを超えて全件を読めないときは complete=false で、比較も記録もしません。" +
  "ログインが必要です（AUTH_REQUIRED のときは booth_login）。";

export function registerUpdateTools(server: McpServer, service: BoothService): void {
  register(
    server,
    "booth_check_updates",
    `${DESCRIPTION}${UNOFFICIAL_NOTE}`,
    {
      item_ids: z
        .array(z.string().regex(/^\s*[1-9]\d{0,11}\s*$/u))
        .min(1)
        .max(MAX_UPDATE_ITEM_IDS)
        .optional()
        .describe(`確認する商品 ID（最大 ${MAX_UPDATE_ITEM_IDS} 件。省略時は全件）`),
      avatar: avatarSchema.optional().describe("このアバターに対応する商品の更新だけを返す（例: しなの）"),
    },
    ({ item_ids, avatar }) => service.checkUpdates({ itemIds: item_ids, avatar }),
    UPDATE_CHECK_ANNOTATIONS,
  );
}
