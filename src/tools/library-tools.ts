import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BoothService } from "../service.js";
import { MAX_SYNC_ITEMS } from "../services/sync.js";
import { VRCHAT_KINDS } from "../services/vrchat-info.js";
import { avatarSchema } from "./item-tools.js";
import { register, UNOFFICIAL_NOTE } from "./register.js";
import { registerUpdateTools } from "./update-tools.js";

const LOGIN_NOTE = "ログインが必要です（AUTH_REQUIRED のときは booth_login）。";
const FILTER_NOTE =
  "avatar / kind / dependency を指定すると商品データ（キャッシュ優先、1 回あたり最大 20 件取得）で絞り込み、自分が持っているアバター版（owned_versions）と根拠を付けます。" +
  "metadata_pending が 0 より大きいときは未判定の商品が残っています（booth_sync_library_metadata で取り込めます）。" +
  "対応判定は根拠付きヒューリスティックで、推測で「対応」と言わないでください。";

const libraryInput = {
  page: z.number().int().min(1).max(1_000).optional().describe("ページ番号（既定 1）。all=true のときは開始ページ"),
  all: z.boolean().optional().describe("最後のページまで読む（最大 20 ページ）"),
  query: z.string().max(100).optional().describe("商品名・ショップ名で絞り込み（大文字小文字を区別しない）"),
  avatar: avatarSchema.optional().describe("このアバターに対応する商品だけ（例: しなの）"),
  kind: z.enum(VRCHAT_KINDS).optional().describe("商品の種類で絞り込み"),
  dependency: z.string().min(1).max(50).optional().describe("依存ツールで絞り込み（例: liltoon, modular_avatar, vrcfury）"),
};

export function registerLibraryTools(server: McpServer, service: BoothService): void {
  register(
    server,
    "booth_list_library",
    `自分の BOOTH ライブラリ（購入した商品）を一覧します。商品 ID・名前・ショップ・ダウンロード可能なファイル名を返します。${FILTER_NOTE}${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    libraryInput,
    (input) => service.listLibrary(input),
  );
  register(
    server,
    "booth_list_gifts",
    `自分が受け取った BOOTH のギフトを一覧します。入力と出力は booth_list_library と同じです。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    libraryInput,
    (input) => service.listGifts(input),
  );
  register(
    server,
    "booth_list_free_downloads",
    `ライブラリの「無料ダウンロード」タブ（BOOTH で入手した無料配布の商品）を一覧します。入力と出力は booth_list_library と同じですが、このタブにはファイルの一覧が無いため downloadables は常に空です（ファイルは商品ページから入手します）。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    libraryInput,
    (input) => service.listFreeDownloads(input),
  );
  register(
    server,
    "booth_list_orders",
    `自分の BOOTH の注文履歴（注文 ID・日時・金額・状態・商品名）を 1 ページ分返します。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    { page: z.number().int().min(1).max(1_000).optional().describe("ページ番号（既定 1）") },
    ({ page }) => service.listOrders(page),
  );
  register(
    server,
    "booth_get_order",
    `注文の詳細（商品・価格・ダウンロード ID）を返します。氏名・住所・電話番号・メールアドレスは返しません。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    {
      order_id: z
        .union([z.string().regex(/^\s*\d{1,20}\s*$/u), z.number().int().positive()])
        .describe("注文 ID（数字）"),
    },
    ({ order_id }) => service.getOrder(String(order_id)),
  );
  register(
    server,
    "booth_list_my_avatars",
    `ライブラリ・ギフト・無料ダウンロードのうちアバター本体（3Dキャラクター）を一覧し、アバター辞書（avatars.json + 組み込み）に未登録の候補と辞書の内容も返します。商品データはキャッシュ優先で 1 回あたり最大 20 件取得します。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    {},
    () => service.listMyAvatars(),
  );
  register(
    server,
    "booth_sync_library_metadata",
    `ライブラリ・ギフト・無料ダウンロードの全商品の商品データ（items/{id}.json）をキャッシュに取り込みます（未取得分のみ、1 回あたり max_items 件まで）。remaining が 0 になるまで繰り返せます。大量の場合は CLI の \`booth-library-mcp sync\` を案内してください。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    {
      max_items: z
        .number()
        .int()
        .min(1)
        .max(MAX_SYNC_ITEMS)
        .optional()
        .describe(`今回取得する最大件数（既定 20、最大 ${MAX_SYNC_ITEMS}。1 件あたり約 1 秒）`),
    },
    ({ max_items }) => service.syncLibraryMetadata(max_items),
  );
  // Registered here (right after the library tools) so createServer() needs no change for Phase 5.
  registerUpdateTools(server, service);
}
