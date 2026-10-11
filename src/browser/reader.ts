export interface ReadJsonOptions {
  /** Origin for a relative `path`. Must be https://booth.pm or https://accounts.booth.pm. */
  origin?: string;
  /** Page (same allowlist) to fetch first for a `<meta name="csrf-token">` sent as X-CSRF-Token. */
  csrfFrom?: string;
}

/**
 * Read-only BOOTH access. `path` is either a path relative to https://booth.pm or an absolute URL on
 * exactly https://booth.pm or https://accounts.booth.pm; anything else is rejected before sending.
 */
export interface BoothReader {
  read<T>(path: string, parser: (html: string, finalUrl: string) => T): Promise<{ data: T; url: string }>;
  readJson<T>(
    path: string,
    parser: (json: unknown, finalUrl: string) => T,
    options?: ReadJsonOptions,
  ): Promise<{ data: T; url: string }>;
  close(): Promise<void>;
}

export interface RedirectLocation {
  status: number;
  /** Absolute redirect target. May be a signed URL: never log it or put it in an error message. */
  location: string | undefined;
}

export interface BoothRedirectReader {
  /** Single GET to https://booth.pm/downloadables/{id}[?variation_id=N] without following the redirect. */
  getRedirectLocation(url: string): Promise<RedirectLocation>;
}
