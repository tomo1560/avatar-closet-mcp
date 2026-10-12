import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeCliError, parseCliArgs, runCli } from "../src/cli.js";
import { displayWidth, renderTable, stripControl, truncate } from "../src/cli/format.js";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";
import { libraryHtml } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, itemRoutes, publicItem, RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";

const tempPaths: string[] = [];
const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const FREE = "https://accounts.booth.pm/library/free_downloads";

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function run(args: string[], routes: Record<string, FakeRoute>): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-cli-run-"));
  tempPaths.push(home);
  const out = { stdout: "", stderr: "" };
  const code = await runCli(parseCliArgs(args), {
    createService: () => new BoothService(new RoutedFakeReader(routes), { env: { BOOTH_MCP_HOME: home } }),
    serve: () => Promise.reject(new Error("serve must not run in tests")),
    io: { stdout: (text) => void (out.stdout += text), stderr: (text) => void (out.stderr += text) },
  });
  return { code, home, ...out };
}

const library: Record<string, FakeRoute> = {
  [LIBRARY]: {
    html: libraryHtml(
      [
        { id: 4866933, name: "流行りのビキニ", shop: "いな屋さん", files: [{ id: 1, name: "Bikini_Shinano.zip" }] },
        { id: 6106863, name: "オリジナル3Dモデル「しなの」", shop: "ポンデロニウム研究所" },
      ],
      { page: 1, lastPage: 2 },
    ),
  },
  [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) },
  [FREE]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/free_downloads" }) },
};

describe("CLI data commands", () => {
  it("library prints an aligned table and the paging hint", async () => {
    const { code, stdout } = await run(["library"], library);
    expect(code).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toMatch(/^商品ID\s+商品名\s+ショップ\s+ファイル$/u);
    const shopColumn = (line: string, shop: string): number => displayWidth(line.slice(0, line.indexOf(shop)));
    const bikini = lines.find((line) => line.includes("いな屋さん")) ?? "";
    const avatar = lines.find((line) => line.includes("ポンデロニウム研究所")) ?? "";
    expect(shopColumn(bikini, "いな屋さん")).toBe(shopColumn(avatar, "ポンデロニウム研究所"));
    expect(stdout).toContain("2 件（ライブラリ、ページ 1 / 全 2 ページ）");
    expect(stdout).toContain("続き: --page 2");
  });

  it("library --json prints the tool envelope", async () => {
    const { stdout } = await run(["library", "--json"], library);
    expect(JSON.parse(stdout)).toMatchObject({ data: { source: "library", count: 2 }, meta: { sourceUrl: LIBRARY } });
  });

  it("library --avatar shows the verdict and owned versions", async () => {
    const { stdout } = await run(["library", "--avatar", "しなの"], { ...library, ...itemRoutes([4866933, 6106863]) });
    expect(stdout).toMatch(/4866933\s+流行りのビキニ\s+いな屋さん\s+costume\s+supported \(high\)\s+shinano/u);
    expect(stdout).not.toContain("6106863");
  });

  it("item --vrchat prints compatible avatars with evidence", async () => {
    const { stdout } = await run(["item", "4866933", "--vrchat"], itemRoutes([4866933]));
    expect(stdout).toContain("VRChat 種類: costume");
    expect(stdout).toMatch(/shinano\s+high/u);
    expect(stdout).toContain("依存ツール: lilToon");
  });

  it("compat prints the verdict, the evidence and the heuristic note", async () => {
    const { stdout } = await run(["compat", "4866933", "しなの"], itemRoutes([4866933]));
    expect(stdout).toContain("shinano: supported");
    expect(stdout).toContain("根拠:");
    expect(stdout).toContain("推測");
  });

  it("order hides shipping and contact data", async () => {
    const html = readFileSync(new URL("./fixtures/buyer/order-detail.html", import.meta.url), "utf8");
    const { stdout } = await run(["order", "30000001"], { "https://accounts.booth.pm/orders/30000001": { html } });
    expect(stdout).toContain("注文 30000001");
    for (const secret of ["架空 太郎", "架空区", "kakuu.taro@example.com"]) expect(stdout).not.toContain(secret);
  });

  it("sync reports progress on stderr and a summary on stdout", async () => {
    const source = publicItem(6289322) as Record<string, unknown>;
    const items = [8100, 8101, 8102].map((id) => ({ id, name: `架空 ${id}` }));
    const routes: Record<string, FakeRoute> = {
      [LIBRARY]: { html: libraryHtml(items, { page: 1, lastPage: 1 }) },
      [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) },
      [FREE]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/free_downloads" }) },
      ...Object.fromEntries(items.map((item) => [itemJsonUrlOf(item.id), { json: { ...source, id: item.id } }])),
    };
    const { stdout, stderr } = await run(["sync"], routes);
    expect(stderr).toContain("取得済み 3 件 / 残り 0 件（全 3 件）");
    expect(stdout).toContain("購入品 3 件: キャッシュ済み 0 件、今回取得 3 件、残り 0 件");
  });

  it("avatars init writes new avatars and prints the file", async () => {
    const routes: Record<string, FakeRoute> = {
      [LIBRARY]: { html: libraryHtml([{ id: 777, name: "カクウ" }], { page: 1, lastPage: 1 }) },
      [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) },
      [FREE]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/free_downloads" }) },
      [itemJsonUrlOf(777)]: { json: { ...(publicItem(6106863) as Record<string, unknown>), id: 777, name: "オリジナル3Dモデル「カクウ」" } },
    };
    const { stdout, home } = await run(["avatars", "init"], routes);
    expect(stdout).toContain("1 件を avatars.json に追加しました");
    expect(stdout).toContain("avatar_777: カクウ");
    expect(await readFile(join(home, "avatars.json"), "utf8")).toContain("avatar_777");
  });

  it("propagates service errors (e.g. AUTH_REQUIRED) to the caller", async () => {
    await expect(run(["orders"], { "https://accounts.booth.pm/orders": new BoothError("AUTH_REQUIRED", "x") })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });
});

describe("CLI formatting helpers", () => {
  it("counts East Asian wide characters as two columns", () => {
    expect(displayWidth("しなの")).toBe(6);
    expect(displayWidth("ABC")).toBe(3);
    expect(displayWidth("ＡＢ")).toBe(4);
  });

  it("truncates by display width with an ellipsis", () => {
    expect(truncate("しなの対応ドレス", 9)).toBe("しなの対…");
    expect(truncate("short", 9)).toBe("short");
  });

  it("strips terminal control characters from seller-controlled text", () => {
    const esc = String.fromCharCode(0x1b);
    const csi = String.fromCharCode(0x9b);
    expect(stripControl(`a${esc}[2Jb${csi}c\r\td\n`)).toBe("a[2Jbc\td\n");
    expect(renderTable([{ header: "名前" }], [[`x${esc}]0;title${String.fromCharCode(7)}y`]])).toBe("名前\n----------\nx]0;titley\n");
  });

  it("renders a header, a separator and aligned rows", () => {
    expect(renderTable([{ header: "ID" }, { header: "名前" }], [["1", "しなの"], ["22", "x"]])).toBe(
      "ID  名前\n--  ------\n1   しなの\n22  x\n",
    );
  });

  it("prints our own error messages in full but never the text of foreign errors", () => {
    expect(describeCliError(new BoothError("INVALID_INPUT", "bad\n使い方: x"))).toBe("bad\n使い方: x [INVALID_INPUT]");
    expect(describeCliError(new Error("boom\nCall log: cookie=secret"))).not.toContain("secret");
  });
});
