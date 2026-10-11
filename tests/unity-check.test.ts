import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LibraryItem } from "../src/parsers/library.js";
import {
  isGenericAssetFolder,
  matchLibraryToProject,
  normalizeAssetName,
  scanUnityProject,
  type UnityProjectScan,
} from "../src/unity/unity-check.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/unity-project", import.meta.url));

function item(id: string, name: string, files: readonly (string | null)[] = []): LibraryItem {
  return {
    item_id: id,
    name,
    item_url: `https://booth.pm/ja/items/${id}`,
    shop_name: "Fictional Shop",
    shop_url: "https://fictional-shop.booth.pm/",
    thumbnail_url: null,
    downloadables: files.map((file_name, index) => ({ downloadable_id: `${id}${index}`, file_name, variation_name: null })),
  };
}

function scan(asset_folders: readonly string[], vpm: Record<string, string> = {}): UnityProjectScan {
  return {
    asset_folders,
    vpm_packages: Object.entries(vpm).map(([id, version]) => ({ id, version })),
    upm_packages: [],
  };
}

/** Fictional library matching the fictional fixture project. */
const LIBRARY: readonly LibraryItem[] = [
  item("1000001", "オリジナル3Dモデル Shinano", ["Shinano_v1.0.2.unitypackage", "Shinano_Texture_PSD.zip"]),
  item("1000002", "ExampleOutfit【Shinano対応】", ["ExampleOutfit_Shinano_ver1.0.zip"]),
  item("1000003", "FictionalHair ふわふわヘア", [null]),
  item("1000004", "【無料】lilToon", ["lilToon_1.7.3.unitypackage"]),
  item("1000005", "Sample Dress（lilToon対応 / Modular Avatar対応）", ["SampleDress.zip"]),
  item("1000006", "Editor Extension Kit", ["Editor.unitypackage"]),
];

async function expectInvalidInput(promise: Promise<unknown>, path?: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ name: "BoothError", code: "INVALID_INPUT" });
  if (path) expect((error as Error).message).not.toContain(path);
}

describe("scanUnityProject", () => {
  it("reads two levels of Assets/ folder names and the package manifests of the fixture project", async () => {
    const result = await scanUnityProject(FIXTURE);

    expect(result).toEqual({
      asset_folders: [
        "Editor",
        "ExampleCreator",
        "ExampleCreator/FictionalHair_v1.2.3",
        "ExampleCreator/UnknownProp",
        "ExampleOutfit_Shinano",
        "MysteryFolder",
        "Shinano",
        "Shinano/Prefabs",
        "Shinano/Textures",
      ],
      vpm_packages: [
        { id: "com.vrchat.avatars", version: "3.7.0" },
        { id: "com.vrchat.base", version: "3.7.0" },
        { id: "jp.lilxyzw.liltoon", version: "1.7.3" },
        { id: "nadena.dev.modular-avatar", version: "1.10.2" },
        { id: "nadena.dev.ndmf", version: "1.5.0" },
      ],
      upm_packages: [
        { id: "com.unity.modules.animation", version: "1.0.0" },
        { id: "com.unity.ugui", version: "1.0.0" },
      ],
    });
  });

  it("never descends below the second level and ignores files, dot folders and ~ folders", async () => {
    const { asset_folders } = await scanUnityProject(FIXTURE);

    expect(asset_folders.some((folder) => folder.includes("Deep"))).toBe(false);
    expect(asset_folders.some((folder) => folder.includes("readme"))).toBe(false);
    expect(asset_folders.some((folder) => folder.includes(".hidden") || folder.includes("Samples~"))).toBe(false);
  });

  describe("with a temporary project", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "booth-unity-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    async function makeProject(dirs: readonly string[]): Promise<string> {
      const project = join(root, "Project");
      for (const dir of dirs) await mkdir(join(project, dir), { recursive: true });
      return project;
    }

    it("accepts Assets/ + Packages/ without ProjectSettings/ and without manifests", async () => {
      const project = await makeProject(["Assets/Only", "Packages"]);

      await expect(scanUnityProject(project)).resolves.toEqual({
        asset_folders: ["Only"],
        vpm_packages: [],
        upm_packages: [],
      });
    });

    it.each([
      ["a missing path", ["Assets"], "Missing"],
      ["a folder without Assets/", ["ProjectSettings"], "Project"],
      ["Assets/ without ProjectSettings/ or Packages/", ["Assets"], "Project"],
    ])("rejects %s with INVALID_INPUT without echoing the path", async (_label, dirs, target) => {
      await makeProject(dirs);
      const path = join(root, target);

      await expectInvalidInput(scanUnityProject(path), path);
    });

    it("rejects a file path and an empty path", async () => {
      const file = join(root, "file.txt");
      await writeFile(file, "fictional", "utf8");

      await expectInvalidInput(scanUnityProject(file), file);
      await expectInvalidInput(scanUnityProject("   "));
    });

    it.each([
      ["invalid JSON", "vpm-manifest.json", "{oops"],
      ["a non-string version", "vpm-manifest.json", JSON.stringify({ dependencies: { "jp.example.tool": { version: 1 } } })],
      ["a non-object manifest", "manifest.json", JSON.stringify(["com.unity.ugui"])],
    ])("rejects a manifest with %s", async (_label, name, content) => {
      const project = await makeProject(["Assets", "Packages"]);
      await writeFile(join(project, "Packages", name), content, "utf8");

      await expectInvalidInput(scanUnityProject(project), project);
    });

    it("skips symlinked folders at both levels", async (context) => {
      const project = await makeProject(["Assets/Real", "ProjectSettings"]);
      const outside = join(root, "Outside");
      await mkdir(join(outside, "Inner"), { recursive: true });
      // Junctions need no privilege on Windows and are reported as symlinks by readdir (like real symlinks).
      const type = process.platform === "win32" ? "junction" : "dir";
      try {
        await symlink(outside, join(project, "Assets", "Linked"), type);
        await symlink(outside, join(project, "Assets", "Real", "LinkedChild"), type);
      } catch (error) {
        if (process.platform === "win32") return context.skip();
        throw error;
      }

      const result = await scanUnityProject(project);

      expect(result.asset_folders).toEqual(["Real"]);
    });
  });
});

describe("normalizeAssetName", () => {
  it.each([
    ["Shinano", "shinano"],
    ["Shinano_v1.2.3", "shinano"],
    ["Shinano_v1.0.2.unitypackage", "shinano"],
    ["ExampleOutfit_ver1.0", "exampleoutfit"],
    ["ExampleOutfit ver.1.0.2", "exampleoutfit"],
    ["ExampleOutfit_Ver1.02.unitypackage", "exampleoutfit"],
    ["ExampleOutfit_Shinano_ver1.0.zip", "exampleoutfitshinano"],
    ["FictionalHairV2.zip", "fictionalhair"],
    ["FictionalHair Version 3", "fictionalhair"],
    ["Foo_1.03", "foo"],
    ["Item-2.1.0b", "item"],
    ["Item (v1.0.0)", "item"],
    ["Item.v1.rar", "item"],
    ["しなの衣装v1.0", "しなの衣装"],
    ["Costume2", "costume2"],
    ["Clover2", "clover2"],
    ["Rover_1", "rover1"],
    ["Ｅｘａｍｐｌｅ－Ｏｕｔｆｉｔ", "exampleoutfit"],
    ["Example - Outfit_Shinano", "exampleoutfitshinano"],
    ["シナノ", "しなの"],
    ["ver1.0", ""],
  ])("%s → %s", (input, expected) => {
    expect(normalizeAssetName(input)).toBe(expected);
  });
});

describe("isGenericAssetFolder", () => {
  it.each(["Editor", "Scripts", "Materials", "Textures", "Prefabs", "Animations", "Shaders", "Plugins", "VRCSDK", "_PoiyomiShaders", "TextMesh Pro"])(
    "treats %s as generic",
    (name) => {
      expect(isGenericAssetFolder(name)).toBe(true);
    },
  );

  it.each(["Shinano", "ExampleOutfit_Shinano", "lilToon", "MysteryFolder"])("does not treat %s as generic", (name) => {
    expect(isGenericAssetFolder(name)).toBe(false);
  });
});

describe("matchLibraryToProject", () => {
  it("matches the fixture project against the fictional library", async () => {
    const result = matchLibraryToProject(await scanUnityProject(FIXTURE), LIBRARY);

    expect(result).toEqual({
      matches: [
        {
          item_id: "1000001",
          name: "オリジナル3Dモデル Shinano",
          matched_by: "file_name",
          evidence: "Assets/Shinano ↔ Shinano_v1.0.2.unitypackage",
          confidence: "high",
        },
        {
          item_id: "1000002",
          name: "ExampleOutfit【Shinano対応】",
          matched_by: "file_name",
          evidence: "Assets/ExampleOutfit_Shinano ↔ ExampleOutfit_Shinano_ver1.0.zip",
          confidence: "high",
        },
        {
          item_id: "1000004",
          name: "【無料】lilToon",
          matched_by: "vpm_package",
          evidence: "Packages/vpm-manifest.json jp.lilxyzw.liltoon@1.7.3 ↔ lilToon_1.7.3.unitypackage",
          confidence: "high",
        },
        {
          item_id: "1000003",
          name: "FictionalHair ふわふわヘア",
          matched_by: "asset_folder",
          evidence: "Assets/ExampleCreator/FictionalHair_v1.2.3 ↔ FictionalHair ふわふわヘア",
          confidence: "medium",
        },
      ],
      unmatched_asset_folders: ["ExampleCreator/UnknownProp", "MysteryFolder"],
    });
  });

  it("keeps only the best match per folder, then the best match per item", () => {
    const library = [
      item("1", "Fictional Avatar", ["Shinano.zip"]),
      item("2", "Fictional Outfit", ["ExampleOutfit_Shinano.zip"]),
    ];

    const result = matchLibraryToProject(scan(["Shinano", "ExampleOutfit_Shinano"]), library);

    expect(result.matches.map((match) => [match.item_id, match.confidence, match.evidence])).toEqual([
      ["1", "high", "Assets/Shinano ↔ Shinano.zip"],
      ["2", "high", "Assets/ExampleOutfit_Shinano ↔ ExampleOutfit_Shinano.zip"],
    ]);
  });

  it("reports a partial file-name overlap as low confidence", () => {
    const result = matchLibraryToProject(scan(["Kemomimi"]), [item("7", "けもみみセット", ["Kemomimi_Set_PC_Quest.zip"])]);

    expect(result.matches).toEqual([
      { item_id: "7", name: "けもみみセット", matched_by: "file_name", evidence: "Assets/Kemomimi ↔ Kemomimi_Set_PC_Quest.zip", confidence: "low" },
    ]);
    expect(result.unmatched_asset_folders).toEqual([]);
  });

  it("matches a folder contained in the item name with medium confidence", () => {
    const result = matchLibraryToProject(scan(["Creator/AccessoryPack"]), [item("8", "Example Accessory Pack DX", [])]);

    expect(result.matches).toEqual([
      {
        item_id: "8",
        name: "Example Accessory Pack DX",
        matched_by: "asset_folder",
        evidence: "Assets/Creator/AccessoryPack ↔ Example Accessory Pack DX",
        confidence: "medium",
      },
    ]);
  });

  it("ignores generic folders, generic file names and names shorter than four characters", () => {
    const library = [
      item("10", "Materials", ["Materials.unitypackage"]),
      item("11", "Fox", ["Fox.zip"]),
      item("12", "2024 Pack", ["2024.zip"]),
    ];

    const result = matchLibraryToProject(scan(["Materials", "Fox", "2024", "Shinano/Prefabs"]), library);

    expect(result.matches).toEqual([]);
    expect(result.unmatched_asset_folders).toEqual(["2024", "Fox"]);
  });

  it("matches known VPM packages only against items that are the tool itself", () => {
    const library = [
      item("20", "Modular Avatar 導入ガイド", ["guide.pdf"]),
      item("21", "Fictional Dress（lilToon対応）", ["dress.zip"]),
      item("22", "Avatar Optimizer", []),
      item("23", "VRCFury Toggle Pack", []),
      item("24", "lilToon", []),
    ];
    const project = scan([], {
      "nadena.dev.modular-avatar": "1.10.2",
      "com.anatawa12.avatar-optimizer": "1.8.0",
      "com.vrcfury.vrcfury": "1.900.0",
      "com.example.unknown": "1.0.0",
    });

    const result = matchLibraryToProject(project, library);

    expect(result.matches.map((match) => [match.item_id, match.matched_by, match.confidence])).toEqual([
      ["22", "vpm_package", "high"],
      ["23", "vpm_package", "medium"],
    ]);
  });

  it("collapses duplicate library entries (library + gifts) into one match", () => {
    const library = [item("30", "Fictional Outfit", ["FictionalOutfit.zip"]), item("30", "Fictional Outfit", [])];

    const result = matchLibraryToProject(scan(["FictionalOutfit"]), library);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.confidence).toBe("high");
  });

  it("reports unmatched second-level folders only next to matched siblings", () => {
    const result = matchLibraryToProject(
      scan(["Creator", "Creator/FictionalHair", "Creator/MysteryProp", "Creator/Prefabs", "Lonely", "Lonely/Inner", "Avatars", "Avatars/Unknown"]),
      [item("40", "Fictional Hair", ["FictionalHair.zip"])],
    );

    expect(result.unmatched_asset_folders).toEqual(["Creator/MysteryProp", "Lonely"]);
  });
});
