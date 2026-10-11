export interface ResultMeta {
  fetchedAt: string;
  sourceUrl: string;
  page?: number;
  nextPage?: number;
  redactions: string[];
}

export interface BoothResult<T> {
  data: T;
  meta: ResultMeta;
}

export interface AuthStatus {
  authenticated: boolean;
  /** Best-effort; omitted when the settings page does not expose it reliably. */
  displayName?: string;
}

export interface LoginResult {
  authenticated: true;
}

export interface LogoutResult {
  sessionFileRemoved: boolean;
  profileDirRemoved: boolean;
  warnings: string[];
}
