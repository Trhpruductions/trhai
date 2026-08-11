// Client-side account state.
//
// The token is the only credential the browser holds; the password is never
// stored, and never kept in React state beyond the submit that sends it.

export type Account = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
};

export const accountTokenStorageKey = "ascend.auth.token.v1";

export function readStoredToken(storage: Storage | undefined): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(accountTokenStorageKey);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredToken(storage: Storage | undefined, token: string | null): void {
  if (!storage) return;
  try {
    if (token) {
      storage.setItem(accountTokenStorageKey, token);
    } else {
      storage.removeItem(accountTokenStorageKey);
    }
  } catch {
    // Blocked storage just means the session ends with the tab.
  }
}

/** Authorization header when signed in, nothing when not. */
export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type AuthOutcome =
  | { ok: true; account: Account; token: string; recoveryCodes: string[] }
  | { ok: false; error: string };

/** Normalizes the API's success and error shapes into one result. */
export function readAuthResponse(status: number, payload: unknown): AuthOutcome {
  const body = (payload ?? {}) as {
    data?: { account?: Account; token?: string; recoveryCodes?: unknown };
    message?: string;
  };

  if (status >= 200 && status < 300 && body.data?.account && body.data?.token) {
    // Only registration returns codes, and only once.
    const recoveryCodes = Array.isArray(body.data.recoveryCodes)
      ? body.data.recoveryCodes.filter((code): code is string => typeof code === "string")
      : [];
    return { ok: true, account: body.data.account, token: body.data.token, recoveryCodes };
  }

  return {
    ok: false,
    error: typeof body.message === "string" && body.message
      ? body.message
      : "Sign in failed. Please try again."
  };
}

/** Client-side guard so an obviously bad form does not need a round trip. */
export function validateCredentials(email: string, password: string): string | null {
  if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return "Enter a valid email address";
  }
  if (password.length < 10) {
    return "Password must be at least 10 characters";
  }
  return null;
}
