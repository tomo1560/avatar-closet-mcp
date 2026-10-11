import { request } from "playwright-core";
import { BoothError, firstLineOf } from "../errors.js";
import type { StorageState } from "../session-state.js";

export const REQUEST_TIMEOUT_MS = 30_000;
const ACCEPT_LANGUAGE = "ja,en-US;q=0.8,en;q=0.6";

export interface TransportResponse {
  readonly status: number;
  /** Header names are lower-case. */
  readonly headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * One cookie jar plus a single-hop GET. Implementations never follow redirects and never send
 * anything but GET; URL policy, retries, and rate limiting live in BoothHttpClient.
 */
export interface BoothTransport {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<TransportResponse>;
  storageState(): Promise<StorageState>;
  close(): Promise<void>;
}

export type TransportFactory = (state: StorageState) => Promise<BoothTransport>;

/** Browserless transport backed by a Playwright APIRequestContext (TLS fingerprint accepted by BOOTH). */
export const createPlaywrightTransport: TransportFactory = async (state) => {
  const context = await request.newContext({
    storageState: state,
    extraHTTPHeaders: { "Accept-Language": ACCEPT_LANGUAGE },
  });
  return {
    async get(url, headers) {
      try {
        const response = await context.get(url, {
          failOnStatusCode: false,
          headers: { ...headers },
          maxRedirects: 0,
          timeout: REQUEST_TIMEOUT_MS,
        });
        return {
          status: response.status(),
          headers: response.headers(),
          text: () => response.text(),
          dispose: () => response.dispose(),
        };
      } catch (error) {
        throw new BoothError("NETWORK_ERROR", `BOOTH への接続に失敗しました: ${firstLineOf(error)}`);
      }
    },
    storageState: () => context.storageState(),
    close: () => context.dispose(),
  };
};
