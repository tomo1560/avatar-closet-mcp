import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_UNAVAILABLE_FILE_BYTES, UnavailableItems } from "../src/cache/unavailable-items.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-unavailable-"));
  tempPaths.push(dir);
  return join(dir, "cache", "unavailable-items.json");
}

describe("UnavailableItems", () => {
  it("remembers marked ids until the TTL expires", async () => {
    const file = await tempFile();
    let now = new Date("2026-10-12T00:00:00Z");
    const store = new UnavailableItems({ file, ttlMs: 7 * DAY_MS, now: () => now });
    await expect(store.mark(["123", 456])).resolves.toBe(true);
    expect([...(await store.freshIds())].sort()).toEqual(["123", "456"]);
    now = new Date(now.getTime() + 8 * DAY_MS);
    expect(await store.freshIds()).toEqual(new Set());
  });

  it("drops expired entries when marking new ones", async () => {
    const file = await tempFile();
    let now = new Date("2026-10-12T00:00:00Z");
    const store = new UnavailableItems({ file, ttlMs: DAY_MS, now: () => now });
    await store.mark(["1"]);
    now = new Date(now.getTime() + 2 * DAY_MS);
    await store.mark(["2"]);
    const saved = JSON.parse(await readFile(file, "utf8")) as { items: Record<string, string> };
    expect(Object.keys(saved.items)).toEqual(["2"]);
  });

  it("treats a corrupt file as empty and rejects invalid ids", async () => {
    const file = await tempFile();
    const store = new UnavailableItems({ file });
    await store.mark(["9"]);
    await writeFile(file, "{ broken", "utf8");
    expect(await store.freshIds()).toEqual(new Set());
    await expect(store.mark(["../x"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("ignores a file larger than the read cap (best effort: treated as empty)", async () => {
    const file = await tempFile();
    const now = new Date("2026-10-12T00:00:00Z");
    const store = new UnavailableItems({ file, now: () => now });
    await store.mark(["9"]);
    const items = Object.fromEntries(Array.from({ length: 70_000 }, (_, index) => [String(index + 1), "2026-10-12T00:00:00Z"]));
    const huge = JSON.stringify({ version: 1, items });
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_UNAVAILABLE_FILE_BYTES);
    await writeFile(file, huge, "utf8");
    expect(await store.freshIds()).toEqual(new Set());
  });
});
