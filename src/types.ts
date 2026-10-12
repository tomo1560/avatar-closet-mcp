import type { ItemSummary } from "./booth/public.js";
import type { FetchManyErrorCode } from "./cache/item-cache.js";
import type { OrderDetail, OrderSummary } from "./parsers/buyer-orders.js";
import type { SearchItem } from "./parsers/search.js";
import type { WishlistItem, WishlistName } from "./parsers/wishlist.js";
import type {
  AvatarEvidence,
  AvatarSuggestion,
  CompatibilityCheck,
  CompatibleAvatar,
  DependencyHit,
  QuestSupport,
  VrchatKind,
} from "./vrchat/types.js";

export interface ResultMeta {
  fetchedAt: string;
  sourceUrl: string;
  page?: number;
  nextPage?: number;
  redactions: string[];
}

export interface BoothResult<T> {
  data: T;
  meta: ResultMeta;
}

export interface AuthStatus {
  authenticated: boolean;
  /** Best-effort; omitted when the settings page does not expose it reliably. */
  displayName?: string;
}

export interface LoginResult {
  authenticated: true;
}

export interface LogoutResult {
  sessionFileRemoved: boolean;
  profileDirRemoved: boolean;
  warnings: string[];
}

/** VRChat view of one item: evidence-based heuristics, never a guess (PLAN §3.5.1). */
export interface VrchatInfo {
  kind: VrchatKind;
  compatible_avatars: readonly CompatibleAvatar[];
  not_supported: readonly AvatarEvidence[];
  /** Only when purchase context (library file names) is known. */
  owned_versions?: readonly AvatarEvidence[];
  self_avatar: string | null;
  dependencies: readonly DependencyHit[];
  quest_support: QuestSupport;
  quest_evidence: string | null;
}

/** `booth_get_item` output (`ItemSummary` from `booth/public.ts` plus optional VRChat info). */
export interface ItemDetail extends ItemSummary {
  vrchat?: VrchatInfo;
  /** Only when BOOTH could not be reached (RATE_LIMITED / NETWORK_ERROR) and a cached copy was served instead. */
  stale?: true;
  /** When the served cached copy was fetched (present together with `stale`). */
  fetched_at?: string;
}

export interface SearchResult {
  items: readonly SearchItem[];
  page: number;
  last_page: number | null;
  has_next: boolean;
  total_count: number | null;
}

export interface TagSuggestions {
  term: string;
  tags: string[];
}

/** `library` = purchases, `gifts` = received gifts, `free_downloads` = free items obtained from BOOTH. */
export type LibrarySource = "library" | "gifts" | "free_downloads";

export interface LibraryFile {
  downloadable_id: string;
  file_name: string | null;
}

/** Compact VRChat view used by the library filters. */
export interface LibraryVrchatInfo {
  kind: VrchatKind;
  /** Avatar versions the user owns, read from the downloaded file names. */
  owned_versions: readonly AvatarEvidence[];
  /** Dependency ids such as `liltoon` or `modular_avatar`. */
  dependencies: string[];
  /** Present when the `avatar` filter is used. */
  compatibility?: CompatibilityCheck;
}

export interface LibraryEntry {
  item_id: string;
  name: string;
  shop_name: string | null;
  item_url: string;
  thumbnail_url: string | null;
  downloadables: LibraryFile[];
  vrchat?: LibraryVrchatInfo;
}

export interface MetadataError {
  item_id: string;
  code: FetchManyErrorCode;
}

/** Cache coverage reported by tools that need `items/{id}.json` for owned items. */
export interface MetadataStatus {
  /** Items whose metadata is not cached yet (budget of this call exhausted). */
  metadata_pending: number;
  /** Items BOOTH reports as deleted or private (skipped until the cache TTL expires). */
  metadata_unavailable: number;
  metadata_errors: MetadataError[];
  hint?: string;
}

export interface LibraryListing extends Partial<MetadataStatus> {
  source: LibrarySource;
  items: LibraryEntry[];
  /** Number of returned items (after filters). */
  count: number;
  /** First and last page that were read. */
  first_page: number;
  last_page_read: number;
  /** BOOTH's last page number when known. */
  last_page: number | null;
  has_next: boolean;
  /** `all=true` stopped at the page cap while more pages exist. */
  truncated: boolean;
  filters: LibraryFilters;
}

export interface LibraryFilters {
  query?: string;
  avatar?: string;
  kind?: VrchatKind;
  dependency?: string;
}

export interface WishlistEntry extends WishlistItem {
  /** Heuristic VRChat view (only with `include_vrchat` and when the item metadata is available). */
  vrchat?: VrchatInfo;
}

/** `booth_list_wishlist` output. `list` is the named list that was read, `null` for every wished item. */
export interface WishlistListing extends Partial<MetadataStatus> {
  list: WishlistName | null;
  items: WishlistEntry[];
  count: number;
  first_page: number;
  last_page_read: number;
  total_pages: number;
  /** Items in the whole list (all pages), as reported by BOOTH. */
  total_count: number;
  has_next: boolean;
  /** `all=true` stopped at the page cap while more pages exist. */
  truncated: boolean;
  /** Present with `include_vrchat`. */
  note?: string;
}

export interface WishlistNamesResult {
  lists: WishlistName[];
  count: number;
}

export interface OrdersListing {
  orders: readonly OrderSummary[];
  page: number;
  last_page: number | null;
  has_next: boolean;
}

export type OrderResult = OrderDetail;

export interface CompatibilityReport extends CompatibilityCheck {
  item_id: string;
  item_name: string;
  kind: VrchatKind;
  /** When the item metadata was fetched (cache-first). */
  metadata_fetched_at: string;
  note: string;
}

export interface OwnedAvatar {
  item_id: string;
  name: string;
  shop_name: string;
  /** Dictionary id when the avatar is already in the dictionary, otherwise `null`. */
  avatar_id: string | null;
  /** Id that `avatars init` would use (`null` when no name could be derived). */
  suggested_id: string | null;
}

export interface MyAvatarsResult extends MetadataStatus {
  avatars: OwnedAvatar[];
  /** Avatars found in the library but missing from the dictionary (`avatars init` adds them). */
  suggestions: readonly AvatarSuggestion[];
  dictionary: Array<{ id: string; names: readonly string[] }>;
  owned_items: number;
}

export interface AvatarSearchHit extends SearchItem {
  compatibility: CompatibilityCheck;
}

export interface AvatarSearchResult {
  avatar: string;
  /** Dictionary id, or `null` when the avatar is not in the dictionary (matched literally). */
  avatar_id: string | null;
  kind: VrchatKind;
  query: string;
  category: string | null;
  page: number;
  has_next: boolean;
  total_count: number | null;
  /** First results (at most 10), scored from cached / fetched item metadata. */
  results: AvatarSearchHit[];
  /** Remaining results, not scored to keep the request count low. */
  unscored: SearchItem[];
  errors: MetadataError[];
  note: string;
}

export interface SyncResult {
  total_items: number;
  /** Items served from a fresh cache record in this call. */
  cached: number;
  fetched: number;
  remaining: number;
  unavailable: number;
  errors: Array<MetadataError & { message: string }>;
  truncated: boolean;
}

export interface AvatarInitResult {
  added: Array<{ id: string; names: readonly string[]; source_item_id: number }>;
  user_entries_before: number;
  metadata_pending: number;
}
