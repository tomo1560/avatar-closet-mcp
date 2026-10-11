/**
 * Minimal structural input for the VRChat helpers. The raw `items/{id}.json` response
 * (and any richer item type built from it) satisfies this shape.
 */
export interface VrchatItemInput {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly category: VrchatCategoryInput | null;
  readonly tags: readonly { readonly name: string }[];
  readonly variations: readonly VrchatVariationInput[];
}

export interface VrchatCategoryInput {
  readonly id: number;
  readonly name: string;
  readonly parent?: { readonly name: string } | null | undefined;
}

export interface VrchatVariationInput {
  readonly name: string | null;
}

/** Optional purchase context: what the user actually owns / downloaded. */
export interface OwnershipContext {
  /** Names of the purchased variations, e.g. `しなの - Shinano`. */
  readonly ownedVariationNames?: readonly string[];
  /** Downloaded file names, e.g. `Outfit_Shinano_v1.2.zip`. */
  readonly ownedFileNames?: readonly string[];
}

export interface AvatarEntry {
  /** Stable lower-case id, e.g. `shinano`. */
  readonly id: string;
  /** Canonical name first, then aliases (hiragana / katakana / latin / abbreviations). */
  readonly names: readonly string[];
  /**
   * Short or ambiguous names (萌, ライム, 真冬 …). Restricted names count only in variations,
   * tags, a 対応アバター heading block, or when followed by 用/対応/専用/向け/ちゃん, or when
   * listed next to another avatar name. Aliases of ≤2 characters are always restricted.
   */
  readonly restricted?: boolean;
  /** Restrict only these aliases (e.g. `Maya`, which is also a 3DCG tool). */
  readonly restricted_names?: readonly string[];
}

export type AvatarDictionary = readonly AvatarEntry[];

export type Confidence = "high" | "medium" | "low";

export type CompatibilitySource = "variation" | "tag" | "description_heading" | "name" | "description" | "file_name";

export interface CompatibleAvatar {
  readonly avatar: string;
  readonly confidence: Confidence;
  readonly source: CompatibilitySource;
  /** Verbatim quote (≤120 chars) of the matched text. */
  readonly evidence: string;
}

export interface AvatarEvidence {
  readonly avatar: string;
  readonly evidence: string;
}

export interface CompatibilityResult {
  readonly compatible_avatars: readonly CompatibleAvatar[];
  readonly not_supported: readonly AvatarEvidence[];
  /** Which avatar versions the user owns (from purchased variation / downloaded file names). */
  readonly owned_versions: readonly AvatarEvidence[];
  /** When the item is an avatar body, the avatar it *is* (never reported as compatible). */
  readonly self_avatar: string | null;
}

export type CompatibilityVerdict = "supported" | "not_supported" | "unknown";

export interface CompatibilityCheck {
  /** Resolved avatar id (dictionary id, or the normalised query for unknown avatars). */
  readonly avatar: string;
  readonly result: CompatibilityVerdict;
  readonly confidence?: Confidence;
  readonly evidence: readonly string[];
  /** Why the verdict is unknown despite matching text (e.g. tag only, avatar body itself). */
  readonly reason?: string;
}

export type DependencySource = "tag" | "description" | "name" | "variation";

export interface DependencyHit {
  readonly id: string;
  readonly name: string;
  readonly source: DependencySource;
  readonly evidence: string;
}

export type QuestSupport = "yes" | "no" | "unknown";

export interface DependencyResult {
  readonly dependencies: readonly DependencyHit[];
  readonly quest_support: QuestSupport;
  readonly quest_evidence: string | null;
}

export type VrchatKind = "avatar" | "costume" | "accessory" | "tool" | "motion" | "other";

export interface AvatarSuggestion {
  readonly id_suggestion: string;
  readonly names: readonly string[];
  readonly source_item_id: number;
  /** True when the suggestion already matches an entry of the given dictionary. */
  readonly in_dictionary: boolean;
}
