import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { HELP_TEXT, parseCliArgs, runCli } from "../src/cli.js";
import { formatWishlist } from "../src/cli/print-wishlist.js";
import { BoothService } from "../src/service.js";
import { libraryHtml } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, publicItem, RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";
import { WISHLIST_NAMES, wishlistItemsJson, wishlistItemsUrl, wishlistNamesJson } from "./helpers/wishlist-json.js";

const FREE = "https://accounts.booth.pm/library/free_downloads";
const tempPaths: string[] = [];

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof BoothError) return error.code;
    throw error;
  }
  return undefined;
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function run(args: string[], routes: Record<string, FakeRoute>): Promise<{ code: number; stdout: string }> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-cli-wishlist-"));
  tempPaths.push(home);
  let stdout = "";
  const code = await runCli(parseCliArgs(args), {
    createService: () => new BoothService(new RoutedFakeReader(routes), { env: { BOOTH_MCP_HOME: home } }),
    serve: () => Promise.reject(new Error("serve must not run in tests")),
    io: { stdout: (text) => void (stdout += text), stderr: () => undefined },
  });
  return { code, stdout };
}

const WISHED: Record<string, FakeRoute> = {
  [wishlistItemsUrl(1)]: {
    json: wishlistItemsJson(
      [
        { id: 6289322, name: "【しなの対応】Vigilant Style", price: "¥ 2,500~", shop: "Demicrown" },
        { id: 1000203, name: "架空イラスト集", isVrchat: false, isSoldOut: true },
      ],
      { page: 1, totalPages: 2, totalCount: 21 },
    ),
  },
};

describe("CLI wishlist / free argument parsing", () => {
  it("parses wishlist options", () => {
    expect(parseCliArgs(["wishlist"])).toEqual({ kind: "wishlist", json: false, query: { page: undefined, list: undefined, all: false, includeVrchat: false } });
    expect(parseCliArgs(["wishlist", "--page", "2", "--list=衣装候補", "--all", "--vrchat", "--json"])).toEqual({
      kind: "wishlist",
      json: true,
      query: { page: 2, list: "衣装候補", all: true, includeVrchat: true },
    });
  });

  it("parses wishlist names and rejects other subcommands or flags there", () => {
    expect(parseCliArgs(["wishlist", "names", "--json"])).toEqual({ kind: "wishlist-names", json: true });
    expect(codeOf(() => parseCliArgs(["wishlist", "names", "--all"]))).toBe("INVALID_INPUT");
    expect(() => parseCliArgs(["wishlist", "lists"])).toThrow(/不明なサブコマンド/u);
    expect(codeOf(() => parseCliArgs(["wishlist", "--list", " "]))).toBe("INVALID_INPUT");
  });

  it("parses free with the library options", () => {
    expect(parseCliArgs(["free", "--all", "--query", "shader"])).toMatchObject({ kind: "free", json: false, query: { all: true, query: "shader" } });
    expect(() => parseCliArgs(["free", "--vrchat"])).toThrow(/不明なオプション/u);
  });

  it("lists the new commands in the help text", () => {
    expect(HELP_TEXT).toContain("booth-library-mcp free [--all]");
    expect(HELP_TEXT).toContain("booth-library-mcp wishlist [--page N]");
    expect(HELP_TEXT).toContain("wishlist names");
  });
});

describe("CLI wishlist / free output", () => {
  it("wishlist prints prices, flags and the paging hint", async () => {
    const { code, stdout } = await run(["wishlist"], WISHED);
    expect(code).toBe(0);
    expect(stdout.split("\n")[0]).toMatch(/^商品ID\s+商品名\s+ショップ\s+価格\s+状態$/u);
    expect(stdout).toMatch(/6289322\s+【しなの対応】Vigilant Style\s+Demicrown\s+¥ 2,500~\s+VRChat/u);
    expect(stdout).toMatch(/1000203\s+架空イラスト集\s+架空ショップ\s+¥ 1,000\s+売り切れ/u);
    expect(stdout).toContain("2 件（ほしいものリスト すべて、ページ 1 / 全 2 ページ、全 21 件）");
    expect(stdout).toContain("続き: --page 2");
  });

  it("wishlist --vrchat adds the kind and compatible avatars", async () => {
    const routes: Record<string, FakeRoute> = {
      ...WISHED,
      [itemJsonUrlOf(6289322)]: { json: publicItem(6289322) },
      [itemJsonUrlOf(1000203)]: { json: { ...(publicItem(6289322) as object), id: 1000203 } },
    };
    const { stdout } = await run(["wishlist", "--vrchat"], routes);
    expect(stdout.split("\n")[0]).toMatch(/種類\s+対応アバター$/u);
    expect(stdout).toMatch(/6289322.*costume\s+.*shinano\(high\)/u);
  });

  it("asks to run the same command again (not sync) while wished-item metadata is pending", () => {
    const text = formatWishlist({
      data: {
        ...{ list: null, items: [], count: 0, first_page: 1, last_page_read: 1, total_pages: 1, total_count: 0 },
        ...{ has_next: false, truncated: false, metadata_pending: 3, note: "n" },
      },
      meta: { fetchedAt: "", sourceUrl: wishlistItemsUrl(1), redactions: [] },
    });
    expect(text).toContain("商品データ未取得: 3 件（同じコマンドをもう一度実行すると続きを取得します）");
    expect(text).not.toContain("sync");
  });

  it("wishlist --list prints the list name and wishlist names prints the codes", async () => {
    const routes: Record<string, FakeRoute> = {
      [WISHLIST_NAMES]: { json: wishlistNamesJson([{ code: "K0FAKE01", name: "衣装候補" }]) },
      [wishlistItemsUrl(1, "K0FAKE01")]: { json: wishlistItemsJson([], { page: 1, totalPages: 0 }) },
    };
    const listed = await run(["wishlist", "--list", "衣装候補"], routes);
    expect(listed.stdout).toContain("該当する商品はありません。");
    expect(listed.stdout).toContain("ほしいものリスト リスト「衣装候補」");
    const names = await run(["wishlist", "names"], routes);
    expect(names.stdout).toMatch(/K0FAKE01\s+衣装候補/u);
    expect(names.stdout).toContain("1 件");
  });

  it("wishlist --json prints the tool envelope", async () => {
    const { stdout } = await run(["wishlist", "--json"], WISHED);
    expect(JSON.parse(stdout)).toMatchObject({ data: { count: 2, total_count: 21 }, meta: { sourceUrl: wishlistItemsUrl(1) } });
  });

  it("free prints the free-downloads tab", async () => {
    const html = libraryHtml([{ id: 1000101, name: "架空フリー素材", shop: "架空フリー工房" }], { page: 1, lastPage: 1, path: "/library/free_downloads" });
    const { stdout } = await run(["free"], { [FREE]: { html } });
    expect(stdout).toMatch(/1000101\s+架空フリー素材\s+架空フリー工房\s+-/u);
    expect(stdout).toContain("1 件（無料ダウンロード、ページ 1 / 全 1 ページ）");
  });
});
