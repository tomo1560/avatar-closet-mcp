import type { SearchUrlParams } from "../booth/public.js";
import { BoothError } from "../errors.js";
import type { LibraryQuery } from "../services/library.js";
import type { WishlistQuery } from "../services/wishlist.js";
import { VRCHAT_KINDS } from "../services/vrchat-info.js";
import type { VrchatKind } from "../vrchat/types.js";
import { booleanFlag, integerFlag, listFlag, parseArgs, stringFlag, usageError, type ArgSpec, type ParsedArgs } from "./args.js";

export type CliCommand =
  | { kind: "serve" }
  | { kind: "login"; timeoutSec?: number }
  | { kind: "status"; json: boolean }
  | { kind: "logout" }
  | { kind: "help" }
  | { kind: "library" | "gifts" | "free"; json: boolean; query: LibraryQuery }
  | { kind: "wishlist"; json: boolean; query: WishlistQuery }
  | { kind: "wishlist-names"; json: boolean }
  | { kind: "orders"; json: boolean; page?: number }
  | { kind: "order"; json: boolean; orderId: string }
  | { kind: "item"; json: boolean; item: string; vrchat: boolean }
  | { kind: "search"; json: boolean; params: SearchUrlParams }
  | { kind: "tags"; json: boolean; term: string }
  | { kind: "compat"; json: boolean; item: string; avatar: string }
  | { kind: "avatars" | "avatars-init"; json: boolean }
  | { kind: "sync"; json: boolean; max?: number }
  | { kind: "download"; json: boolean; downloadableId: string; variationId?: string; out?: string }
  | { kind: "updates"; json: boolean; itemIds?: string[]; avatar?: string }
  | { kind: "unity-check"; json: boolean; projectPath: string };

const LIBRARY_FLAGS = { all: "boolean", page: "integer", query: "string", avatar: "string", kind: "string", dependency: "string", json: "boolean" } as const;

const SPECS = {
  serve: { flags: {}, minPositionals: 0, maxPositionals: 0, usage: "serve" },
  login: { flags: { timeout: "integer" }, minPositionals: 0, maxPositionals: 0, usage: "login [--timeout <秒>]" },
  status: { flags: { json: "boolean" }, minPositionals: 0, maxPositionals: 0, usage: "status [--json]" },
  logout: { flags: {}, minPositionals: 0, maxPositionals: 0, usage: "logout" },
  library: { flags: LIBRARY_FLAGS, minPositionals: 0, maxPositionals: 0, usage: "library [--all] [--page N] [--query Q] [--avatar A] [--kind K] [--dependency D] [--json]" },
  gifts: { flags: LIBRARY_FLAGS, minPositionals: 0, maxPositionals: 0, usage: "gifts [--all] [--page N] [--query Q] [--avatar A] [--kind K] [--dependency D] [--json]" },
  free: { flags: LIBRARY_FLAGS, minPositionals: 0, maxPositionals: 0, usage: "free [--all] [--page N] [--query Q] [--avatar A] [--kind K] [--dependency D] [--json]" },
  wishlist: {
    flags: { page: "integer", list: "string", all: "boolean", vrchat: "boolean", json: "boolean" },
    minPositionals: 0,
    maxPositionals: 1,
    usage: "wishlist [--page N] [--list <コード|名前>] [--all] [--vrchat] [--json] | wishlist names [--json]",
  },
  orders: { flags: { page: "integer", json: "boolean" }, minPositionals: 0, maxPositionals: 0, usage: "orders [--page N] [--json]" },
  order: { flags: { json: "boolean" }, minPositionals: 1, maxPositionals: 1, usage: "order <注文ID> [--json]" },
  item: { flags: { vrchat: "boolean", json: "boolean" }, minPositionals: 1, maxPositionals: 1, usage: "item <商品ID|URL> [--vrchat] [--json]" },
  search: {
    flags: { category: "string", tag: "list", sort: "string", page: "integer", free: "boolean", adult: "boolean", json: "boolean" },
    minPositionals: 1,
    maxPositionals: 20,
    usage: "search <検索語> [--category C] [--tag T]... [--sort S] [--page N] [--free] [--adult] [--json]",
  },
  tags: { flags: { json: "boolean" }, minPositionals: 1, maxPositionals: 1, usage: "tags <語> [--json]" },
  compat: { flags: { json: "boolean" }, minPositionals: 2, maxPositionals: 2, usage: "compat <商品ID|URL> <アバター> [--json]" },
  avatars: { flags: { json: "boolean" }, minPositionals: 0, maxPositionals: 1, usage: "avatars [init] [--json]" },
  sync: { flags: { max: "integer", json: "boolean" }, minPositionals: 0, maxPositionals: 0, usage: "sync [--max N] [--json]" },
  download: {
    flags: { variation: "string", out: "string", json: "boolean" },
    minPositionals: 1,
    maxPositionals: 1,
    usage: "download <ダウンロードID> [--variation N] [--out <dir>] [--json]",
  },
  updates: { flags: { item: "list", avatar: "string", json: "boolean" }, minPositionals: 0, maxPositionals: 0, usage: "updates [--item <商品ID>]... [--avatar A] [--json]" },
  "unity-check": { flags: { json: "boolean" }, minPositionals: 1, maxPositionals: 1, usage: "unity-check <Unityプロジェクトのフォルダ> [--json]" },
} as const satisfies Record<string, ArgSpec>;

const NUMERIC_ID = /^\d{1,20}$/u;

type SpecName = keyof typeof SPECS;

export const HELP_TEXT = `avatar-closet-mcp - BOOTH 購入者向けの非公式・読み取り専用 MCP サーバー / CLI（pixiv・BOOTH とは無関係です）

使い方:
  avatar-closet-mcp                          stdio MCP サーバーを起動（serve と同じ）
  avatar-closet-mcp login [--timeout <秒>]   専用ブラウザで BOOTH にログイン（30〜1800 秒、既定 600）
  avatar-closet-mcp status [--json]          ログイン状態を表示（未ログイン時は終了コード 1）
  avatar-closet-mcp logout                   保存したセッションとログイン用ブラウザプロファイルを削除
  avatar-closet-mcp ${SPECS.library.usage}
                                             ライブラリ（購入した商品）。--all で全ページ（最大 20 ページ）
  avatar-closet-mcp ${SPECS.gifts.usage}
                                             受け取ったギフト
  avatar-closet-mcp ${SPECS.free.usage}
                                             ライブラリの「無料ダウンロード」タブ（このタブにはファイルの一覧がありません）
  avatar-closet-mcp ${SPECS.wishlist.usage}
                                             ほしいものリスト（スキ！した商品、1 ページ 20 件、--all で最大 20 ページ）。
                                             --list で名前付きリストに絞り込み、--vrchat で対応アバター・依存ツールの判定。
                                             wishlist names は名前付きリストの一覧
  avatar-closet-mcp ${SPECS.orders.usage}            注文履歴
  avatar-closet-mcp ${SPECS.order.usage}            注文詳細（氏名・住所・連絡先は表示しません）
  avatar-closet-mcp ${SPECS.item.usage} 商品詳細（--vrchat で対応アバター・依存ツール）
  avatar-closet-mcp ${SPECS.search.usage}
                                             BOOTH を検索（1〜5 ページ目）
  avatar-closet-mcp ${SPECS.tags.usage}                 タグ候補
  avatar-closet-mcp ${SPECS.compat.usage} アバター対応の判定（根拠付き）
  avatar-closet-mcp avatars [--json]         所持アバターとアバター辞書
  avatar-closet-mcp avatars init             所持アバターのうち辞書に無いものを avatars.json に追加
  avatar-closet-mcp ${SPECS.sync.usage}         購入品の商品データをキャッシュに取り込む（1 件あたり約 1 秒）
  avatar-closet-mcp ${SPECS.download.usage}
                                             購入したファイルを保存（オプトイン: BOOTH_MCP_ENABLE_DOWNLOAD=1 が必要。
                                             保存先は --out か BOOTH_MCP_DOWNLOAD_DIR。既存ファイルは上書きしません）
  avatar-closet-mcp ${SPECS.updates.usage}
                                             前回の確認から更新された購入品（ダウンロードファイルの追加・削除・改名）。
                                             初回は基準を記録するだけです。--avatar で対応アバターの商品に絞り込み
  avatar-closet-mcp ${SPECS["unity-check"].usage}
                                             Unity プロジェクトに入っている購入品を推定（Assets/ のフォルダ名と
                                             Packages/*.json だけを読みます）
  avatar-closet-mcp help                     このヘルプを表示

--kind: ${VRCHAT_KINDS.join(" / ")}
対応判定は商品データからの根拠付きヒューリスティックです。根拠が無いものは unknown と表示します。
`;

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [command, ...rest] = args;
  if (command === undefined) return { kind: "serve" };
  if (command === "help" || command === "--help" || command === "-h") return { kind: "help" };
  if (!(command in SPECS)) {
    throw new BoothError("INVALID_INPUT", `不明なコマンドです: ${command}（\`avatar-closet-mcp help\` を参照）`);
  }
  const name = command as SpecName;
  return toCommand(name, parseArgs(rest, SPECS[name]));
}

function toCommand(name: SpecName, parsed: ParsedArgs): CliCommand {
  const json = booleanFlag(parsed, "json");
  const [first = "", second = ""] = parsed.positionals;
  switch (name) {
    case "serve":
    case "logout":
      return { kind: name };
    case "login":
      return withOptional({ kind: "login" }, "timeoutSec", integerFlag(parsed, "timeout"));
    case "status":
      return { kind: "status", json };
    case "library":
    case "gifts":
    case "free":
      return { kind: name, json, query: libraryQuery(parsed, SPECS[name]) };
    case "wishlist":
      return wishlistCommand(parsed, json);
    case "orders":
      return withOptional({ kind: "orders", json }, "page", integerFlag(parsed, "page"));
    case "order":
      return { kind: "order", json, orderId: first };
    case "item":
      return { kind: "item", json, item: first, vrchat: booleanFlag(parsed, "vrchat") };
    case "search":
      return { kind: "search", json, params: searchParams(parsed) };
    case "tags":
      return { kind: "tags", json, term: first };
    case "compat":
      return { kind: "compat", json, item: first, avatar: second };
    case "avatars":
      return avatarsCommand(parsed, json);
    case "sync":
      return withOptional({ kind: "sync", json }, "max", integerFlag(parsed, "max"));
    case "download":
      return downloadCommand(parsed, json);
    case "updates":
      return updatesCommand(parsed, json);
    case "unity-check":
      return { kind: "unity-check", json, projectPath: first };
  }
}

function wishlistCommand(parsed: ParsedArgs, json: boolean): CliCommand {
  const [sub] = parsed.positionals;
  if (sub === "names") {
    if (Object.keys(parsed.flags).some((flag) => flag !== "json")) {
      throw usageError("wishlist names に指定できるのは --json だけです。", SPECS.wishlist);
    }
    return { kind: "wishlist-names", json };
  }
  if (sub !== undefined) throw usageError(`不明なサブコマンドです: ${sub}`, SPECS.wishlist);
  const list = stringFlag(parsed, "list");
  if (list !== undefined && list.trim() === "") throw usageError("--list にはリストのコードか名前を指定してください。", SPECS.wishlist);
  const query: WishlistQuery = {
    page: integerFlag(parsed, "page"),
    list,
    all: booleanFlag(parsed, "all"),
    includeVrchat: booleanFlag(parsed, "vrchat"),
  };
  return { kind: "wishlist", json, query };
}

function updatesCommand(parsed: ParsedArgs, json: boolean): CliCommand {
  const itemIds = listFlag(parsed, "item");
  if (itemIds.some((id) => !NUMERIC_ID.test(id.trim()))) throw usageError("--item には商品 ID（数字）を指定してください。", SPECS.updates);
  const ids = itemIds.length > 0 ? itemIds.map((id) => id.trim()) : undefined;
  return withOptional(withOptional({ kind: "updates", json }, "avatar", stringFlag(parsed, "avatar")), "itemIds", ids);
}

function downloadCommand(parsed: ParsedArgs, json: boolean): CliCommand {
  const [downloadableId = ""] = parsed.positionals;
  const variationId = stringFlag(parsed, "variation");
  const out = stringFlag(parsed, "out");
  if (!NUMERIC_ID.test(downloadableId)) throw usageError("ダウンロード ID は数字で指定してください。", SPECS.download);
  if (variationId !== undefined && !NUMERIC_ID.test(variationId)) {
    throw usageError("--variation は数字で指定してください。", SPECS.download);
  }
  if (out !== undefined && out.trim() === "") throw usageError("--out には保存先ディレクトリを指定してください。", SPECS.download);
  return withOptional(withOptional({ kind: "download", json, downloadableId }, "variationId", variationId), "out", out);
}

function libraryQuery(parsed: ParsedArgs, spec: ArgSpec): LibraryQuery {
  const kind = stringFlag(parsed, "kind");
  if (kind !== undefined && !isVrchatKind(kind)) throw usageError(`--kind は ${VRCHAT_KINDS.join(" / ")} のいずれかです。`, spec);
  return {
    all: booleanFlag(parsed, "all"),
    page: integerFlag(parsed, "page"),
    query: stringFlag(parsed, "query"),
    avatar: stringFlag(parsed, "avatar"),
    kind,
    dependency: stringFlag(parsed, "dependency"),
  };
}

function searchParams(parsed: ParsedArgs): SearchUrlParams {
  const category = stringFlag(parsed, "category");
  return {
    query: parsed.positionals.join(" "),
    category: category !== undefined && /^\d+$/u.test(category) ? Number(category) : category,
    tags: listFlag(parsed, "tag"),
    sort: stringFlag(parsed, "sort"),
    page: integerFlag(parsed, "page"),
    only_free: booleanFlag(parsed, "free"),
    adult: booleanFlag(parsed, "adult"),
  };
}

function avatarsCommand(parsed: ParsedArgs, json: boolean): CliCommand {
  const [sub] = parsed.positionals;
  if (sub === undefined) return { kind: "avatars", json };
  if (sub === "init") return { kind: "avatars-init", json };
  throw usageError(`不明なサブコマンドです: ${sub}`, SPECS.avatars);
}

function isVrchatKind(value: string): value is VrchatKind {
  return (VRCHAT_KINDS as readonly string[]).includes(value);
}

function withOptional<T extends object, K extends string, V>(base: T, key: K, value: V | undefined): T & { [P in K]?: V } {
  return value === undefined ? base : { ...base, [key]: value };
}
