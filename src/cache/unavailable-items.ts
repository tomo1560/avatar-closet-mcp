import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { toItemId } from "../booth/item-id.js";
import { DEFAULT_ITEM_CACHE_TTL_MS } from "./item-cache.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

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
 * fetch budget on every call. Best effort: an unreadable file counts as empty.
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
      await this.writeAtomic(`${JSON.stringify({ version: 1, items })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return parsed.success ? parsed.data.items : {};
    } catch {
      return {};
    }
  }

  private async writeAtomic(content: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: DIR_MODE });
    const tmpPath = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmpPath, content, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      await rename(tmpPath, this.file);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }
}

function isWithin(ageMs: number, ttlMs: number): boolean {
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs;
}
