import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { parseFreeDownloadsPage } from "../src/parsers/free-downloads.js";
import { libraryHtml } from "./helpers/buyer-html.js";

const FREE = "https://accounts.booth.pm/library/free_downloads";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof BoothError) return error.code;
    throw error;
  }
  return undefined;
}

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/buyer/${name}`, import.meta.url), "utf8");
}

describe("parseFreeDownloadsPage (captured layout)", () => {
  it("reads the cards (without files) and the Kaminari pager", () => {
    const page = parseFreeDownloadsPage(fixture("free-downloads.html"), FREE);
    expect(page).toMatchObject({ page: 1, last_page: 3, has_next: true });
    expect(page.items.map((item) => [item.item_id, item.name, item.shop_name])).toEqual([
      ["1000101", "架空フリー素材 テクスチャ集", "架空フリー工房"],
      ["1000102", "Kakuu Free Shader Sample", "Kakuu Lab"],
      ["1000103", "架空無料ヘアゴム【しなの対応】", "架空ショップ"],
    ]);
    expect(page.items.every((item) => item.downloadables.length === 0)).toBe(true);
    expect(page.items[0]).toMatchObject({
      item_url: "https://booth.pm/ja/items/1000101",
      shop_url: "https://kakuu-free.booth.pm/",
      thumbnail_url: expect.stringContaining("booth.pximg.net") as unknown,
    });
  });

  it("reads a later page from the URL", () => {
    const html = libraryHtml([{ id: 7, name: "架空" }], { page: 3, lastPage: 3, path: "/library/free_downloads" });
    expect(parseFreeDownloadsPage(html, `${FREE}?page=3`)).toMatchObject({ page: 3, last_page: 3, has_next: false });
  });

  it("rejects the purchases tab (BOOTH_CHANGED) and a sign-in page (AUTH_REQUIRED)", () => {
    const html = fixture("free-downloads.html");
    expect(codeOf(() => parseFreeDownloadsPage(html, "https://accounts.booth.pm/library"))).toBe("BOOTH_CHANGED");
    expect(codeOf(() => parseFreeDownloadsPage(fixture("sign-in.html"), "https://accounts.booth.pm/users/sign_in"))).toBe("AUTH_REQUIRED");
  });
});
