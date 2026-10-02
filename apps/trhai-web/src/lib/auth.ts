// Signing in, as this app actually does it.
//
// The API has had accounts for a long time - register, sign in, recovery
// codes, sign out - and memory follows an account whenever a request carries
// its token (resolveMemoryKey in apps/api/src/server.ts). Nothing in the
// interface ever sent one, so none of it could be reached. This is where the
// token lives, and how every request carries it.
//
// "Keep me signed in" decides where: localStorage survives closing the app,
// sessionStorage does not. A token is a bearer credential and is never kept in
// both. Signing in is optional by design - "continue without an account" is a
// real choice, remembered for this session only, so the next launch asks again.

export type SignedInAccount = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
};

export type StoredAuth = {
  token: string;
  account: SignedInAccount;
  expiresAt: string;
  /** True when it should outlive this session. */
  remember: boolean;
};

export const authStorageKey = "trhai.auth.v1";
export const guestStorageKey = "trhai.guest.v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isAccount(value: unknown): value is SignedInAccount {
  const account = value as Partial<SignedInAccount> | null;
  return Boolean(account) && typeof account?.id === "string" && typeof account?.email === "string"
    && typeof account?.displayName === "string" && typeof account?.createdAt === "string";
}

function parse(raw: string | null, remember: boolean): StoredAuth | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredAuth>;
    if (typeof value.token !== "string" || !value.token || typeof value.expiresAt !== "string" || !isAccount(value.account)) {
      return null;
    }
    return { token: value.token, account: value.account, expiresAt: value.expiresAt, remember };
  } catch {
    return null;
  }
}

function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/**
 * The signed-in session, or null. One that has expired is cleared rather than
 * returned: the API would refuse it, and every request would carry it anyway.
 */
export function readStoredAuth(local: Store | undefined, session: Store | undefined, now = Date.now()): StoredAuth | null {
  const found = parse(safely(() => local?.getItem(authStorageKey) ?? null, null), true)
    ?? parse(safely(() => session?.getItem(authStorageKey) ?? null, null), false);
  if (!found) return null;
  const expires = Date.parse(found.expiresAt);
  if (Number.isFinite(expires) && expires <= now) {
    clearStoredAuth(local, session);
    return null;
  }
  return found;
}

/** Keeps the session where "keep me signed in" says, and nowhere else. */
export function writeStoredAuth(local: Store | undefined, session: Store | undefined, auth: StoredAuth): void {
  const value = JSON.stringify({ token: auth.token, account: auth.account, expiresAt: auth.expiresAt });
  const [keep, drop] = auth.remember ? [local, session] : [session, local];
  safely(() => drop?.removeItem(authStorageKey), undefined);
  safely(() => keep?.setItem(authStorageKey, value), undefined);
  // Signing in ends the guest choice.
  safely(() => session?.removeItem(guestStorageKey), undefined);
}

export function clearStoredAuth(local: Store | undefined, session: Store | undefined): void {
  safely(() => local?.removeItem(authStorageKey), undefined);
  safely(() => session?.removeItem(authStorageKey), undefined);
}

/** The header that makes a request the signed-in account's, or nothing. */
export function authHeaderFor(auth: StoredAuth | null): Record<string, string> {
  return auth ? { Authorization: `Bearer ${auth.token}` } : {};
}

/** "Continue without an account", for the rest of this session. */
export function chooseGuest(session: Store | undefined): void {
  safely(() => session?.setItem(guestStorageKey, "1"), undefined);
}

export function isGuestThisSession(session: Store | undefined): boolean {
  return safely(() => session?.getItem(guestStorageKey) === "1", false);
}

export function clearGuest(session: Store | undefined): void {
  safely(() => session?.removeItem(guestStorageKey), undefined);
}

/** This browser's own stores, or nothing during server rendering. */
export function browserStores(): { local: Store | undefined; session: Store | undefined } {
  if (typeof window === "undefined") return { local: undefined, session: undefined };
  return {
    local: safely(() => window.localStorage, undefined),
    session: safely(() => window.sessionStorage, undefined)
  };
}

/** The current request's auth header, read when the request is made. */
export function currentAuthHeaders(): Record<string, string> {
  const { local, session } = browserStores();
  return authHeaderFor(readStoredAuth(local, session));
}

// ---------------------------------------------------------------- the API

export type AuthFailure = {
  ok: false;
  /** What to show, in the API's own words where it gave some. */
  message: string;
  /** Present when the API said to wait (429). */
  retryAfterSeconds?: number;
  /** True when nothing answered at all. */
  unreachable?: boolean;
};

export type AuthSuccess = { ok: true; token: string; account: SignedInAccount; expiresAt: string; recoveryCodes?: string[] };

type Fetcher = typeof fetch;

/**
 * One call to an /v1/auth route, never throwing.
 *
 * Kept apart from apiPost because sign-in needs what apiPost flattens away:
 * the status (a 429 is "wait", a 401 is "wrong password") and the
 * retryAfterSeconds the API sends with it.
 */
export async function authRequest(
  baseUrl: string,
  route: "login" | "register" | "recover",
  body: Record<string, unknown>,
  fetcher: Fetcher = fetch
): Promise<AuthSuccess | AuthFailure> {
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/v1/auth/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    return { ok: false, unreachable: true, message: "The local service is not answering. It starts with the app - give it a moment and try again." };
  }

  const payload = await response.json().catch(() => null) as
    { data?: Partial<AuthSuccess>; message?: unknown; retryAfterSeconds?: unknown } | null;

  if (response.status === 429) {
    const wait = typeof payload?.retryAfterSeconds === "number" ? Math.max(1, Math.round(payload.retryAfterSeconds)) : undefined;
    return {
      ok: false,
      retryAfterSeconds: wait,
      message: wait ? `Too many attempts. Try again in ${wait} second${wait === 1 ? "" : "s"}.` : "Too many attempts. Wait a moment and try again."
    };
  }

  const data = payload?.data;
  if (!response.ok || !data || typeof data.token !== "string" || !isAccount(data.account) || typeof data.expiresAt !== "string") {
    return {
      ok: false,
      message: typeof payload?.message === "string" && payload.message.trim()
        ? `${payload.message.trim().replace(/\.?$/, ".")}`
        : `Something went wrong (the service answered ${response.status}).`
    };
  }

  return {
    ok: true,
    token: data.token,
    account: data.account,
    expiresAt: data.expiresAt,
    ...(Array.isArray(data.recoveryCodes) ? { recoveryCodes: data.recoveryCodes.filter((code): code is string => typeof code === "string") } : {})
  };
}

/** Ends the session on the server too; the local copy goes either way. */
export async function signOutRequest(baseUrl: string, token: string, fetcher: Fetcher = fetch): Promise<void> {
  try {
    await fetcher(`${baseUrl}/v1/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  } catch {
    // Nothing to do: the token is dropped locally regardless.
  }
}

// ---------------------------------------------------------------- passwords

/** The API's own floor (minPasswordLength in apps/api/src/services/accounts.ts). */
export const minPasswordLength = 10;

export type PasswordStrength = { score: 0 | 1 | 2 | 3 | 4; label: string; meetsMinimum: boolean };

/**
 * A rough strength, for the meter under the password field.
 *
 * Length counts for most, then variety, and an obvious pattern costs. It
 * does not claim more than that: the only rule the server enforces is the
 * ten-character minimum, and the meter never says "strong" below it.
 */
export function passwordStrength(password: string): PasswordStrength {
  const meetsMinimum = password.length >= minPasswordLength;
  if (!password) return { score: 0, label: "", meetsMinimum: false };

  let points = 0;
  if (password.length >= minPasswordLength) points += 1;
  if (password.length >= 14) points += 1;
  if (password.length >= 18) points += 1;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((kind) => kind.test(password)).length;
  if (kinds >= 3) points += 1;
  if (/(.)\1{2,}|0123|1234|abcd|qwer|password|letmein/i.test(password)) points -= 1;

  const score = (meetsMinimum ? Math.max(1, Math.min(4, points)) : Math.min(1, Math.max(0, points))) as PasswordStrength["score"];
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
  return { score, label: meetsMinimum ? labels[score] : `Too short - at least ${minPasswordLength} characters`, meetsMinimum };
}

/** The same check the API makes, so the form can say so before sending. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
