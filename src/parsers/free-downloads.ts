/**
 * Parser for accounts.booth.pm/library/free_downloads (the library's "無料ダウンロード" tab).
 *
 * Verified against a real logged-in capture 2026-10-12 (tests/fixtures/buyer/free-downloads.html, WISHLIST_CAPTURED.md):
 * the same `div.bg-white.p-16` cards and Kaminari pager as /library and /library/gifts, but the cards have NO file
 * rows (free items are downloaded from the item page), so `downloadables` is always empty here.
 */
import { parseLibraryLikePage, type LibraryPage } from "./library.js";

const FREE_DOWNLOADS_PATH = /^\/library\/free_downloads\/?$/u;

export function parseFreeDownloadsPage(html: string, finalUrl: string): LibraryPage {
  return parseLibraryLikePage(html, finalUrl, FREE_DOWNLOADS_PATH, "無料ダウンロード");
}
