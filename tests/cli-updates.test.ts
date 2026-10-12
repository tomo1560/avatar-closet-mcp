import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HELP_TEXT, parseCliArgs, runCli } from "../src/cli.js";
import { formatUnityCheck } from "../src/cli/print-unity.js";
import { formatUpdates } from "../src/cli/print-updates.js";
import { BoothService } from "../src/service.js";
import { libraryHtml, type FakeLibraryItem } from "./helpers/buyer-html.js";
import { RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";

const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const FREE = "https://accounts.booth.pm/library/free_downloads";
const FIXTURE = fileURLToPath(new URL("./fixtures/unity-project", import.meta.url));
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-cli-updates-"));
  tempPaths.push(home);
  return home;
}

function routes(library: readonly FakeLibraryItem[]): Record<string, FakeRoute> {
  return {
    [LIBRARY]: { html: libraryHtml(library, { page: 1, lastPage: 1 }) },
    [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) },
    [FREE]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/free_downloads" }) },
  };
}

const BEFORE: FakeLibraryItem[] = [
  { id: 7001, name: "架空衣装", files: [{ id: 11, name: "Outfit_v1.zip" }] },
  { id: 7002, name: "架空小物", files: [{ id: 21, name: "Prop_v1.zip" }] },
];
const AFTER: FakeLibraryItem[] = [
  { id: 7001, name: "架空衣装", files: [{ id: 11, name: "Outfit_v1.zip" }, { id: 12, name: "Outfit_v2.zip" }] },
  { id: 7003, name: "架空ヘア", files: [{ id: 31, name: "Hair.zip" }] },
];

describe("CLI updates / unity-check parsing", () => {
  it("parses updates with repeatable --item and --avatar", () => {
    expect(parseCliArgs(["updates"])).toEqual({ kind: "updates", json: false });
    expect(parseCliArgs(["updates", "--item", "1", "--item=2", "--avatar", "しなの", "--json"])).toEqual({
      kind: "updates",
      json: true,
      itemIds: ["1", "2"],
      avatar: "しなの",
    });
  });

  it("rejects a non-numeric --item with the usage line", () => {
    expect(() => parseCliArgs(["updates", "--item", "abc"])).toThrow(/--item.*\n使い方: avatar-closet-mcp updates/su);
  });

  it("parses unity-check with exactly one project path", () => {
    expect(parseCliArgs(["unity-check", "C:/Unity/MyAvatar", "--json"])).toEqual({ kind: "unity-check", json: true, projectPath: "C:/Unity/MyAvatar" });
    expect(() => parseCliArgs(["unity-check"])).toThrow(/引数が足りません/u);
  });

  it("documents both commands in the help", () => {
    expect(HELP_TEXT).toContain("updates [--item <商品ID>]... [--avatar A] [--json]");
    expect(HELP_TEXT).toContain("unity-check <Unityプロジェクトのフォルダ> [--json]");
  });
});

describe("formatUpdates", () => {
  it("explains the first run, then lists changed, new and removed items", async () => {
    const home = await tempHome();
    const first = await new BoothService(new RoutedFakeReader(routes(BEFORE)), { env: { BOOTH_MCP_HOME: home } }).checkUpdates();
    expect(formatUpdates(first)).toContain("基準として記録しました");

    const second = await new BoothService(new RoutedFakeReader(routes(AFTER)), { env: { BOOTH_MCP_HOME: home } }).checkUpdates();
    const text = formatUpdates(second);
    expect(text).toContain("更新された商品: 1 件");
    expect(text).toMatch(/7001\s+架空衣装\s+Outfit_v2\.zip/u);
    expect(text).toContain("新しい購入品: 1 件");
    expect(text).toContain("一覧から消えた商品: 1 件");
    expect(text).toContain("更新 1 件 / 新規 1 件 / 消えた 1 件 / 変更なし 0 件");

    const third = await new BoothService(new RoutedFakeReader(routes(AFTER)), { env: { BOOTH_MCP_HOME: home } }).checkUpdates();
    expect(formatUpdates(third)).toContain("前回の確認から変更はありません");
  });
});

describe("formatUnityCheck", () => {
  it("prints matched purchases with evidence and the unmatched folders", async () => {
    const owned: FakeLibraryItem[] = [{ id: 1000001, name: "オリジナル3Dモデル Shinano", files: [{ id: 1, name: "Shinano_v1.0.2.unitypackage" }] }];
    const service = new BoothService(new RoutedFakeReader(routes(owned)), { env: { BOOTH_MCP_HOME: await tempHome() } });
    const text = formatUnityCheck(await service.unityCheck(FIXTURE));
    expect(text.split("\n")[0]).toMatch(/^商品ID\s+商品名\s+一致\s+確度\s+根拠$/u);
    expect(text).toContain("Assets/Shinano ↔ Shinano_v1.0.2.unitypackage");
    expect(text).toContain("一致した購入品: 1 件");
    expect(text).toContain("Assets/MysteryFolder");
    expect(text).toContain("jp.lilxyzw.liltoon@1.7.3");
  });
});

describe("CLI updates / unity-check commands", () => {
  async function run(args: string[], library: readonly FakeLibraryItem[], home: string): Promise<{ code: number; stdout: string }> {
    let stdout = "";
    const code = await runCli(parseCliArgs(args), {
      createService: () => new BoothService(new RoutedFakeReader(routes(library)), { env: { BOOTH_MCP_HOME: home } }),
      serve: () => Promise.reject(new Error("serve must not run in tests")),
      io: { stdout: (text) => void (stdout += text), stderr: () => undefined },
    });
    return { code, stdout };
  }

  it("updates prints a table, and --json the tool envelope", async () => {
    const home = await tempHome();
    expect((await run(["updates"], BEFORE, home)).stdout).toContain("基準として記録しました");
    const { code, stdout } = await run(["updates", "--json"], AFTER, home);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ data: { first_run: false, changed: [{ item_id: "7001" }] }, meta: { sourceUrl: LIBRARY } });
  });

  it("unity-check prints the matches for a project", async () => {
    const owned: FakeLibraryItem[] = [{ id: 1000001, name: "オリジナル3Dモデル Shinano", files: [{ id: 1, name: "Shinano_v1.0.2.unitypackage" }] }];
    const { code, stdout } = await run(["unity-check", FIXTURE], owned, await tempHome());
    expect(code).toBe(0);
    expect(stdout).toContain("一致した購入品: 1 件");
  });
});
