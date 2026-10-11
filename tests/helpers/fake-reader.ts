import { readFileSync } from "node:fs";
import type { BoothReader } from "../../src/browser/reader.js";
import { BoothError } from "../../src/errors.js";

export type FakeRoute = { html: string; finalUrl?: string } | { json: unknown; finalUrl?: string } | BoothError;

/**
 * BoothReader that serves fixed responses per absolute URL and records every request.
 * Parsers run exactly like in BoothHttpClient (with the final URL). Unknown URLs fail the test.
 */
export class RoutedFakeReader implements BoothReader {
  readonly calls: string[] = [];
  closed = 0;
  private readonly routes: Map<string, FakeRoute>;

  constructor(routes: Record<string, FakeRoute> = {}) {
    this.routes = new Map(Object.entries(routes));
  }

  set(url: string, route: FakeRoute): this {
    this.routes.set(url, route);
    return this;
  }

  read<T>(path: string, parser: (html: string, finalUrl: string) => T): Promise<{ data: T; url: string }> {
    return this.respond(path, (route, url) => {
      if (!("html" in route)) throw new Error(`fake route ${path} is not HTML`);
      return parser(route.html, url);
    });
  }

  readJson<T>(path: string, parser: (json: unknown, finalUrl: string) => T): Promise<{ data: T; url: string }> {
    return this.respond(path, (route, url) => {
      if (!("json" in route)) throw new Error(`fake route ${path} is not JSON`);
      return parser(route.json, url);
    });
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  count(prefix: string): number {
    return this.calls.filter((url) => url.startsWith(prefix)).length;
  }

  private respond<T>(path: string, run: (route: Exclude<FakeRoute, BoothError>, url: string) => T): Promise<{ data: T; url: string }> {
    this.calls.push(path);
    const route = this.routes.get(path);
    if (route === undefined) return Promise.reject(new Error(`unexpected request: ${path}`));
    if (route instanceof BoothError) return Promise.reject(route);
    const url = route.finalUrl ?? path;
    try {
      return Promise.resolve({ data: run(route, url), url });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export function itemJsonUrlOf(id: string | number): string {
  return `https://booth.pm/ja/items/${id}.json`;
}

/** Real public `items/{id}.json` capture from tests/fixtures/public/items. */
export function publicItem(id: string | number): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/public/items/${id}.json`, import.meta.url), "utf8")) as unknown;
}

/** Routes `items/{id}.json` for the given public fixtures. */
export function itemRoutes(ids: readonly (string | number)[]): Record<string, FakeRoute> {
  return Object.fromEntries(ids.map((id) => [itemJsonUrlOf(id), { json: publicItem(id) }]));
}
