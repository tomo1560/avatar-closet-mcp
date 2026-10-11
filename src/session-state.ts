import type { Stats } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { z } from "zod";
import { isMissingFileError, readTextFileCapped, writeFileAtomic } from "./atomic-file.js";
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

/** Identity of one version of session.json. Atomic writes replace the file, so any rewrite changes it. */
export interface SessionFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export interface LoadedSession {
  /** State to hand to the request context. Always carries `adult=t`. */
  readonly state: StorageState;
  /** True when a saved session file exists (the user has signed in at least once). */
  readonly hasSession: boolean;
  /** The file version that was read (undefined without a session file). */
  readonly fingerprint: SessionFingerprint | undefined;
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
 * Writes the BOOTH-only part of the context's storage state (plus `adult=t`) to session.json,
 * atomically (temporary file + rename), as 0600 inside a 0700 directory. On Windows, chmod only toggles
 * the read-only flag and does not set NTFS ACLs; protection there relies on the per-user %LOCALAPPDATA% ACL.
 */
export async function persistBoothSession(context: StorageStateSource, sessionFile = getSessionFile()): Promise<void> {
  const state = withAdultCookie(filterToBooth(await context.storageState()));
  await writeFileAtomic(sessionFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** Reads session.json. A missing file yields an anonymous state; a corrupt one is AUTH_REQUIRED. */
export async function loadSessionState(sessionFile = getSessionFile()): Promise<LoadedSession> {
  let raw: string;
  let fingerprint: SessionFingerprint;
  try {
    // Stats come from the open handle, so the fingerprint belongs to exactly the bytes parsed below.
    const file = await readTextFileCapped(sessionFile);
    raw = file.text;
    fingerprint = fingerprintOf(file.stats);
  } catch (error) {
    if (isMissingFileError(error)) return { state: withAdultCookie(EMPTY_STATE), hasSession: false, fingerprint: undefined };
    throw error;
  }
  const parsed = storageStateSchema.safeParse(parseJsonOrUndefined(raw));
  if (!parsed.success) {
    throw new BoothError(
      "AUTH_REQUIRED",
      "保存された BOOTH セッションを読み取れません。`booth_logout` の後に `booth_login` で再ログインしてください。",
    );
  }
  return { state: withAdultCookie(filterToBooth(parsed.data)), hasSession: true, fingerprint };
}

/** Fingerprint of the current session.json, or undefined when it does not exist. */
export async function readSessionFingerprint(sessionFile = getSessionFile()): Promise<SessionFingerprint | undefined> {
  try {
    return fingerprintOf(await stat(sessionFile));
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export function sameFingerprint(left: SessionFingerprint | undefined, right: SessionFingerprint | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
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

function fingerprintOf(stats: Stats): SessionFingerprint {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
}

function isBoothCookie(cookie: StorageCookie): boolean {
  return isBoothHost(cookie.domain.replace(/^\./u, ""));
}

function parseJsonOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
