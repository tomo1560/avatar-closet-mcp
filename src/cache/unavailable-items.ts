import { z } from "zod";
import { readTextFileCapped, writeFileAtomic } from "../atomic-file.js";
import { toItemId } from "../booth/item-id.js";
import { DEFAULT_ITEM_CACHE_TTL_MS } from "./item-cache.js";

/** A larger file is ignored (treated as empty) rather than read into memory. */
export const MAX_UNAVAILABLE_FILE_BYTES = 2 * 1024 * 1024;

const fileSchema = z.object({
  version: z.literal(1),
  items: z.record(z.string().regex(/^[1-9]\d{0,11}$/), z.iso.datetime({ offset: true })),
});

export interface UnavailableItemsOptions {
  /** JSON file, e.g. `{cacheDir}/unavailable-items.json`. */
  file: string;
  ttlMs?: number | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Negative cache for items whose `items/{id}.json` returned 404 (deleted or private). Bulk paths
 * (library filters, sync) skip them until the TTL expires so that they do not consume the per-call
 * fetch budget on every call. Best effort: an unreadable or oversized file counts as empty.
 */
export class UnavailableItems {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(options: UnavailableItemsOptions) {
    this.file = options.file;
    this.ttlMs = options.ttlMs ?? DEFAULT_ITEM_CACHE_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Ids marked unavailable within the TTL. */
  async freshIds(): Promise<Set<string>> {
    const entries = await this.read();
    const nowMs = this.now().getTime();
    return new Set(
      Object.entries(entries)
        .filter(([, markedAt]) => isWithin(nowMs - Date.parse(markedAt), this.ttlMs))
        .map(([id]) => id),
    );
  }

  /** Marks ids as unavailable now. Expired entries are dropped. Returns `false` when the file could not be written. */
  async mark(ids: readonly (string | number)[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const nowMs = this.now().getTime();
    const markedAt = this.now().toISOString().replace(/\.\d{3}Z$/, "Z");
    const kept = Object.entries(await this.read()).filter(([, at]) => isWithin(nowMs - Date.parse(at), this.ttlMs));
    const items = Object.fromEntries([...kept, ...ids.map((id) => [toItemId(id), markedAt] as const)]);
    try {
      await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, items })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const { text } = await readTextFileCapped(this.file, MAX_UNAVAILABLE_FILE_BYTES);
      const parsed = fileSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.items : {};
    } catch {
      return {};
    }
  }
}

function isWithin(ageMs: number, ttlMs: number): boolean {
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs;
}
