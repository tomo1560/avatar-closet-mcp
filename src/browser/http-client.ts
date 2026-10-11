import { access } from "node:fs/promises";
import { load } from "cheerio";
import { request, type APIRequestContext, type APIResponse } from "playwright-core";
import { BoothError, asBoothError } from "../errors.js";
import { getSessionFile } from "../profile.js";
import { persistBoothSession } from "../session-state.js";
import type { BoothReader } from "./reader.js";

const MANAGE_ORIGIN = "https://manage.booth.pm";
const MIN_REQUEST_INTERVAL_MS = 1_000;
const MAX_REDIRECTS = 5;

export interface BoothHttpClientOptions {
  origin?: string;
  sessionFile?: string;
  minimumIntervalMs?: number;
}

export class BoothHttpClient implements BoothReader {
  private context: APIRequestContext | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly origin: string;
  private readonly sessionFile: string;
  private readonly minimumIntervalMs: number;

  constructor(options: BoothHttpClientOptions = {}) {
    this.origin = options.origin ?? MANAGE_ORIGIN;
    this.sessionFile = options.sessionFile ?? getSessionFile();
    this.minimumIntervalMs = options.minimumIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  }

  read<T>(path: string, parser: (html: string, finalUrl: string) => T): Promise<{ data: T; url: string }> {
    return this.enqueue(async () => {
      const initialUrl = new URL(path, this.origin).toString();
      const response = await this.performGet(initialUrl, { Accept: "text/html,application/xhtml+xml" });
      return { data: parser(response.body, response.url), url: response.url };
    }, new URL(path, this.origin).toString());
  }

  readJson<T>(
    path: string,
    parser: (json: unknown, finalUrl: string) => T,
    options: { origin?: string; csrfFrom?: string } = {},
  ): Promise<{ data: T; url: string }> {
    const apiOrigin = options.origin ?? this.origin;
    const initialUrl = new URL(path, apiOrigin).toString();
    return this.enqueue(async () => {
      let csrfToken: string | undefined;
      let referer = `${this.origin}/`;
      if (options.csrfFrom) {
        referer = new URL(options.csrfFrom, this.origin).toString();
        const csrfPage = await this.performGet(referer, { Accept: "text/html" });
        const $ = load(csrfPage.body);
        csrfToken = $("meta[name='csrf-token']").attr("content");
        if (!csrfToken) throw new BoothError("BOOTH_CHANGED", "BOOTH CSRF 토큰을 찾을 수 없습니다.", referer);
      }
      const response = await this.performGet(initialUrl, {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: this.origin,
        Referer: referer,
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      });
      let json: unknown;
      try {
        json = JSON.parse(response.body);
      } catch {
        throw new BoothError("BOOTH_CHANGED", "BOOTH JSON 응답을 해석할 수 없습니다.", response.url);
      }
      return { data: parser(json, response.url), url: response.url };
    }, initialUrl);
  }

  async close(): Promise<void> {
    await this.context?.dispose();
    this.context = undefined;
  }

  private enqueue<T>(task: () => Promise<T>, sourceUrl: string): Promise<T> {
    const queued = this.queue.then(task).catch((error: unknown) => {
      throw asBoothError(error, sourceUrl);
    });
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  private async performGet(initialUrl: string, headers: Record<string, string>): Promise<{ body: string; url: string }> {
    const expectedHost = new URL(initialUrl).hostname;
    const context = await this.getContext();
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await this.waitForRateLimit();
      const response = await context.get(currentUrl, {
        failOnStatusCode: false,
        headers,
        maxRedirects: 0,
        timeout: 30_000,
      });
      this.lastRequestAt = Date.now();
      const status = response.status();
      if (status >= 300 && status < 400) {
        const nextUrl = resolveRedirect(response, currentUrl);
        await response.dispose();
        if (!nextUrl || new URL(nextUrl).hostname !== expectedHost) {
          throw new BoothError(
            "AUTH_REQUIRED",
            "BOOTH 판매자 세션이 만료되었습니다. `booth_login` 도구를 호출하거나 `npx booth-library-mcp login`을 실행해 주세요.",
            initialUrl,
          );
        }
        currentUrl = nextUrl;
        continue;
      }
      if (status === 404) throw new BoothError("NOT_FOUND", "요청한 BOOTH 데이터를 찾을 수 없습니다.", currentUrl);
      if (status === 429) throw new BoothError("RATE_LIMITED", "BOOTH가 요청을 제한했습니다.", currentUrl);
      if (status >= 400) throw new BoothError("NETWORK_ERROR", `BOOTH가 HTTP ${status}를 반환했습니다.`, currentUrl);
      const finalUrl = response.url();
      if (new URL(finalUrl).hostname !== expectedHost) {
        throw new BoothError(
          "AUTH_REQUIRED",
          "BOOTH 판매자 세션이 만료되었습니다. `booth_login` 도구를 호출하거나 `npx booth-library-mcp login`을 실행해 주세요.",
          initialUrl,
        );
      }
      const body = await response.text();
      await persistBoothSession(context, this.sessionFile);
      return { body, url: finalUrl };
    }
    throw new BoothError("NETWORK_ERROR", "BOOTH 리디렉션 횟수가 너무 많습니다.", initialUrl);
  }

  private async getContext(): Promise<APIRequestContext> {
    if (this.context) return this.context;
    try {
      await access(this.sessionFile);
    } catch {
      throw new BoothError(
        "AUTH_REQUIRED",
        "저장된 BOOTH 세션이 없습니다. `booth_login` 도구를 호출하거나 `npx booth-library-mcp login`을 실행해 주세요.",
        `${this.origin}/`,
      );
    }
    this.context = await request.newContext({
      storageState: this.sessionFile,
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9,ja;q=0.8" },
    });
    return this.context;
  }

  private async waitForRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minimumIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minimumIntervalMs - elapsed));
    }
  }
}

function resolveRedirect(response: APIResponse, currentUrl: string): string | undefined {
  const location = response.headers().location;
  return location ? new URL(location, currentUrl).toString() : undefined;
}
