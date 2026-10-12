import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BoothService } from "../service.js";
import { MAX_WISHLIST_PAGE, MAX_WISHLIST_WALK_PAGES } from "../services/wishlist.js";
import { register, UNOFFICIAL_NOTE } from "./register.js";

const LOGIN_NOTE = "ログインが必要です（AUTH_REQUIRED のときは booth_login）。";

export function registerWishlistTools(server: McpServer, service: BoothService): void {
  register(
    server,
    "booth_list_wishlist",
    "自分の BOOTH のほしいものリスト（スキ！した商品）を一覧します。商品 ID・名前・URL・ショップ・価格（表示文字列）・カテゴリ・" +
      "成人向け / 売り切れ / 販売終了の別と、BOOTH 自身の VRChat フラグ（is_vrchat）を返します。" +
      "list で名前付きリスト（コードか名前。一覧は booth_list_wishlist_names）に絞り込めます。" +
      "include_vrchat=true で対応アバター・依存ツールの根拠付き判定（vrchat）を付けます（商品データはキャッシュ優先で 1 回あたり最大 20 件取得、" +
      `metadata_pending が 0 より大きければ同じ条件で再度呼ぶと続きを取得）。対応判定はヒューリスティックで、推測で「対応」と言わないでください。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    {
      page: z.number().int().min(1).max(MAX_WISHLIST_PAGE).optional().describe("ページ番号（既定 1、1 ページ 20 件）。all=true のときは開始ページ"),
      list: z.string().min(1).max(100).optional().describe("名前付きリストのコード（8 文字の英数字）か名前。省略時はすべてのスキ！した商品"),
      all: z.boolean().optional().describe(`最後のページまで読む（最大 ${MAX_WISHLIST_WALK_PAGES} ページ）`),
      include_vrchat: z.boolean().optional().describe("対応アバター・依存ツールの判定を付ける"),
    },
    ({ page, list, all, include_vrchat }) => service.listWishlist({ page, list, all, includeVrchat: include_vrchat }),
  );
  register(
    server,
    "booth_list_wishlist_names",
    `自分の BOOTH のほしいものリストの名前付きリスト（code と name）を返します。code / name は booth_list_wishlist の list に指定できます。${LOGIN_NOTE}${UNOFFICIAL_NOTE}`,
    {},
    () => service.listWishlistNames(),
  );
}
