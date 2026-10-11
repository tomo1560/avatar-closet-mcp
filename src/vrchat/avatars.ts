import { z } from "zod";

import { FileTooLargeError, isMissingFileError, readTextFileCapped, writeFileAtomic } from "../atomic-file.js";
import { errnoCodeOf } from "../errors.js";
import { getAvatarDictionaryFile } from "../profile.js";
import { extractAvatarDisplayName, isAvatarBody } from "./kind.js";
import { resolveAvatarId } from "./matcher.js";
import { SEED_AVATARS } from "./seed-avatars.js";
import type { AvatarDictionary, AvatarEntry, AvatarSuggestion, VrchatItemInput } from "./types.js";
import { uniqueBy } from "./util.js";

export { SEED_AVATARS } from "./seed-avatars.js";

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 100;
const MAX_NAMES = 50;
const MAX_ENTRIES = 2000;
/** avatars.json is hand-edited and small; anything larger is refused before it is read. */
export const MAX_AVATAR_FILE_BYTES = 1024 * 1024;

const avatarEntrySchema = z.object({
  id: z.string().trim().min(1).max(MAX_ID_LENGTH),
  names: z.array(z.string().trim().min(1).max(MAX_NAME_LENGTH)).max(MAX_NAMES),
  restricted: z.boolean().optional(),
  restricted_names: z.array(z.string().trim().min(1).max(MAX_NAME_LENGTH)).max(MAX_NAMES).optional(),
});

/** avatars.json: `{ "version": 1, "avatars": [...] }` or a bare array of entries. */
const avatarFileSchema = z.union([
  z.array(avatarEntrySchema).max(MAX_ENTRIES),
  z.object({ version: z.literal(1).optional(), avatars: z.array(avatarEntrySchema).max(MAX_ENTRIES) }),
]);

type ParsedEntry = z.infer<typeof avatarEntrySchema>;

export class AvatarDictionaryError extends Error {
  readonly file: string;

  constructor(message: string, file: string) {
    super(message);
    this.name = "AvatarDictionaryError";
    this.file = file;
  }
}

function toEntry(parsed: ParsedEntry): AvatarEntry {
  return {
    id: parsed.id,
    names: parsed.names,
    ...(parsed.restricted !== undefined ? { restricted: parsed.restricted } : {}),
    ...(parsed.restricted_names !== undefined ? { restricted_names: parsed.restricted_names } : {}),
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Validate unknown JSON as dictionary entries (throws AvatarDictionaryError). */
export function parseAvatarEntries(json: unknown, file = "avatars.json"): AvatarEntry[] {
  const parsed = avatarFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new AvatarDictionaryError(`Invalid avatar dictionary (${describeIssues(parsed.error)})`, file);
  }
  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.avatars;
  return entries.map(toEntry);
}

/** User entries replace seed entries with the same id; new ids are appended. */
export function mergeAvatarDictionaries(base: AvatarDictionary, overrides: AvatarDictionary): AvatarDictionary {
  const overrideById = new Map(overrides.map((entry) => [entry.id, entry]));
  const baseIds = new Set(base.map((entry) => entry.id));
  return [
    ...base.map((entry) => overrideById.get(entry.id) ?? entry),
    ...overrides.filter((entry) => !baseIds.has(entry.id)),
  ];
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function stripBom(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
}

/** Only the errno code: fs messages contain the path, and with it the OS user name. */
function ioDetail(error: unknown): string {
  if (error instanceof FileTooLargeError) return `larger than ${error.maxBytes} bytes`;
  return errnoCodeOf(error) ?? "unknown error";
}

/** Read only the user's own entries (empty when the file does not exist). */
export async function readUserAvatarEntries(file = getAvatarDictionaryFile()): Promise<AvatarEntry[]> {
  let raw: string;
  try {
    raw = (await readTextFileCapped(file, MAX_AVATAR_FILE_BYTES)).text;
  } catch (error: unknown) {
    if (isMissingFileError(error)) return [];
    throw new AvatarDictionaryError(`Cannot read avatar dictionary (${ioDetail(error)})`, file);
  }
  let json: unknown;
  try {
    json = JSON.parse(stripBom(raw));
  } catch (error: unknown) {
    throw new AvatarDictionaryError(`Avatar dictionary is not valid JSON: ${(error as Error).message}`, file);
  }
  return parseAvatarEntries(json, file);
}

/** Seed dictionary merged with the user's avatars.json (missing file → seed only). */
export async function loadAvatarDictionary(file = getAvatarDictionaryFile()): Promise<AvatarDictionary> {
  return mergeAvatarDictionaries(SEED_AVATARS, await readUserAvatarEntries(file));
}

/**
 * Atomically write entries to avatars.json: a uniquely named temporary file (created exclusively, 0600)
 * renamed over the target; the parent directory is created 0700.
 */
export async function saveAvatarDictionary(entries: AvatarDictionary, file = getAvatarDictionaryFile()): Promise<void> {
  const validated = parseAvatarEntries([...entries], file);
  const body = `${JSON.stringify({ version: 1, avatars: validated }, null, 2)}\n`;
  try {
    await writeFileAtomic(file, body);
  } catch (error: unknown) {
    throw new AvatarDictionaryError(`Cannot write avatar dictionary (${ioDetail(error)})`, file);
  }
}

const ALIAS_SPLIT = /\s*[-‐－–—(（)）/／|｜]\s*/;

function aliasesOf(displayName: string): string[] {
  const parts = displayName.split(ALIAS_SPLIT).map((p) => p.trim()).filter((p) => p !== "");
  return [...new Set(parts.length > 0 ? parts : [displayName])];
}

function slugFor(names: readonly string[], itemId: number): string {
  const latin = names.find((name) => /^[A-Za-z0-9 _.-]+$/.test(name));
  const slug = latin?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? slug : `avatar_${itemId}`;
}

function suggestionFor(item: VrchatItemInput, dictionary: AvatarDictionary): AvatarSuggestion | null {
  const displayName = extractAvatarDisplayName(item.name);
  if (!displayName) return null;
  const aliases = aliasesOf(displayName);
  const knownId = aliases.map((alias) => resolveAvatarId(alias, dictionary)).find((id) => id !== null) ?? null;
  const known = knownId ? dictionary.find((entry) => entry.id === knownId) : undefined;
  return {
    id_suggestion: known?.id ?? slugFor(aliases, item.id),
    names: [...new Set([...aliases, ...(known?.names ?? [])])],
    source_item_id: item.id,
    in_dictionary: known !== undefined,
  };
}

/**
 * Candidate dictionary entries from purchased avatar bodies (category 208, excluding
 * prefab / expression add-ons). The user confirms them before they are saved.
 */
export function suggestAvatarsFromLibrary(
  items: readonly VrchatItemInput[],
  dictionary: AvatarDictionary = SEED_AVATARS,
): AvatarSuggestion[] {
  const suggestions = items
    .filter((item) => isAvatarBody(item))
    .map((item) => suggestionFor(item, dictionary))
    .filter((s): s is AvatarSuggestion => s !== null);
  return uniqueBy(suggestions, (s) => s.id_suggestion);
}
