/**
 * Name normalisation for matching Unity asset folders against BOOTH item / file names.
 */
import { normalizeCompact } from "../vrchat/text.js";

/** Shortest normalised name that takes part in matching (shorter names match far too much). */
export const MIN_MATCH_LENGTH = 4;

const ARCHIVE_EXTENSION = /\.(?:unitypackage|zip|7z|rar)$/i;
const BRACKETS = /[()[\]{}（）［］【】「」『』〈〉《》]/g;
/** Bracketed decorations in item titles: `【無料】`, `(v1.0)`, `［PC/Quest］` … */
const DECORATIONS = /【[^】]*】|\[[^\]]*\]|［[^］]*］|\([^)]*\)|（[^）]*）|「[^」]*」|『[^』]*』/g;

/**
 * Version suffixes. A plain trailing number survives (`Costume2`, `Rover_1`): it needs a `v` /
 * `ver` / `version` marker or a dotted number after a separator.
 */
const VERSION_SUFFIXES: readonly RegExp[] = [
  // `_v1.2.3`, ` ver.1.0`, `-Version 3`, `衣装v1.0`, or the whole name (`ver1.0`)
  /(?:^|[\s_\-.]+|(?<=\p{Lo}))v(?:er(?:sion)?)?\.?\s*\d+(?:[._-]\d+)*[a-z]?$/iu,
  // camelCase: `FictionalHairV2`, `OutfitVer1.0`
  /(?<=[\p{Ll}\d])V(?:er(?:sion)?)?\.?\d+(?:[._-]\d+)*[a-z]?$/u,
  // `_1.0.3`, `-2.1.0b`
  /[\s_-]+\d+(?:\.\d+)+[a-z]?$/i,
];
const MAX_STRIP_ROUNDS = 3;

/**
 * Unity / VRChat infrastructure folders and generic asset sub-folders. Never matched and never
 * reported as unmatched. `_PoiyomiShaders` is listed because Poiyomi is not sold on BOOTH; tool
 * folders that are BOOTH items (`lilToon`, …) stay matchable on purpose.
 */
const GENERIC_FOLDER_NAMES: readonly string[] = [
  "Editor", "Editor Default Resources", "Scripts", "Script", "Materials", "Material", "Textures", "Texture",
  "Prefabs", "Prefab", "Animations", "Animation", "Animator", "Animators", "Controllers", "Shaders", "Shader",
  "Plugins", "Scenes", "Scene", "Resources", "Gizmos", "StreamingAssets", "Standard Assets", "Samples", "Sample",
  "Models", "Model", "Meshes", "Mesh", "FBX", "Sounds", "Sound", "Audio", "Fonts", "Font", "Settings", "Documents",
  "Docs", "Readme", "Other", "Others", "Misc", "Data", "Images", "Icons", "Icon", "Thumbnails", "Expressions",
  "Menu", "Menus", "Parameters", "Avatar", "Avatars", "Temp", "Tmp", "Backup", "Test", "Tests", "Demo",
  "License", "Licenses", "VRCSDK", "VRChat", "VRChat Examples", "Udon", "UdonSharp", "SerializedUdonPrograms",
  "TextMesh Pro", "XR", "_PoiyomiShaders",
];
const GENERIC_NAMES: ReadonlySet<string> = new Set(GENERIC_FOLDER_NAMES.map((name) => normalizeAssetName(name)));

/**
 * NFKC, archive extension and version suffix removed, then the compact form shared with the
 * VRChat matcher (case-folded, katakana → hiragana, separators / punctuation removed).
 * `"ExampleOutfit_Shinano_ver1.0.zip"` → `"exampleoutfitshinano"`.
 */
export function normalizeAssetName(name: string): string {
  let current = name.normalize("NFKC").replace(BRACKETS, " ").trim();
  for (let round = 0; round < MAX_STRIP_ROUNDS; round += 1) {
    const stripped = stripOnce(current);
    if (stripped === current) break;
    current = stripped;
  }
  return normalizeCompact(current);
}

/** Item title without bracketed decorations (`【無料】lilToon` → `lilToon`), normalised. */
export function normalizeItemTitle(name: string): string {
  return normalizeAssetName(name.normalize("NFKC").replace(DECORATIONS, " "));
}

/** True for infrastructure / generic folder names such as `Editor`, `Materials` or `VRCSDK`. */
export function isGenericAssetFolder(name: string): boolean {
  return GENERIC_NAMES.has(normalizeAssetName(name));
}

/** A normalised name long and specific enough to take part in matching. */
export function isMatchable(normalized: string): boolean {
  return normalized.length >= MIN_MATCH_LENGTH && !/^\d+$/.test(normalized) && !GENERIC_NAMES.has(normalized);
}

function stripOnce(value: string): string {
  const withoutExtension = value.replace(ARCHIVE_EXTENSION, "");
  return VERSION_SUFFIXES.reduce((current, pattern) => current.replace(pattern, ""), withoutExtension).trim();
}
