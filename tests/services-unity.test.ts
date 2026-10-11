import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BoothService } from "../src/service.js";
import { maskPackageVersion } from "../src/services/unity-check.js";
import { libraryHtml, type FakeLibraryItem } from "./helpers/buyer-html.js";
import { RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";

const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const FIXTURE = fileURLToPath(new URL("./fixtures/unity-project", import.meta.url));
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

const OWNED: FakeLibraryItem[] = [
  { id: 1000001, name: "オリジナル3Dモデル Shinano", files: [{ id: 1, name: "Shinano_v1.0.2.unitypackage" }] },
  { id: 1000004, name: "【無料】lilToon", files: [{ id: 4, name: "lilToon_1.7.3.unitypackage" }] },
];
const GIFTED: FakeLibraryItem[] = [{ id: 1000002, name: "ExampleOutfit【Shinano対応】", files: [{ id: 2, name: "ExampleOutfit_Shinano_ver1.0.zip" }] }];

function routes(): Record<string, FakeRoute> {
  return {
    [LIBRARY]: { html: libraryHtml(OWNED, { page: 1, lastPage: 1 }) },
    [GIFTS]: { html: libraryHtml(GIFTED, { page: 1, lastPage: 1, path: "/library/gifts" }) },
  };
}

async function service(reader: RoutedFakeReader): Promise<BoothService> {
  return new BoothService(reader, { env: { BOOTH_MCP_HOME: await tempDir("booth-library-mcp-unity-home-") } });
}

describe("unityCheck (CLI unity-check)", () => {
  it("matches the owned library and gifts against the project", async () => {
    const reader = new RoutedFakeReader(routes());
    const { data, meta } = await (await service(reader)).unityCheck(FIXTURE);
    expect(data.matches.map((match) => [match.item_id, match.matched_by, match.confidence])).toEqual([
      ["1000001", "file_name", "high"],
      ["1000002", "file_name", "high"],
      ["1000004", "vpm_package", "high"],
    ]);
    expect(data.matches[0]?.evidence).toBe("Assets/Shinano ↔ Shinano_v1.0.2.unitypackage");
    expect(data.unmatched_asset_folders).toContain("MysteryFolder");
    expect(data).toMatchObject({ owned_items: 3, truncated: false });
    expect(data.vpm_packages).toContainEqual({ id: "jp.lilxyzw.liltoon", version: "1.7.3" });
    expect(meta.sourceUrl).toBe(LIBRARY);
    expect(reader.calls).toEqual([LIBRARY, GIFTS]);
  });

  it("masks local and git package locations in the result", async () => {
    const project = await tempDir("booth-library-mcp-unity-project-");
    await mkdir(join(project, "Assets", "Shinano"), { recursive: true });
    await mkdir(join(project, "Packages"), { recursive: true });
    const dependencies = {
      "com.unity.ugui": "1.0.0",
      "com.example.local": "file:C:/Users/someone/Packages/local",
      "com.example.git": "https://github.com/example/package.git#v1.2.0",
      "com.example.ssh": "git@github.com:example/package.git",
    };
    await writeFile(join(project, "Packages", "manifest.json"), JSON.stringify({ dependencies }));
    const { data } = await (await service(new RoutedFakeReader(routes()))).unityCheck(project);
    expect(data.upm_packages).toEqual([
      { id: "com.example.git", version: "git" },
      { id: "com.example.local", version: "local" },
      { id: "com.example.ssh", version: "git" },
      { id: "com.unity.ugui", version: "1.0.0" },
    ]);
    expect(JSON.stringify(data)).not.toContain("someone");
  });

  it("rejects a folder that is not a Unity project before reading the library", async () => {
    const reader = new RoutedFakeReader(routes());
    const notProject = await tempDir("booth-library-mcp-unity-empty-");
    await expect((await service(reader)).unityCheck(notProject)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reader.calls).toEqual([]);
  });
});

describe("maskPackageVersion", () => {
  it.each([
    ["1.0.0", "1.0.0"],
    ["2.0.0-preview.3", "2.0.0-preview.3"],
    ["file:../LocalPackages/foo", "local"],
    ["FILE:C:/x", "local"],
    ["C:\\Users\\someone\\pkg", "local"],
    ["../relative/pkg", "local"],
    ["https://github.com/example/pkg.git?path=/Packages/x#1.0", "git"],
    ["git+https://example.com/pkg", "git"],
    ["git@github.com:example/pkg.git", "git"],
    ["ssh://git@example.com/pkg.git", "git"],
    ["http://example.com/pkg", "git"],
  ])("%s → %s", (version, expected) => {
    expect(maskPackageVersion(version)).toBe(expected);
  });
});
