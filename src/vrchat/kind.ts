import { normalizeCompact } from "./text.js";
import type { VrchatItemInput, VrchatKind } from "./types.js";

export interface BoothCategoryKind {
  readonly name: string;
  readonly kind: VrchatKind;
}

export const AVATAR_CATEGORY_ID = 208;

/**
 * BOOTH 3D categories observed in real data (tests/fixtures/public/README.md) mapped to
 * the normalised VRChat kind. 3D髪型 has no own kind and is treated as an accessory;
 * 3Dテクスチャ is `other`. Category 208 is refined by {@link isAvatarBody}.
 */
export const BOOTH_CATEGORY_KINDS: Readonly<Record<number, BoothCategoryKind>> = {
  208: { name: "3Dキャラクター", kind: "avatar" },
  209: { name: "3D衣装", kind: "costume" },
  210: { name: "3D小道具", kind: "accessory" },
  214: { name: "3Dテクスチャ", kind: "other" },
  215: { name: "3Dツール・システム", kind: "tool" },
  216: { name: "3Dモーション・アニメーション", kind: "motion" },
  217: { name: "3D装飾品", kind: "accessory" },
  230: { name: "3D髪型", kind: "accessory" },
};

/** Add-ons sold under 3Dキャラクター: prefabs, expressions, gimmicks, 〇〇専用 sets. */
const STRONG_NON_BODY =
  /(prefab|ぷれはぶ|表情|expression|ぎみっく|gimmick|ろり化|ちび化|しぇいぷきー|shapekey|改変用|(?<!vrchat|pc|quest|unity)専用)/;
/** Weaker add-on hints, overridden by an explicit body marker (オリジナル3Dモデル「…」). */
const WEAK_NON_BODY =
  /(衣装|outfit|へあ|hair|てくすちゃ|texture|あにめーしょん|animation|ぽーず|pose|めいく|makeup|あくせさり|accessor|ねいる|nail|ぱーつ|parts|素体用|addon)/;
const BODY_MARKER = /(おりじなる(3d)?(もでる|あばたー|きゃらくたー)|original(3d)?(model|avatar|character))/;
const QUOTED_NAME = /[「『]([^」』]+)[」』]/;
const DECORATION = /【[^】]*】|\[[^\]]*\]|［[^］]*］|（[^）]*）|\([^)]*\)/g;
const BODY_WORDS =
  /オリジナル|original(\s*3d)?(\s*(model|avatar|character))?|3D\s*モデル|3D\s*キャラクター|アバター|VRChat想定|ver\.?\s*[\d.]+/gi;

/** True when a category-208 item is an avatar body rather than an add-on for one. */
export function isAvatarBody(item: Pick<VrchatItemInput, "name" | "category">): boolean {
  if (item.category?.id !== AVATAR_CATEGORY_ID) return false;
  const compact = normalizeCompact(item.name);
  if (STRONG_NON_BODY.test(compact)) return false;
  if (BODY_MARKER.test(compact) || QUOTED_NAME.test(item.name)) return true;
  return !WEAK_NON_BODY.test(compact);
}

/** Display name of an avatar body: 「しなの」 → しなの; otherwise the name without decorations. */
export function extractAvatarDisplayName(itemName: string): string | null {
  const quoted = QUOTED_NAME.exec(itemName)?.[1]?.trim();
  if (quoted) return quoted;
  const stripped = itemName.replace(DECORATION, " ").replace(BODY_WORDS, " ").replace(/\s+/g, " ").trim();
  return stripped === "" ? null : stripped;
}

/** Normalised VRChat kind of an item (by category, refined by content for category 208). */
export function classifyKind(item: Pick<VrchatItemInput, "name" | "category">): VrchatKind {
  const categoryId = item.category?.id;
  if (categoryId === undefined) return "other";
  if (categoryId === AVATAR_CATEGORY_ID) return isAvatarBody(item) ? "avatar" : "other";
  return BOOTH_CATEGORY_KINDS[categoryId]?.kind ?? "other";
}
