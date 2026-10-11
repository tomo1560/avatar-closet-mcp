import { parseItemId } from "../booth/item-id.js";
import type { RawBoothItem } from "../booth/item-json.js";
import {
  buildSearchUrl,
  getItem,
  itemJsonUrl,
  suggestTags,
  summarizeItem,
  type ItemSummary,
  type SearchUrlParams,
} from "../booth/public.js";
import { asBoothError, type BoothErrorCode } from "../errors.js";
import { parseSearchPage } from "../parsers/search.js";
import type { BoothResult, CompatibilityReport, ItemDetail, SearchResult, TagSuggestions } from "../types.js";
import { classifyKind } from "../vrchat/kind.js";
import { checkCompatibility } from "../vrchat/compatibility.js";
import { getCachedItem, loadDictionary, storeItem, type ServiceContext } from "./context.js";
import { invalidInput, wrap } from "./result.js";
import { buildVrchatInfo, HEURISTIC_NOTE } from "./vrchat-info.js";

/** PLAN §2.4: a search reads at most a few pages. */
export const MAX_SEARCH_PAGE = 5;
const MAX_AVATAR_QUERY_LENGTH = 100;
/** BOOTH is temporarily unavailable: a cached copy is better than no answer. NOT_FOUND etc. are never hidden. */
const STALE_FALLBACK_CODES: ReadonlySet<BoothErrorCode> = new Set<BoothErrorCode>(["RATE_LIMITED", "NETWORK_ERROR"]);

export interface GetItemInput {
  item: string | number;
  includeVrchat?: boolean | undefined;
}

export interface CompatibilityInput {
  item: string | number;
  avatar: string;
}

/**
 * `items/{id}.json` → compact summary (+ VRChat info). An explicit lookup always asks BOOTH and stores the
 * result in the cache; only when BOOTH rate-limits or cannot be reached is a cached copy served (`stale`).
 */
export async function getItemDetail(ctx: ServiceContext, input: GetItemInput): Promise<BoothResult<ItemDetail>> {
  const itemId = parseItemId(input.item);
  const dictionary = input.includeVrchat ? await loadDictionary(ctx) : undefined;
  const { raw, summary, staleFetchedAt } = await fetchFreshOrStale(ctx, itemId);
  const data: ItemDetail = {
    ...summary,
    ...(dictionary ? { vrchat: buildVrchatInfo(raw, dictionary) } : {}),
    ...(staleFetchedAt !== undefined ? { stale: true as const, fetched_at: staleFetchedAt } : {}),
  };
  return wrap(data, itemJsonUrl(itemId));
}

async function fetchFreshOrStale(
  ctx: ServiceContext,
  itemId: string,
): Promise<{ raw: RawBoothItem; summary: ItemSummary; staleFetchedAt?: string }> {
  try {
    const { raw, summary } = await getItem(ctx.reader, itemId);
    await storeItem(ctx, itemId, raw);
    return { raw, summary };
  } catch (error) {
    if (!STALE_FALLBACK_CODES.has(asBoothError(error).code)) throw error;
    const record = await ctx.cache.getStale(itemId);
    if (!record) throw error;
    return { raw: record.item, summary: summarizeItem(record.item), staleFetchedAt: record.fetched_at };
  }
}

/** One page of BOOTH search results (HTML; at most page 5). */
export async function searchItems(ctx: ServiceContext, params: SearchUrlParams): Promise<BoothResult<SearchResult>> {
  const url = buildSearchUrl(params);
  const { data, url: finalUrl } = await ctx.reader.read(url, parseSearchPage);
  const result: SearchResult = {
    items: data.items,
    page: data.page,
    last_page: data.last_page,
    has_next: data.has_next,
    total_count: data.total_count,
  };
  const nextPage = data.has_next && data.page < MAX_SEARCH_PAGE ? data.page + 1 : undefined;
  return wrap(result, finalUrl, { page: data.page, nextPage });
}

export async function suggestTagNames(ctx: ServiceContext, term: string): Promise<BoothResult<TagSuggestions>> {
  const tags = await suggestTags(ctx.reader, term);
  return wrap({ term: term.trim(), tags }, "https://booth.pm/autocomplete/tag.json");
}

/** "Does this item support <avatar>?" with quoted evidence. Cache-first item lookup. */
export async function checkItemCompatibility(
  ctx: ServiceContext,
  input: CompatibilityInput,
): Promise<BoothResult<CompatibilityReport>> {
  const itemId = parseItemId(input.item);
  const avatar = normalizeAvatarQuery(input.avatar);
  const dictionary = await loadDictionary(ctx);
  const { raw, fetched_at } = await getCachedItem(ctx, itemId);
  const check = checkCompatibility(raw, avatar, dictionary);
  return wrap(
    {
      item_id: itemId,
      item_name: raw.name,
      kind: classifyKind(raw),
      ...check,
      metadata_fetched_at: fetched_at,
      note: HEURISTIC_NOTE,
    },
    itemJsonUrl(itemId),
  );
}

export function normalizeAvatarQuery(avatar: string): string {
  const trimmed = avatar.trim();
  if (trimmed === "") throw invalidInput("アバター名を指定してください（例: しなの, shinano）。");
  if (Array.from(trimmed).length > MAX_AVATAR_QUERY_LENGTH) {
    throw invalidInput(`アバター名は ${MAX_AVATAR_QUERY_LENGTH} 文字以内で指定してください。`);
  }
  return trimmed;
}
