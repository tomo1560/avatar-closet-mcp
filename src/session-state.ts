import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { isBoothHost } from "./browser/read-only-guard.js";
import { BoothError } from "./errors.js";
import { getSessionFile } from "./profile.js";

const cookieSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});

const originSchema = z.looseObject({
  origin: z.string(),
  localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
});

const storageStateSchema = z.object({
  cookies: z.array(cookieSchema),
  origins: z.array(originSchema),
});

/** Playwright-compatible storage state (the shape of session.json). */
export type StorageState = z.infer<typeof storageStateSchema>;
export type StorageCookie = StorageState["cookies"][number];

export interface StorageStateSource {
  storageState(): Promise<StorageState>;
}

export interface LoadedSession {
  /** State to hand to the request context. Always carries `adult=t`. */
  readonly state: StorageState;
  /** True when a saved session file exists (the user has signed in at least once). */
  readonly hasSession: boolean;
}

/** BOOTH hides age-restricted items behind an age wall unless this cookie is present (PLAN §2.1). */
export const ADULT_COOKIE: StorageCookie = Object.freeze({
  name: "adult",
  value: "t",
  domain: ".booth.pm",
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: true,
  sameSite: "Lax",
});

const EMPTY_STATE: StorageState = { cookies: [], origins: [] };

export function withAdultCookie(state: StorageState): StorageState {
  const others = state.cookies.filter((cookie) => !(cookie.name === ADULT_COOKIE.name && isBoothCookie(cookie)));
  return { ...state, cookies: [...others, { ...ADULT_COOKIE }] };
}

/** Drops every cookie and localStorage origin that does not belong to booth.pm (e.g. pixiv.net). */
export function filterToBooth(state: StorageState): StorageState {
  return {
    cookies: state.cookies.filter(isBoothCookie),
    origins: state.origins.filter((origin) => {
      try {
        return isBoothHost(new URL(origin.origin).hostname);
      } catch {
        return false;
      }
    }),
  };
}

/**
 * Writes the BOOTH-only part of the context's storage state (plus `adult=t`) to session.json.
 * The file is created 0600 inside a 0700 directory. On Windows, chmod only toggles the read-only
 * flag and does not set NTFS ACLs; protection there relies on the per-user %LOCALAPPDATA% ACL.
 */
export async function persistBoothSession(context: StorageStateSource, sessionFile = getSessionFile()): Promise<void> {
  const state = withAdultCookie(filterToBooth(await context.storageState()));
  await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
  await writeFile(sessionFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(sessionFile, 0o600).catch(() => undefined);
}

/** Reads session.json. A missing file yields an anonymous state; a corrupt one is AUTH_REQUIRED. */
export async function loadSessionState(sessionFile = getSessionFile()): Promise<LoadedSession> {
  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { state: withAdultCookie(EMPTY_STATE), hasSession: false };
    throw error;
  }
  const parsed = storageStateSchema.safeParse(parseJsonOrUndefined(raw));
  if (!parsed.success) {
    throw new BoothError(
      "AUTH_REQUIRED",
      "保存された BOOTH セッションを読み取れません。`booth_logout` の後に `booth_login` で再ログインしてください。",
    );
  }
  return { state: withAdultCookie(filterToBooth(parsed.data)), hasSession: true };
}

export async function sessionFileExists(sessionFile = getSessionFile()): Promise<boolean> {
  try {
    return (await stat(sessionFile)).isFile();
  } catch {
    return false;
  }
}

/** Deletes session.json. Returns false when there was nothing to delete. */
export async function deleteSessionFile(sessionFile = getSessionFile()): Promise<boolean> {
  const existed = await sessionFileExists(sessionFile);
  await rm(sessionFile, { force: true });
  return existed;
}

function isBoothCookie(cookie: StorageCookie): boolean {
  return isBoothHost(cookie.domain.replace(/^\./u, ""));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseJsonOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
