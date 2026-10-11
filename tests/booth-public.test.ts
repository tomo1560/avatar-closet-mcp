import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BoothReader } from "../src/browser/reader.js";
import { parseRawBoothItem, rawBoothItemSchema, type RawBoothItem } from "../src/booth/item-json.js";
import { buildSearchUrl, getItem, itemJsonUrl, suggestTags, summarizeItem } from "../src/booth/public.js";
import { BoothError, type BoothErrorCode } from "../src/errors.js";

const fixtureDir = new URL("./fixtures/public/", import.meta.url);
const loadJson = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(name, fixtureDir)), "utf8"));
const loadItem = (id: string): Record<string, unknown> => loadJson(`items/${id}.json`) as Record<string, unknown>;

type Responder = (url: string) => Promise<unknown>;

/** Mimics BoothHttpClient.readJson: the parser runs inside the reader, errors propagate as thrown. */
function fakeReader(respond: Responder): { reader: BoothReader; calls: string[] } {
  const calls: string[] = [];
  const reader: BoothReader = {
    read: () => Promise.reject(new Error("read() is not expected")),
    async readJson<T>(path: string, parser: (json: unknown, finalUrl: string) => T) {
      calls.push(path);
      const json = await respond(path);
      return { data: parser(json, path), url: path };
    },
    close: () => Promise.resolve(),
  };
  return { reader, calls };
}

const itemReader = (id: string, mutate: (json: Record<string, unknown>) => unknown = (json) => json) =>
  fakeReader(() => Promise.resolve(mutate(loadItem(id))));

async function expectBoothError(promise: Promise<unknown>, code: BoothErrorCode): Promise<BoothError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BoothError);
    expect((error as BoothError).code).toBe(code);
    return error as BoothError;
  }
  throw new Error(`expected ${code}`);
}

describe("getItem", () => {
  it("fetches items/{id}.json and summarizes a free tool with downloadable variations (3087170)", async () => {
    const { reader, calls } = itemReader("3087170");
    const { raw, summary } = await getItem(reader, "https://lilxyzw.booth.pm/items/3087170?from=x");

    expect(calls).toEqual(["https://booth.pm/ja/items/3087170.json"]);
    expect(raw.id).toBe(3087170);
    expect(summary).toMatchObject({
      item_id: "3087170",
      name: "【無料】lilToon",
      url: "https://lilxyzw.booth.pm/items/3087170",
      price: "¥ 500",
      is_adult: false,
      published_at: "2021-07-12T17:22:41.000+09:00",
      shop: { name: "lilLab", subdomain: "lilxyzw", url: "https://lilxyzw.booth.pm/", verified: false },
      category: { id: 215, name: "3Dツール・システム", parent_name: "3Dモデル" },
      tags: ["Unity", "VRChat", "シェーダー"],
      wish_lists_count: 51293,
      description_truncated: false,
      viewer: null,
    });
    expect(summary.variations).toEqual([
      { id: 12317982, name: "lilToon 2.x.x", price: 0, type: "digital", status: "free_download", is_free: true, has_download: true },
      { id: 5108644, name: "lilToon 1.x.x", price: 0, type: "digital", status: "free_download", is_free: true, has_download: true },
      { id: 5159139, name: "投げ銭 (Donation)", price: 500, type: "digital", status: "addable_to_cart", is_free: false, has_download: false },
    ]);
    expect(summary.images).toHaveLength(3);
    expect(summary.images[0]).toMatch(/^https:\/\/booth\.pximg\.net\/.*8028f6d0c6ad_base_resized\.jpg$/);
    expect(summary.description.startsWith("アバターを用いたサービス")).toBe(true);
  });

  it("never exposes downloadable URLs in the summary", async () => {
    const { reader } = itemReader("3087170");
    const { summary } = await getItem(reader, 3087170);
    expect(JSON.stringify(summary)).not.toContain("downloadables");
  });

  it("summarizes a single-variation avatar with a null variation name (6106863)", async () => {
    const { reader } = itemReader("6106863");
    const { summary } = await getItem(reader, 6106863);
    expect(summary).toMatchObject({
      item_id: "6106863",
      name: "オリジナル3Dモデル「しなの」",
      price: "¥ 6,000",
      category: { id: 208, name: "3Dキャラクター", parent_name: "3Dモデル" },
      tags: ["オリジナル", "3Dキャラクター", "3Dモデル", "しなの", "VRChat"],
      variations: [
        { id: 10314597, name: null, price: 6000, type: "digital", status: "addable_to_cart", is_free: false, has_download: false },
      ],
      viewer: null,
    });
  });

  it("summarizes a multi-avatar costume (4866933) and keeps variation order", async () => {
    const { reader } = itemReader("4866933");
    const { summary } = await getItem(reader, "https://booth.pm/ja/items/4866933");
    expect(summary.variations.map((variation) => variation.name)).toEqual([
      "Kikyo Moe Selestia", "Milfy", "Shinano", "Milltina", "Airi", "Kikyo", "Moe", "Manuka", "Selestia", "Imeris", "Lime",
    ]);
    expect(summary.variations.every((variation) => !variation.is_free && !variation.has_download)).toBe(true);
    expect(summary.tags).toContain("しなの");
    expect(summary.description_truncated).toBe(false);
  });

  it("truncates long descriptions by code point and flags it", async () => {
    const { reader } = itemReader("6115428");
    const full = (loadItem("6115428").description as string).trim();
    const { summary } = await getItem(reader, 6115428, { descriptionMaxChars: 100 });
    expect(summary.description_truncated).toBe(true);
    expect(Array.from(summary.description).length).toBeLessThanOrEqual(100);
    expect(full.startsWith(summary.description)).toBe(true);
    expect(summary.description).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("caps descriptions at 2000 characters by default", () => {
    const raw = parseRawBoothItem({ ...loadItem("6106863"), description: `${"😀".repeat(2500)}` });
    const summary = summarizeItem(raw);
    expect(summary.description_truncated).toBe(true);
    expect(Array.from(summary.description)).toHaveLength(2000);
  });

  it("reports viewer state only when the JSON carries logged-in fields", () => {
    const base = loadItem("6106863");
    const wished = summarizeItem(parseRawBoothItem({ ...base, wished: true }));
    expect(wished.viewer).toEqual({ wished: true, ordered: false, gifted: false });
    const ordered = summarizeItem(parseRawBoothItem({ ...base, order: { purchased_at: "2026-01-01" } }));
    expect(ordered.viewer).toEqual({ wished: false, ordered: true, gifted: false });
    const gifted = summarizeItem(parseRawBoothItem({ ...base, gift: { id: 1 } }));
    expect(gifted.viewer).toEqual({ wished: false, ordered: false, gifted: true });
    const missing = { ...base };
    delete missing.wished;
    delete missing.order;
    delete missing.gift;
    expect(summarizeItem(parseRawBoothItem(missing)).viewer).toBeNull();
  });

  it("tolerates missing optional fields and keeps unknown fields", () => {
    const json: Record<string, unknown> = { ...loadItem("6106863"), brand_new_field: { nested: true } };
    delete json.published_at;
    delete json.wish_lists_count;
    json.category = { id: 1, name: "トップ", parent: null };
    json.shop = { name: "s", subdomain: "s", url: "https://s.booth.pm/" };
    const raw = parseRawBoothItem(json);
    expect((raw as Record<string, unknown>).brand_new_field).toEqual({ nested: true });
    const summary = summarizeItem(raw);
    expect(summary).toMatchObject({
      published_at: null,
      wish_lists_count: null,
      category: { id: 1, name: "トップ", parent_name: null },
      shop: { verified: false },
    });
  });

  it("parses all 14 public fixtures", () => {
    const ids = ["3087170", "3681787", "4866933", "4904935", "4911160", "5359699", "5737352", "6106863",
      "6115428", "6289322", "6659058", "6745224", "7065708", "8831909"];
    for (const id of ids) {
      const raw = parseRawBoothItem(loadItem(id));
      expect(String(raw.id)).toBe(id);
      expect(rawBoothItemSchema.safeParse(raw).success).toBe(true);
    }
  });

  it("is structurally usable as the VRChat module's minimal input", () => {
    const raw: RawBoothItem = parseRawBoothItem(loadItem("5359699"));
    const minimal: {
      id: number;
      name: string;
      description: string;
      category: { id: number; name: string };
      tags: { name: string }[];
      variations: { name: string | null }[];
    } = raw;
    expect(minimal.variations.length).toBeGreaterThan(0);
  });

  it.each([
    ["missing name", (json: Record<string, unknown>) => ({ ...json, name: undefined })],
    ["string id", (json: Record<string, unknown>) => ({ ...json, id: "6106863" })],
    ["variations not an array", (json: Record<string, unknown>) => ({ ...json, variations: {} })],
    ["tag without name", (json: Record<string, unknown>) => ({ ...json, tags: [{ url: "x" }] })],
    ["not an object", () => ["unexpected"]],
  ])("throws BOOTH_CHANGED on schema drift (%s)", async (_label, mutate) => {
    const { reader } = itemReader("6106863", mutate);
    const error = await expectBoothError(getItem(reader, "6106863"), "BOOTH_CHANGED");
    expect(error.sourceUrl).toBe("https://booth.pm/ja/items/6106863.json");
  });

  it("does not echo field values in BOOTH_CHANGED messages", async () => {
    const { reader } = itemReader("6106863", (json) => ({ ...json, name: { secret: "do-not-echo" } }));
    const error = await expectBoothError(getItem(reader, "6106863"), "BOOTH_CHANGED");
    expect(error.message).toContain("name");
    expect(error.message).not.toContain("do-not-echo");
  });

  it("throws BOOTH_CHANGED when BOOTH returns a different item", async () => {
    const { reader } = itemReader("6106863");
    await expectBoothError(getItem(reader, "3681787"), "BOOTH_CHANGED");
  });

  it("maps 404 to NOT_FOUND with the item id", async () => {
    const { reader } = fakeReader((url) => Promise.reject(new BoothError("NOT_FOUND", "404", url)));
    const error = await expectBoothError(getItem(reader, "123"), "NOT_FOUND");
    expect(error.message).toContain("123");
    expect(error.sourceUrl).toBe("https://booth.pm/ja/items/123.json");
  });

  it("passes other reader errors through unchanged", async () => {
    const rateLimited = new BoothError("RATE_LIMITED", "slow down");
    const { reader } = fakeReader(() => Promise.reject(rateLimited));
    await expect(getItem(reader, "123")).rejects.toBe(rateLimited);
  });

  it("rejects invalid ids before making a request", async () => {
    const { reader, calls } = itemReader("6106863");
    await expectBoothError(getItem(reader, "https://example.com/items/1"), "INVALID_INPUT");
    await expectBoothError(getItem(reader, "../../x"), "INVALID_INPUT");
    expect(calls).toEqual([]);
  });

  it("builds the JSON URL from a validated id", () => {
    expect(itemJsonUrl("42")).toBe("https://booth.pm/ja/items/42.json");
    expect(() => itemJsonUrl("42/../../x")).toThrow(BoothError);
  });
});

describe("suggestTags", () => {
  it("URL-encodes the term and returns the fixture tags", async () => {
    const { reader, calls } = fakeReader(() => Promise.resolve(loadJson("autocomplete-tag.json")));
    const tags = await suggestTags(reader, "  しなの ");
    expect(calls).toEqual(["https://booth.pm/autocomplete/tag.json?term=%E3%81%97%E3%81%AA%E3%81%AE"]);
    expect(tags).toEqual(loadJson("autocomplete-tag.json"));
  });

  it("encodes reserved characters", async () => {
    const { reader, calls } = fakeReader(() => Promise.resolve([]));
    await suggestTags(reader, "a&b=c #d");
    expect(calls).toEqual(["https://booth.pm/autocomplete/tag.json?term=a%26b%3Dc%20%23d"]);
  });

  it("dedupes, drops blanks and caps at 20", async () => {
    const many = ["x", "x", " ", ...Array.from({ length: 30 }, (_, index) => `tag${index}`)];
    const { reader } = fakeReader(() => Promise.resolve(many));
    const tags = await suggestTags(reader, "t");
    expect(tags).toHaveLength(20);
    expect(tags[0]).toBe("x");
    expect(new Set(tags).size).toBe(20);
  });

  it("rejects empty or overlong terms without a request", async () => {
    const { reader, calls } = fakeReader(() => Promise.resolve([]));
    await expectBoothError(suggestTags(reader, ""), "INVALID_INPUT");
    await expectBoothError(suggestTags(reader, " \t\n"), "INVALID_INPUT");
    await expectBoothError(suggestTags(reader, "あ".repeat(101)), "INVALID_INPUT");
    expect(calls).toEqual([]);
  });

  it("throws BOOTH_CHANGED when the response is not a string array", async () => {
    const { reader } = fakeReader(() => Promise.resolve({ tags: ["x"] }));
    await expectBoothError(suggestTags(reader, "x"), "BOOTH_CHANGED");
  });
});

describe("buildSearchUrl", () => {
  const q = "しなの 衣装";
  const encodedQ = "%E3%81%97%E3%81%AA%E3%81%AE%20%E8%A1%A3%E8%A3%85";

  it("uses /ja/search/{q} with %20 like BOOTH's own links", () => {
    expect(buildSearchUrl({ query: q })).toBe(`https://booth.pm/ja/search/${encodedQ}`);
    expect(buildSearchUrl({ query: `  しなの   衣装 ` })).toBe(`https://booth.pm/ja/search/${encodedQ}`);
  });

  it("adds tags[] in BOOTH's encoding", () => {
    expect(buildSearchUrl({ query: q, tags: ["しなの対応"] })).toBe(
      `https://booth.pm/ja/search/${encodedQ}?tags%5B%5D=%E3%81%97%E3%81%AA%E3%81%AE%E5%AF%BE%E5%BF%9C`,
    );
  });

  it("uses /ja/items for tag-only searches", () => {
    expect(buildSearchUrl({ tags: ["VRChat", " VRChat ", "Unity"] })).toBe(
      "https://booth.pm/ja/items?tags%5B%5D=VRChat&tags%5B%5D=Unity",
    );
  });

  it("filters categories by name via /ja/browse/{name}?q=", () => {
    expect(buildSearchUrl({ query: "しなの", category: "3D衣装" })).toBe(
      "https://booth.pm/ja/browse/3D%E8%A1%A3%E8%A3%85?q=%E3%81%97%E3%81%AA%E3%81%AE",
    );
    expect(buildSearchUrl({ category: 209 })).toBe("https://booth.pm/ja/browse/3D%E8%A1%A3%E8%A3%85");
  });

  it("adds sort, only_free, adult and page", () => {
    const url = new URL(buildSearchUrl({ query: "x", sort: "new", only_free: true, adult: true, page: 3 }));
    expect(url.pathname).toBe("/ja/search/x");
    expect(url.searchParams.get("sort")).toBe("new");
    expect(url.searchParams.get("max_price")).toBe("0");
    expect(url.searchParams.get("adult")).toBe("include");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("omits defaults", () => {
    expect(buildSearchUrl({ query: "x", page: 1, only_free: false, adult: false })).toBe("https://booth.pm/ja/search/x");
  });

  it("keeps path-significant characters inside the query segment", () => {
    const url = new URL(buildSearchUrl({ query: "a/b?c#d" }));
    expect(url.pathname).toBe("/ja/search/a%2Fb%3Fc%23d");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it.each([
    [{}],
    [{ query: "   " }],
    [{ query: "x", page: 6 }],
    [{ query: "x", page: 0 }],
    [{ query: "x", page: 1.5 }],
    [{ query: "x", sort: "new&x=1" }],
    [{ query: ".." }],
    [{ category: ".." }],
    [{ category: "a/b" }],
    [{ category: 999 }],
    [{ category: "あ".repeat(51) }],
    [{ query: "あ".repeat(201) }],
    [{ tags: Array.from({ length: 11 }, (_, index) => `t${index}`) }],
    [{ tags: ["あ".repeat(101)] }],
  ])("rejects invalid params %j", (params) => {
    try {
      buildSearchUrl(params);
    } catch (error) {
      expect((error as BoothError).code).toBe("INVALID_INPUT");
      return;
    }
    throw new Error("expected INVALID_INPUT");
  });
});
