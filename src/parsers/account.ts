import { load, type CheerioAPI } from "cheerio";
import { z } from "zod";

export interface AccountSettings {
  displayName?: string;
}

const MAX_DISPLAY_NAME_LENGTH = 100;

/**
 * Where the buyer's display name is on https://accounts.booth.pm/settings. Verified against real page 2026-10-12:
 * the settings form itself is rendered by JavaScript (`main` holds only `#js-mount-point-settings`), so the name is
 * read from the global header that every accounts page carries: `#js-user-pulldown[data-current-user]` (JSON with
 * `nickname` and `thumbnail_url`), then `#js-navigation[data-user-name]`. The form inputs are older fallbacks that
 * the server-rendered page no longer has. Only the nickname is read; nothing else from these attributes is kept.
 */
const CURRENT_USER_SELECTOR = "#js-user-pulldown[data-current-user]";
const USER_NAME_SELECTOR = "#js-navigation[data-user-name]";
const DISPLAY_NAME_INPUT_SELECTORS = ['input[name="user[nickname]"]', 'input[name="user[name]"]'];

const currentUserSchema = z.object({ nickname: z.string() });

/** Never throws: authentication is decided by the final URL, the display name is a best-effort extra. */
export function parseAccountSettings(html: string): AccountSettings {
  const $ = load(html);
  const candidates = [
    nicknameFromCurrentUser($),
    $(USER_NAME_SELECTOR).first().attr("data-user-name"),
    ...DISPLAY_NAME_INPUT_SELECTORS.map((selector) => $(selector).first().attr("value")),
  ];
  for (const candidate of candidates) {
    const value = candidate?.replace(/\s+/gu, " ").trim();
    if (value && value.length <= MAX_DISPLAY_NAME_LENGTH) return { displayName: value };
  }
  return {};
}

/** The attribute is page content, so it is parsed defensively: bad JSON or an unexpected shape yields nothing. */
function nicknameFromCurrentUser($: CheerioAPI): string | undefined {
  const raw = $(CURRENT_USER_SELECTOR).first().attr("data-current-user");
  if (raw === undefined) return undefined;
  try {
    const parsed = currentUserSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.nickname : undefined;
  } catch {
    return undefined;
  }
}
