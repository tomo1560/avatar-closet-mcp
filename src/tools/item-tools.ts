import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BoothService } from "../service.js";
import { VRCHAT_KINDS } from "../services/vrchat-info.js";
import { register, UNOFFICIAL_NOTE } from "./register.js";

const HEURISTIC =
  "対応判定は商品データ（バリエーション名・タグ・説明文）からの根拠付きヒューリスティックで、evidence に引用を返します。" +
  "根拠が無ければ unknown です。推測で「対応」と言わないでください。";

export const itemSchema = z
  .union([z.string().min(1).max(2_048), z.number().int().positive()])
  .describe("商品 ID または BOOTH の商品 URL（例: 123456, https://booth.pm/ja/items/123456）");

export const avatarSchema = z.string().min(1).max(100).describe("アバター名または辞書 ID（例: しなの, Shinano, shinano）");

export function registerItemTools(server: McpServer, service: BoothService): void {
  register(
    server,
    "booth_get_item",
    `BOOTH の商品詳細（公開 JSON を整形したもの: 名前・ショップ・価格・カテゴリ・タグ・バリエーション・説明文）を取得します。ログイン不要。include_vrchat=true で VRChat 情報（種類・対応アバター・非対応・依存ツール・Quest 対応）を根拠付きで追加します。${HEURISTIC}${UNOFFICIAL_NOTE}`,
    {
      item: itemSchema,
      include_vrchat: z.boolean().optional().describe("VRChat 向けの対応アバター・依存ツール情報を含める"),
    },
    ({ item, include_vrchat }) => service.getItem({ item, includeVrchat: include_vrchat }),
  );
  register(
    server,
    "booth_search_items",
    `BOOTH の商品を検索します（ユーザーが明示した検索のみ。1 回 1 ページ、最大 5 ページ目まで）。結果は商品 ID・名前・ショップ・価格・カテゴリ ID の一覧で、meta.nextPage があれば次のページがあります。${UNOFFICIAL_NOTE}`,
    {
      query: z.string().min(1).max(200).describe("検索語"),
      category: z
        .union([z.string().min(1).max(50), z.number().int().positive()])
        .optional()
        .describe("カテゴリ名（例: 3D衣装）または確認済みカテゴリ ID（208, 209, 210, 214, 215, 216, 217, 230）"),
      tags: z.array(z.string().min(1).max(100)).max(10).optional().describe("タグで絞り込み（最大 10 個）"),
      sort: z.string().regex(/^[a-z_]{1,32}$/u).optional().describe("並び順（BOOTH の sort パラメータ。例: new）"),
      page: z.number().int().min(1).max(5).optional().describe("ページ番号（1〜5）"),
      only_free: z.boolean().optional().describe("無料の商品のみ"),
      adult: z.boolean().optional().describe("成人向け商品も含める"),
    },
    (input) => service.searchItems(input),
  );
  register(
    server,
    "booth_suggest_tags",
    `BOOTH のタグ候補（オートコンプリート）を取得します。検索用のタグ名を確かめるときに使います。${UNOFFICIAL_NOTE}`,
    { term: z.string().min(1).max(100).describe("タグの入力途中の文字列") },
    ({ term }) => service.suggestTags(term),
  );
  register(
    server,
    "booth_check_compatibility",
    `商品が指定アバターに対応しているかを supported / not_supported / unknown で返し、根拠となる引用（evidence）を付けます。商品データはキャッシュ優先で取得します。${HEURISTIC}${UNOFFICIAL_NOTE}`,
    { item: itemSchema, avatar: avatarSchema },
    ({ item, avatar }) => service.checkCompatibility({ item, avatar }),
  );
  register(
    server,
    "booth_search_for_avatar",
    `指定アバター向けの商品を BOOTH で検索し（アバター名 + query、kind に対応するカテゴリ）、先頭 10 件だけ対応度を判定します（results）。残りは unscored です。${HEURISTIC}${UNOFFICIAL_NOTE}`,
    {
      avatar: avatarSchema,
      kind: z.enum(VRCHAT_KINDS).optional().describe("探す商品の種類（既定 costume）"),
      query: z.string().max(100).optional().describe("追加の検索語（例: 水着）"),
      page: z.number().int().min(1).max(3).optional().describe("ページ番号（1〜3）"),
    },
    (input) => service.searchForAvatar(input),
  );
}
