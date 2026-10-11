import { z } from "zod";
import { BoothError } from "../errors.js";

/*
 * Schema for the public `https://booth.pm/ja/items/{id}.json` response (34 top-level keys observed,
 * see tests/fixtures/public/README.md).
 *
 * Policy: every object is a loose object (unknown keys are kept, BOOTH may add fields at any time).
 * Fields that the summary / VRChat logic depends on are required; a missing or mistyped required
 * field is reported as `BOOTH_CHANGED`. Peripheral fields are optional so that a cosmetic change on
 * BOOTH's side does not break every item lookup.
 */

const downloadableFileSchema = z.looseObject({
  name: z.string().optional(),
  file_name: z.string().optional(),
  file_extension: z.string().optional(),
  file_size: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
});

const downloadableSchema = z.looseObject({
  musics: z.array(downloadableFileSchema).optional(),
  no_musics: z.array(downloadableFileSchema).optional(),
});

const variationSchema = z.looseObject({
  id: z.number().int(),
  /** `null` for single-variation items. */
  name: z.string().nullable(),
  type: z.string(),
  /** Numeric price in JPY (the top-level `price` is a display string). */
  price: z.number(),
  /** e.g. `addable_to_cart`, `free_download`. */
  status: z.string(),
  /** Free variations expose their files even when logged out; paid ones are `null`. */
  downloadable: downloadableSchema.nullable().optional(),
});

const shopSchema = z.looseObject({
  uuid: z.string().optional(),
  name: z.string(),
  subdomain: z.string(),
  url: z.string(),
  verified: z.boolean().optional(),
  thumbnail_url: z.string().nullable().optional(),
});

const categorySchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  /** Parent has a name and url but no id. */
  parent: z.looseObject({ name: z.string(), url: z.string().optional() }).nullable().optional(),
  url: z.string().optional(),
});

const imageSchema = z.looseObject({
  original: z.string(),
  resized: z.string().optional(),
  caption: z.string().nullable().optional(),
});

const tagSchema = z.looseObject({
  name: z.string(),
  url: z.string().optional(),
});

export const rawBoothItemSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  /** Display string such as `"¥ 2,500~"`. */
  price: z.string(),
  is_adult: z.boolean(),
  url: z.string(),
  published_at: z.string().nullable().optional(),
  wish_lists_count: z.number().optional(),
  shop: shopSchema,
  category: categorySchema,
  images: z.array(imageSchema),
  tags: z.array(tagSchema),
  variations: z.array(variationSchema),
  // Viewer-specific state. Logged out: `wished: false, order: null, gift: null`.
  // TODO(PLAN §7-8): the logged-in shapes of `order` / `gift` are unverified, so they stay `unknown`.
  wished: z.unknown().optional(),
  order: z.unknown().optional(),
  gift: z.unknown().optional(),
});

export type RawBoothItem = z.infer<typeof rawBoothItemSchema>;
export type RawBoothVariation = z.infer<typeof variationSchema>;
export type RawBoothDownloadable = z.infer<typeof downloadableSchema>;
export type RawBoothShop = z.infer<typeof shopSchema>;
export type RawBoothCategory = z.infer<typeof categorySchema>;
export type RawBoothTag = z.infer<typeof tagSchema>;
export type RawBoothImage = z.infer<typeof imageSchema>;

const MAX_REPORTED_ISSUES = 5;

/**
 * Validates an `items/{id}.json` payload. Throws `BoothError("BOOTH_CHANGED")` when required
 * fields are missing or mistyped. The error message lists issue paths only (never values).
 */
export function parseRawBoothItem(json: unknown, sourceUrl?: string): RawBoothItem {
  const result = rawBoothItemSchema.safeParse(json);
  if (result.success) return result.data;
  throw new BoothError(
    "BOOTH_CHANGED",
    `BOOTH の商品 JSON の形式が想定と異なります（${describeIssues(result.error)}）。`,
    sourceUrl,
  );
}

/** Formats zod issues as `path: code` pairs without echoing input values. */
export function describeIssues(error: z.ZodError): string {
  const described = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`);
  const extra = error.issues.length - described.length;
  return extra > 0 ? `${described.join(", ")}, +${extra} more` : described.join(", ");
}
