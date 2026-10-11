import { BoothError } from "../errors.js";
import type { BoothResult } from "../types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Shared envelope for every tool result. */
export function wrap<T>(
  data: T,
  sourceUrl: string,
  extra: { page?: number | undefined; nextPage?: number | undefined; redactions?: string[] | undefined } = {},
): BoothResult<T> {
  return {
    data,
    meta: {
      fetchedAt: new Date().toISOString(),
      sourceUrl,
      redactions: extra.redactions ?? [],
      ...(extra.page !== undefined ? { page: extra.page } : {}),
      ...(extra.nextPage !== undefined ? { nextPage: extra.nextPage } : {}),
    },
  };
}

/** Helpers kept for the paged buyer tools (library, gifts, orders). */
export function normalizePage(page: number | undefined): number {
  return page && Number.isInteger(page) && page > 0 ? page : 1;
}

export function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export function assertNumericId(id: string, label: string): void {
  if (!/^\d{1,20}$/u.test(id)) throw new BoothError("INVALID_INPUT", `${label} ID は数字で指定してください。`);
}

export function invalidInput(message: string): BoothError {
  return new BoothError("INVALID_INPUT", message);
}

/** Absolute accounts.booth.pm URL for a paged list (`?page=N` only from page 2). */
export function pagedUrl(base: string, page: number): string {
  return page > 1 ? `${base}?page=${page}` : base;
}
