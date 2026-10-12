import { ACCOUNTS_ORIGIN } from "../browser/url-policy.js";
import { parseFreeDownloadsPage } from "../parsers/free-downloads.js";
import { parseGiftsPage, parseLibraryPage, type LibraryItem, type LibraryPage } from "../parsers/library.js";
import type { BoothResult, LibraryEntry, LibraryFilters, LibraryListing, LibrarySource, MetadataStatus } from "../types.js";
import type { AvatarDictionary, VrchatKind } from "../vrchat/types.js";
import { fetchMetadata, loadDictionary, type MetadataBatch, type OwnedItems, type ServiceContext } from "./context.js";
import { normalizeAvatarQuery } from "./items.js";
import { invalidInput, pagedUrl, wrap } from "./result.js";
import { buildLibraryVrchatInfo, ownedFileNames, resolveDependencyId } from "./vrchat-info.js";

/** Hard cap for `all=true` and for walks done by sync / my-avatars (PLAN §2.4: no unbounded crawling). */
export const MAX_LIBRARY_PAGES = 20;
/** PLAN §3.5.7: one MCP call fetches at most 20 uncached items. */
export const LIST_MAX_FETCH = 20;
const MAX_QUERY_LENGTH = 100;
export const SYNC_HINT =
  "メタデータ未取得の商品があります。booth_sync_library_metadata を繰り返し呼ぶか、CLI の `booth-library-mcp sync` で事前に取り込んでください。";

const SOURCES: Readonly<Record<LibrarySource, { url: string; parse: (html: string, url: string) => LibraryPage }>> = {
  library: { url: `${ACCOUNTS_ORIGIN}/library`, parse: parseLibraryPage },
  gifts: { url: `${ACCOUNTS_ORIGIN}/library/gifts`, parse: parseGiftsPage },
  free_downloads: { url: `${ACCOUNTS_ORIGIN}/library/free_downloads`, parse: parseFreeDownloadsPage },
};

export interface LibraryQuery {
  page?: number | undefined;
  all?: boolean | undefined;
  query?: string | undefined;
  avatar?: string | undefined;
  kind?: VrchatKind | undefined;
  dependency?: string | undefined;
}

export interface LibraryWalk {
  readonly items: readonly LibraryItem[];
  readonly firstPage: number;
  readonly lastPageRead: number;
  readonly lastPage: number | null;
  readonly hasNext: boolean;
  readonly truncated: boolean;
  readonly sourceUrl: string;
}

interface WalkState {
  readonly lastPageRead: number;
  readonly lastPage: number | null;
  readonly hasNext: boolean;
  readonly sourceUrl: string;
}

interface ResolvedFilters {
  readonly query: string | undefined;
  readonly avatar: string | undefined;
  readonly kind: VrchatKind | undefined;
  readonly dependencyId: string | undefined;
}

/** Library / gifts / free-downloads listing with optional local and VRChat filters. Inputs are validated before any request. */
export async function listLibrary(
  ctx: ServiceContext,
  source: LibrarySource,
  input: LibraryQuery,
): Promise<BoothResult<LibraryListing>> {
  const filters = resolveFilters(input);
  const needsMetadata = filters.avatar !== undefined || filters.kind !== undefined || filters.dependencyId !== undefined;
  const dictionary = needsMetadata ? await loadDictionary(ctx) : undefined;
  const startPage = input.page ?? 1;
  const walk = input.all ? await walkLibrary(ctx, source, startPage) : await readOnePage(ctx, source, startPage);
  const matched = walk.items.filter((item) => matchesQuery(item, filters.query));
  const filtered = dictionary ? await filterByMetadata(ctx, matched, filters, dictionary) : { entries: matched.map(toEntry) };
  const listing: LibraryListing = {
    source,
    items: filtered.entries,
    count: filtered.entries.length,
    first_page: walk.firstPage,
    last_page_read: walk.lastPageRead,
    last_page: walk.lastPage,
    has_next: walk.hasNext,
    truncated: walk.truncated,
    filters: describeFilters(filters),
    ...("status" in filtered ? filtered.status : {}),
  };
  const nextPage = walk.hasNext ? walk.lastPageRead + 1 : undefined;
  return wrap(listing, walk.sourceUrl, { page: walk.firstPage, nextPage });
}

/**
 * Reads pages from `startPage` until the last page, at most MAX_LIBRARY_PAGES. BOOTH clamps a page past
 * the end and re-serves the last page, so the walk also stops when the parsed page differs from the
 * requested one or a page brings no new item ids.
 */
export async function walkLibrary(ctx: ServiceContext, source: LibrarySource, startPage = 1): Promise<LibraryWalk> {
  const byId = new Map<string, LibraryItem>();
  let state: WalkState = { lastPageRead: startPage, lastPage: null, hasNext: false, sourceUrl: "" };
  for (let page = startPage; page < startPage + MAX_LIBRARY_PAGES; page += 1) {
    const { data, url } = await readPage(ctx, source, page);
    if (page === startPage) state = { ...state, sourceUrl: url };
    if (data.page !== page) {
      state = { ...state, hasNext: false };
      break;
    }
    const newIds = data.items.filter((item) => !byId.has(item.item_id)).length;
    for (const item of data.items) byId.set(item.item_id, mergeItem(byId.get(item.item_id), item));
    state = { ...state, lastPageRead: page, lastPage: data.last_page, hasNext: data.has_next && newIds > 0 };
    if (!state.hasNext) break;
  }
  const truncated = state.hasNext && state.lastPageRead >= startPage + MAX_LIBRARY_PAGES - 1;
  return { items: [...byId.values()], firstPage: startPage, ...state, truncated };
}

/**
 * Everything the user owns (library + gifts, all pages up to the cap). The walk is reused for
 * OWNED_ITEMS_TTL_MS so repeated sync / avatar calls do not re-read every page.
 */
export function collectOwnedItems(ctx: ServiceContext): Promise<OwnedItems> {
  return ctx.ownedItems.get(async () => {
    const library = await walkLibrary(ctx, "library");
    const gifts = await walkLibrary(ctx, "gifts");
    const byId = new Map<string, LibraryItem>();
    for (const item of [...library.items, ...gifts.items]) byId.set(item.item_id, mergeItem(byId.get(item.item_id), item));
    return { items: [...byId.values()], truncated: library.truncated || gifts.truncated };
  });
}

/** Library + gifts + free downloads. `purchased` is the library + gifts part (the only one listing files). */
export interface OwnedWithFree extends OwnedItems {
  readonly purchased: OwnedItems;
}

/**
 * Everything the user has, including free downloads, for "what do I own" questions (my avatars, avatars init,
 * sync, unity-check). Free-download cards list no files, so update checks and the file-composition snapshots
 * keep using `purchased`. The free walk is memoised like the library walk.
 */
export async function collectOwnedWithFree(ctx: ServiceContext): Promise<OwnedWithFree> {
  const purchased = await collectOwnedItems(ctx);
  const free = await ctx.freeItems.get(async () => {
    const walk = await walkLibrary(ctx, "free_downloads");
    return { items: walk.items, truncated: walk.truncated };
  });
  const known = new Set(purchased.items.map((item) => item.item_id));
  const extra = free.items.filter((item) => !known.has(item.item_id));
  return { items: [...purchased.items, ...extra], truncated: purchased.truncated || free.truncated, purchased };
}

/** Cache coverage summary shared by the tools that need owned item metadata. */
export function metadataStatus(batch: MetadataBatch): MetadataStatus {
  const pending = batch.remaining.filter((id) => !batch.items.has(id)).length;
  return {
    metadata_pending: pending,
    metadata_unavailable: batch.unavailable.length,
    metadata_errors: batch.errors.map((error) => ({ item_id: error.item_id, code: error.code })),
    ...(pending > 0 ? { hint: SYNC_HINT } : {}),
  };
}

async function readPage(ctx: ServiceContext, source: LibrarySource, page: number): Promise<{ data: LibraryPage; url: string }> {
  const { url, parse } = SOURCES[source];
  return ctx.reader.read(pagedUrl(url, page), parse);
}

async function readOnePage(ctx: ServiceContext, source: LibrarySource, page: number): Promise<LibraryWalk> {
  const { data, url } = await readPage(ctx, source, page);
  const clamped = data.page !== page;
  return {
    items: clamped ? [] : data.items,
    firstPage: page,
    lastPageRead: page,
    lastPage: data.last_page,
    hasNext: !clamped && data.has_next,
    truncated: false,
    sourceUrl: url,
  };
}

async function filterByMetadata(
  ctx: ServiceContext,
  items: readonly LibraryItem[],
  filters: ResolvedFilters,
  dictionary: AvatarDictionary,
): Promise<{ entries: LibraryEntry[]; status: MetadataStatus }> {
  const batch = await fetchMetadata(
    ctx,
    items.map((item) => item.item_id),
    LIST_MAX_FETCH,
  );
  const entries = items.flatMap((item) => {
    const raw = batch.items.get(item.item_id);
    if (!raw) return [];
    const vrchat = buildLibraryVrchatInfo(raw, dictionary, ownedFileNames(item.downloadables), filters.avatar);
    if (filters.kind !== undefined && vrchat.kind !== filters.kind) return [];
    if (filters.dependencyId !== undefined && !vrchat.dependencies.includes(filters.dependencyId)) return [];
    if (filters.avatar !== undefined && vrchat.compatibility?.result !== "supported") return [];
    return [{ ...toEntry(item), vrchat }];
  });
  return { entries, status: metadataStatus(batch) };
}

function resolveFilters(input: LibraryQuery): ResolvedFilters {
  const query = input.query?.trim();
  if (query !== undefined && Array.from(query).length > MAX_QUERY_LENGTH) {
    throw invalidInput(`query は ${MAX_QUERY_LENGTH} 文字以内で指定してください。`);
  }
  if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)) {
    throw invalidInput("page は 1 以上の整数で指定してください。");
  }
  return {
    query: query ? query.toLowerCase() : undefined,
    avatar: input.avatar === undefined ? undefined : normalizeAvatarQuery(input.avatar),
    kind: input.kind,
    dependencyId: input.dependency === undefined ? undefined : resolveDependencyId(input.dependency),
  };
}

function describeFilters(filters: ResolvedFilters): LibraryFilters {
  return {
    ...(filters.query !== undefined ? { query: filters.query } : {}),
    ...(filters.avatar !== undefined ? { avatar: filters.avatar } : {}),
    ...(filters.kind !== undefined ? { kind: filters.kind } : {}),
    ...(filters.dependencyId !== undefined ? { dependency: filters.dependencyId } : {}),
  };
}

function matchesQuery(item: LibraryItem, query: string | undefined): boolean {
  if (query === undefined) return true;
  return [item.name, item.shop_name ?? ""].some((text) => text.toLowerCase().includes(query));
}

function toEntry(item: LibraryItem): LibraryEntry {
  return {
    item_id: item.item_id,
    name: item.name,
    shop_name: item.shop_name,
    item_url: item.item_url,
    thumbnail_url: item.thumbnail_url,
    downloadables: item.downloadables.map((file) => ({ downloadable_id: file.downloadable_id, file_name: file.file_name })),
  };
}

/** The same item can be listed on several pages (one card per purchase): keep the first, add new files. */
function mergeItem(existing: LibraryItem | undefined, item: LibraryItem): LibraryItem {
  if (!existing) return item;
  const known = new Set(existing.downloadables.map((file) => file.downloadable_id));
  return { ...existing, downloadables: [...existing.downloadables, ...item.downloadables.filter((file) => !known.has(file.downloadable_id))] };
}
