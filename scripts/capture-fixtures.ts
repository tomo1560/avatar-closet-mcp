/**
 * Capture raw logged-in BOOTH buyer pages for building parser fixtures (PLAN.md Phase 0).
 *
 * !!! PERSONAL DATA WARNING !!!
 * The saved HTML contains YOUR personal account data (name, purchases, order history,
 * gifts, wish list, and possibly address or payment details).
 * - Output goes to tests/fixtures/private/, which is gitignored. Never commit it or share it.
 * - Before anything from it is copied into tests/fixtures/, replace every personal value
 *   (names, ids, addresses, emails, order numbers, prices, dates, thumbnails) with fictional data.
 *   AGENTS.md: "Test fixtures must contain fictional data only."
 * - Delete tests/fixtures/private/ once the anonymized fixtures exist.
 *
 * Usage (after signing in with `bun src/cli.ts login`):
 *   bun scripts/capture-fixtures.ts
 *
 * Behavior:
 * - Reuses the saved session file (src/profile.ts getSessionFile; BOOTH_MCP_SESSION_FILE overrides it).
 * - GET only, strictly sequential, at least 1.5 s between requests, about 6 requests in total.
 * - Redirects are never followed. A redirect on an account page means the session is invalid and aborts the run.
 * - For one downloadable, only the redirect target host is recorded; the signed URL and the file body are never
 *   stored or printed.
 * - Refreshed session cookies are written back to the session file, like the MCP HTTP client does.
 *
 * This is a developer tool. It must not be imported from src/.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request, type APIRequestContext, type APIResponse } from "playwright-core";
import { z } from "zod";
import { isAllowedBoothRequest, isBoothHost } from "../src/browser/read-only-guard.js";
import { getSessionFile } from "../src/profile.js";
import { persistBoothSession } from "../src/session-state.js";

const ACCOUNTS_ORIGIN = "https://accounts.booth.pm";
const BOOTH_ORIGIN = "https://booth.pm";
const MIN_REQUEST_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 30_000;
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(ROOT_DIR, "tests", "fixtures", "private");
const ORDER_ID_PATTERN = /(?:https:\/\/accounts\.booth\.pm)?\/orders\/(\d+)/u;
const DOWNLOADABLE_ID_PATTERN = /booth\.pm\/downloadables\/(\d+)/u;

const storageStateSchema = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
    }),
  ),
  origins: z.array(
    z.object({
      origin: z.string(),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
});

type StorageState = z.infer<typeof storageStateSchema>;

interface CaptureRecord {
  name: string;
  path: string;
  status: number;
  contentType?: string;
  bytes?: number;
  savedTo?: string;
  redirectHost?: string;
  note?: string;
}

class SessionRedirectError extends Error {}

let lastRequestAt = 0;

async function main(): Promise<void> {
  const sessionFile = getSessionFile();
  const storageState = await loadStorageState(sessionFile);
  await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });

  const context = await request.newContext({
    storageState,
    extraHTTPHeaders: { "Accept-Language": "ja,en-US;q=0.8,en;q=0.6" },
  });
  const records: CaptureRecord[] = [];
  try {
    await captureAll(context, records);
  } catch (error) {
    if (!(error instanceof SessionRedirectError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await persistBoothSession(context, sessionFile).catch((error: unknown) => {
      process.stderr.write(`Could not write the refreshed session back: ${errorMessage(error)}\n`);
    });
    await context.dispose();
    await writeSummary(records);
  }
}

async function captureAll(context: APIRequestContext, records: CaptureRecord[]): Promise<void> {
  const library = await capturePage(context, records, "library", `${ACCOUNTS_ORIGIN}/library`);
  await capturePage(context, records, "library-gifts", `${ACCOUNTS_ORIGIN}/library/gifts`);
  const orders = await capturePage(context, records, "orders", `${ACCOUNTS_ORIGIN}/orders`);

  const orderId = orders ? ORDER_ID_PATTERN.exec(orders)?.[1] : undefined;
  let order: string | undefined;
  if (orderId) {
    order = await capturePage(context, records, "order-detail", `${ACCOUNTS_ORIGIN}/orders/${orderId}`);
  } else {
    records.push({ name: "order-detail", path: "/orders/{id}", status: 0, note: "skipped: no order link found on /orders" });
  }

  await capturePage(context, records, "wish-lists", `${ACCOUNTS_ORIGIN}/wish_lists`);

  const downloadableId = DOWNLOADABLE_ID_PATTERN.exec(order ?? "")?.[1] ?? DOWNLOADABLE_ID_PATTERN.exec(library ?? "")?.[1];
  if (downloadableId) {
    records.push(await probeDownloadable(context, downloadableId));
  } else {
    records.push({
      name: "downloadable",
      path: "/downloadables/{id}",
      status: 0,
      note: "skipped: no downloadable link found on the order detail or library page",
    });
  }
}

/** Fetches an account page without following redirects and saves its HTML. Returns the body when saved. */
async function capturePage(
  context: APIRequestContext,
  records: CaptureRecord[],
  name: string,
  url: string,
): Promise<string | undefined> {
  const response = await boothGet(context, url);
  const status = response.status();
  const path = new URL(url).pathname;
  const contentType = response.headers()["content-type"];
  try {
    if (status >= 300 && status < 400) {
      const redirectHost = redirectHostOf(response, url);
      records.push({ name, path, status, ...(redirectHost ? { redirectHost } : {}), note: "aborted: redirected" });
      throw new SessionRedirectError(
        `${path} redirected to ${redirectHost ?? "an unknown location"}. The saved session is missing or expired. ` +
          "Sign in again with `bun src/cli.ts login`, then rerun this script.",
      );
    }
    if (status !== 200) {
      records.push({ name, path, status, ...(contentType ? { contentType } : {}), note: "not saved: non-200 response" });
      return undefined;
    }
    const body = await response.text();
    const savedTo = resolve(OUTPUT_DIR, `${name}.html`);
    await writeFile(savedTo, body, { encoding: "utf8", mode: 0o600 });
    records.push({
      name,
      path,
      status,
      ...(contentType ? { contentType } : {}),
      bytes: Buffer.byteLength(body),
      savedTo: relative(ROOT_DIR, savedTo),
    });
    return body;
  } finally {
    await response.dispose();
  }
}

/** Requests one downloadable without following the redirect and keeps only the target host. */
async function probeDownloadable(context: APIRequestContext, downloadableId: string): Promise<CaptureRecord> {
  const url = `${BOOTH_ORIGIN}/downloadables/${downloadableId}`;
  const response = await boothGet(context, url);
  try {
    const status = response.status();
    const contentType = response.headers()["content-type"];
    const redirectHost = status >= 300 && status < 400 ? redirectHostOf(response, url) : undefined;
    return {
      name: "downloadable",
      path: "/downloadables/{id}",
      status,
      ...(contentType ? { contentType } : {}),
      ...(redirectHost ? { redirectHost } : {}),
      note: "body not saved; signed URL not recorded",
    };
  } finally {
    await response.dispose();
  }
}

async function boothGet(context: APIRequestContext, url: string): Promise<APIResponse> {
  const { hostname } = new URL(url);
  if (!isBoothHost(hostname) || !isAllowedBoothRequest("GET", url)) {
    throw new Error(`Refusing to request a non-BOOTH URL: ${hostname}`);
  }
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  try {
    return await context.get(url, {
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
  } finally {
    lastRequestAt = Date.now();
  }
}

function redirectHostOf(response: APIResponse, currentUrl: string): string | undefined {
  const location = response.headers().location;
  if (!location) return undefined;
  try {
    return new URL(location, currentUrl).host;
  } catch {
    return "(unparseable Location header)";
  }
}

async function loadStorageState(sessionFile: string): Promise<StorageState> {
  try {
    await access(sessionFile);
  } catch {
    throw new Error(`No saved BOOTH session at ${sessionFile}. Sign in first with \`bun src/cli.ts login\`.`);
  }
  const parsed = storageStateSchema.safeParse(JSON.parse(await readFile(sessionFile, "utf8")));
  if (!parsed.success) throw new Error(`The session file at ${sessionFile} is not a Playwright storage state.`);
  return withAdultCookie(parsed.data);
}

/** BOOTH lists age-restricted items only when the `adult=t` cookie is present (PLAN.md §2.1). */
function withAdultCookie(state: StorageState): StorageState {
  if (state.cookies.some((cookie) => cookie.name === "adult")) return state;
  return {
    ...state,
    cookies: [
      ...state.cookies,
      { name: "adult", value: "t", domain: ".booth.pm", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
    ],
  };
}

async function writeSummary(records: CaptureRecord[]): Promise<void> {
  const summary = { capturedAt: new Date().toISOString(), requests: records.filter((record) => record.status > 0).length, records };
  await writeFile(resolve(OUTPUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write("name\tstatus\tbytes\tredirectHost\tnote\n");
  for (const record of records) {
    process.stdout.write(
      `${record.name}\t${record.status}\t${record.bytes ?? "-"}\t${record.redirectHost ?? "-"}\t${record.note ?? record.savedTo ?? ""}\n`,
    );
  }
  process.stdout.write(
    `\nSaved to ${relative(ROOT_DIR, OUTPUT_DIR)}/ (gitignored). It contains personal data: anonymize before copying into tests/fixtures/.\n`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`capture-fixtures failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
