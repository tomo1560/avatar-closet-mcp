/**
 * VPM package ids of VRChat tools that are also distributed as BOOTH items, mapped to the tool
 * entries of the dependency dictionary (whose aliases are reused for matching item names).
 */
import { DEPENDENCY_DICTIONARY } from "../vrchat/dependencies.js";
import { normalizeCompact } from "../vrchat/text.js";

export interface KnownTool {
  readonly name: string;
  /** Normalised (compact) aliases. Short acronyms such as `MA` / `AAO` are deliberately excluded. */
  readonly aliases: readonly string[];
}

const VPM_TOOL_IDS: Readonly<Record<string, string>> = {
  "nadena.dev.modular-avatar": "modular_avatar",
  "nadena.dev.ndmf": "ndmf",
  "jp.lilxyzw.liltoon": "liltoon",
  "jp.lilxyzw.lilycalinventory": "lilycal_inventory",
  "com.vrcfury.vrcfury": "vrcfury",
  "com.anatawa12.avatar-optimizer": "avatar_optimizer",
  "com.github.kurotu.vrc-quest-tools": "vrcquesttools",
  "jp.suzuryg.face-emo": "faceemo",
  "com.poiyomi.toon": "poiyomi",
};

const KNOWN_TOOLS: ReadonlyMap<string, KnownTool> = new Map(
  Object.entries(VPM_TOOL_IDS).flatMap(([packageId, dependencyId]): [string, KnownTool][] => {
    const definition = DEPENDENCY_DICTIONARY.find((entry) => entry.id === dependencyId);
    return definition ? [[packageId, { name: definition.name, aliases: definition.aliases.map(normalizeCompact) }]] : [];
  }),
);

/** The tool behind a VPM package id, or `undefined` for packages that are not known tools. */
export function knownToolForPackage(packageId: string): KnownTool | undefined {
  return KNOWN_TOOLS.get(packageId);
}
