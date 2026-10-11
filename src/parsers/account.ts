import { load } from "cheerio";

export interface AccountSettings {
  displayName?: string;
}

const MAX_DISPLAY_NAME_LENGTH = 100;

/**
 * Candidate selectors for the buyer's display name on https://accounts.booth.pm/settings.
 * TODO(PLAN §7): verify against the real page. Only the nickname is read; e-mail and other
 * personal fields on the page are deliberately ignored.
 */
const DISPLAY_NAME_SELECTORS = ['input[name="user[nickname]"]', 'input[name="user[name]"]'];

/** Never throws: authentication is decided by the final URL, the display name is a best-effort extra. */
export function parseAccountSettings(html: string): AccountSettings {
  const $ = load(html);
  for (const selector of DISPLAY_NAME_SELECTORS) {
    const value = $(selector).first().attr("value")?.replace(/\s+/gu, " ").trim();
    if (value && value.length <= MAX_DISPLAY_NAME_LENGTH) return { displayName: value };
  }
  return {};
}
