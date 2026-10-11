import type { RawBoothItem } from "../booth/item-json.js";
import { buildSearchUrl, KNOWN_CATEGORY_NAMES } from "../booth/public.js";
import { ACCOUNTS_ORIGIN } from "../browser/url-policy.js";
import type { LibraryItem } from "../parsers/library.js";
import { parseSearchPage, type SearchItem } from "../parsers/search.js";
import type { AvatarInitResult, AvatarSearchHit, AvatarSearchResult, BoothResult, MyAvatarsResult, OwnedAvatar } from "../types.js";
import { mergeAvatarDictionaries, saveAvatarDictionary, SEED_AVATARS, suggestAvatarsFromLibrary } from "../vrchat/avatars.js";
import { checkCompatibility } from "../vrchat/compatibility.js";
import { classifyKind } from "../vrchat/kind.js";
import { resolveAvatarId } from "../vrchat/matcher.js";
import type { AvatarDictionary, AvatarEntry, AvatarSuggestion, CompatibilityCheck, VrchatKind } from "../vrchat/types.js";
import { dictionaryError, fetchMetadata, loadDictionary, loadUserEntries, type MetadataBatch, type ServiceContext } from "./context.js";
import { normalizeAvatarQuery } from "./items.js";
import { collectOwnedItems, LIST_MAX_FETCH, metadataStatus } from "./library.js";
import { invalidInput, wrap } from "./result.js";
import { HEURISTIC_NOTE } from "./vrchat-info.js";

/** PLAN §3.5.6: avatar searches read at most 3 pages; only the first 10 results are scored. */
export const MAX_AVATAR_SEARCH_PAGE = 3;
export const MAX_SCORED_RESULTS = 10;
const MAX_EXTRA_QUERY_LENGTH = 100;
const MAX_ENTRY_NAME_LENGTH = 100;
const LIBRARY_URL = `${ACCOUNTS_ORIGIN}/library`;
/** Search category per kind (BOOTH filters by category *name*). `other` searches every category. */
const KIND_CATEGORY: Readonly<Record<VrchatKind, number | undefined>> = {
  avatar: 208,
  costume: 209,
  accessory: 217,
  tool: 215,
  motion: 216,
  other: undefined,
};
const VERDICT_RANK: Readonly<Record<CompatibilityCheck["result"], number>> = { supported: 0, unknown: 1, not_supported: 2 };
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

export interface AvatarSearchInput {
  avatar: string;
  kind?: VrchatKind | undefined;
  query?: string | undefined;
  page?: number | undefined;
}

/** Avatar bodies the user owns (library + gifts) plus the current dictionary. */
export async function listMyAvatars(ctx: ServiceContext): Promise<BoothResult<MyAvatarsResult>> {
  const dictionary = await loadDictionary(ctx);
  const { items, batch } = await ownedMetadata(ctx);
  const bodies = ownedRawItems(items, batch).filter((raw) => classifyKind(raw) === "avatar");
  const avatars = bodies.map((raw) => ownedAvatar(raw, dictionary));
  const suggestions = suggestAvatarsFromLibrary(bodies, dictionary).filter((suggestion) => !suggestion.in_dictionary);
  return wrap(
    {
      avatars,
      suggestions,
      dictionary: dictionary.map((entry) => ({ id: entry.id, names: entry.names })),
      owned_items: items.length,
      ...metadataStatus(batch),
    },
    LIBRARY_URL,
  );
}

/** Adds owned avatar bodies missing from the dictionary to avatars.json. Existing user entries are kept as is. */
export async function initAvatarDictionary(ctx: ServiceContext): Promise<BoothResult<AvatarInitResult>> {
  const userEntries = await loadUserEntries(ctx);
  const dictionary = mergeAvatarDictionaries(SEED_AVATARS, userEntries);
  const { items, batch } = await ownedMetadata(ctx);
  const taken = new Set(dictionary.map((entry) => entry.id));
  const additions = suggestAvatarsFromLibrary(ownedRawItems(items, batch), dictionary)
    .filter((suggestion) => !suggestion.in_dictionary && !taken.has(suggestion.id_suggestion))
    .flatMap((suggestion) => toDictionaryEntry(suggestion));
  if (additions.length > 0) {
    try {
      await saveAvatarDictionary([...userEntries, ...additions.map(({ entry }) => entry)], ctx.avatarsFile);
    } catch (error) {
      throw dictionaryError(error);
    }
  }
  const added = additions.map(({ entry, sourceItemId }) => ({ id: entry.id, names: entry.names, source_item_id: sourceItemId }));
  return wrap(
    { added, user_entries_before: userEntries.length, metadata_pending: metadataStatus(batch).metadata_pending },
    LIBRARY_URL,
  );
}

/** BOOTH search for `<avatar> [query]` in the kind's category, with compatibility for the first 10 results. */
export async function searchForAvatar(ctx: ServiceContext, input: AvatarSearchInput): Promise<BoothResult<AvatarSearchResult>> {
  const avatar = normalizeAvatarQuery(input.avatar);
  const kind = input.kind ?? "costume";
  const page = validateSearchPage(input.page);
  const extra = validateExtraQuery(input.query);
  const dictionary = await loadDictionary(ctx);
  const avatarId = resolveAvatarId(avatar, dictionary);
  const primaryName = dictionary.find((entry) => entry.id === avatarId)?.names[0] ?? avatar;
  const query = [primaryName, extra].filter((part) => part !== "").join(" ");
  const categoryId = KIND_CATEGORY[kind];
  const category = categoryId === undefined ? null : (KNOWN_CATEGORY_NAMES[categoryId] ?? null);
  const { data, url } = await ctx.reader.read(buildSearchUrl({ query, category: category ?? undefined, page }), parseSearchPage);
  const head = data.items.slice(0, MAX_SCORED_RESULTS);
  const batch = await fetchMetadata(
    ctx,
    head.map((item) => item.item_id),
    MAX_SCORED_RESULTS,
  );
  const scored = scoreResults(head, batch, avatarId ?? avatar, dictionary);
  const scoredIds = new Set(scored.map((hit) => hit.item_id));
  const result: AvatarSearchResult = {
    avatar,
    avatar_id: avatarId,
    kind,
    query,
    category,
    page: data.page,
    has_next: data.has_next && data.page < MAX_AVATAR_SEARCH_PAGE,
    total_count: data.total_count,
    results: scored,
    unscored: data.items.filter((item) => !scoredIds.has(item.item_id)),
    errors: batch.errors.map((error) => ({ item_id: error.item_id, code: error.code })),
    note: HEURISTIC_NOTE,
  };
  return wrap(result, url, { page: data.page, nextPage: result.has_next ? data.page + 1 : undefined });
}

async function ownedMetadata(ctx: ServiceContext): Promise<{ items: readonly LibraryItem[]; batch: MetadataBatch }> {
  const { items } = await collectOwnedItems(ctx);
  const batch = await fetchMetadata(
    ctx,
    items.map((item) => item.item_id),
    LIST_MAX_FETCH,
  );
  return { items, batch };
}

function ownedRawItems(items: readonly LibraryItem[], batch: MetadataBatch): RawBoothItem[] {
  return items.flatMap((item) => {
    const raw = batch.items.get(item.item_id);
    return raw ? [raw] : [];
  });
}

function ownedAvatar(raw: RawBoothItem, dictionary: AvatarDictionary): OwnedAvatar {
  const suggestion = suggestAvatarsFromLibrary([raw], dictionary)[0];
  return {
    item_id: String(raw.id),
    name: raw.name,
    shop_name: raw.shop.name,
    avatar_id: suggestion?.in_dictionary ? suggestion.id_suggestion : null,
    suggested_id: suggestion?.id_suggestion ?? null,
  };
}

function toDictionaryEntry(suggestion: AvatarSuggestion): Array<{ entry: AvatarEntry; sourceItemId: number }> {
  const names = suggestion.names.filter((name) => Array.from(name).length <= MAX_ENTRY_NAME_LENGTH);
  if (names.length === 0) return [];
  return [{ entry: { id: suggestion.id_suggestion, names }, sourceItemId: suggestion.source_item_id }];
}

function scoreResults(
  head: readonly SearchItem[],
  batch: MetadataBatch,
  avatar: string,
  dictionary: AvatarDictionary,
): AvatarSearchHit[] {
  const hits = head.flatMap((item) => {
    const raw = batch.items.get(item.item_id);
    return raw ? [{ ...item, compatibility: checkCompatibility(raw, avatar, dictionary) }] : [];
  });
  return [...hits].sort((left, right) => rank(left.compatibility) - rank(right.compatibility));
}

function rank(check: CompatibilityCheck): number {
  const confidence = check.confidence === undefined ? 3 : CONFIDENCE_RANK[check.confidence];
  return VERDICT_RANK[check.result] * 10 + confidence;
}

function validateSearchPage(page: number | undefined): number {
  if (page === undefined) return 1;
  if (!Number.isInteger(page) || page < 1 || page > MAX_AVATAR_SEARCH_PAGE) {
    throw invalidInput(`page は 1〜${MAX_AVATAR_SEARCH_PAGE} の整数で指定してください。`);
  }
  return page;
}

function validateExtraQuery(query: string | undefined): string {
  const trimmed = (query ?? "").trim();
  if (Array.from(trimmed).length > MAX_EXTRA_QUERY_LENGTH) {
    throw invalidInput(`query は ${MAX_EXTRA_QUERY_LENGTH} 文字以内で指定してください。`);
  }
  return trimmed;
}
