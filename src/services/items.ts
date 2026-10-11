import { parseItemId } from "../booth/item-id.js";
import { buildSearchUrl, getItem, itemJsonUrl, suggestTags, type SearchUrlParams } from "../booth/public.js";
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

export interface GetItemInput {
  item: string | number;
  includeVrchat?: boolean | undefined;
}

export interface CompatibilityInput {
  item: string | number;
  avatar: string;
}

/** `items/{id}.json` → compact summary (+ VRChat info). The fetched item is stored in the cache. */
export async function getItemDetail(ctx: ServiceContext, input: GetItemInput): Promise<BoothResult<ItemDetail>> {
  const itemId = parseItemId(input.item);
  const dictionary = input.includeVrchat ? await loadDictionary(ctx) : undefined;
  const { raw, summary } = await getItem(ctx.reader, itemId);
  await storeItem(ctx, itemId, raw);
  const data: ItemDetail = dictionary ? { ...summary, vrchat: buildVrchatInfo(raw, dictionary) } : summary;
  return wrap(data, itemJsonUrl(itemId));
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
