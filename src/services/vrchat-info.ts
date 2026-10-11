import { invalidInput } from "./result.js";
import type { LibraryVrchatInfo, VrchatInfo } from "../types.js";
import { checkCompatibility, extractCompatibility } from "../vrchat/compatibility.js";
import { DEPENDENCY_DICTIONARY, extractDependencies } from "../vrchat/dependencies.js";
import { classifyKind } from "../vrchat/kind.js";
import { normalizeCompact } from "../vrchat/text.js";
import type { AvatarDictionary, OwnershipContext, VrchatItemInput, VrchatKind } from "../vrchat/types.js";

/** Values accepted for the `kind` filters (normalised VRChat kinds, see vrchat/kind.ts). */
export const VRCHAT_KINDS = ["avatar", "costume", "accessory", "tool", "motion", "other"] as const satisfies readonly VrchatKind[];

/** Shared reminder for every VRChat answer (PLAN §3.5.1: never claim support without evidence). */
export const HEURISTIC_NOTE =
  "対応判定は商品データ（バリエーション名・タグ・説明文・ファイル名）からの根拠付きヒューリスティックです。" +
  "根拠が無いものは unknown です。推測で「対応」と言わず、evidence を示してください。";

/** Names of downloaded files, used as purchase context (`Outfit_Shinano_v1.2.zip`). */
export function ownedFileNames(downloadables: readonly { file_name: string | null }[]): string[] {
  return downloadables.map((file) => file.file_name).filter((name): name is string => name !== null);
}

/** Full VRChat view for `booth_get_item`. `owned_versions` only when purchase context is given. */
export function buildVrchatInfo(item: VrchatItemInput, dictionary: AvatarDictionary, ownership?: OwnershipContext): VrchatInfo {
  const compatibility = extractCompatibility(item, dictionary, ownership);
  const dependencies = extractDependencies(item);
  return {
    kind: classifyKind(item),
    compatible_avatars: compatibility.compatible_avatars,
    not_supported: compatibility.not_supported,
    ...(ownership ? { owned_versions: compatibility.owned_versions } : {}),
    self_avatar: compatibility.self_avatar,
    dependencies: dependencies.dependencies,
    quest_support: dependencies.quest_support,
    quest_evidence: dependencies.quest_evidence,
  };
}

/** Compact VRChat view for library rows. `avatar` adds a full compatibility check for that avatar. */
export function buildLibraryVrchatInfo(
  item: VrchatItemInput,
  dictionary: AvatarDictionary,
  fileNames: readonly string[],
  avatar?: string,
): LibraryVrchatInfo {
  const ownership: OwnershipContext = { ownedFileNames: fileNames };
  const compatibility = extractCompatibility(item, dictionary, ownership);
  return {
    kind: classifyKind(item),
    owned_versions: compatibility.owned_versions,
    dependencies: extractDependencies(item).dependencies.map((dependency) => dependency.id),
    ...(avatar !== undefined ? { compatibility: checkCompatibility(item, avatar, dictionary, ownership) } : {}),
  };
}

/** Resolves `lilToon`, `liltoon`, `MA`, `Modular Avatar`, `modular_avatar` … to a dependency id. */
export function resolveDependencyId(query: string): string {
  const wanted = normalizeCompact(query.replace(/[_-]/gu, " "));
  if (wanted === "") throw invalidInput("dependency を指定してください（例: liltoon, modular_avatar）。");
  const match = DEPENDENCY_DICTIONARY.find((definition) =>
    [definition.id.replace(/_/gu, " "), definition.name, ...definition.aliases, ...(definition.tagAliases ?? [])].some(
      (name) => normalizeCompact(name) === wanted,
    ),
  );
  if (match) return match.id;
  const known = DEPENDENCY_DICTIONARY.map((definition) => definition.id).join(", ");
  throw invalidInput(`未知の dependency です: ${query.trim().slice(0, 50)}（指定できる値: ${known}）。`);
}
