// The backend TRHAI actually talks to.
//
// This is not a new service — it is the same local API the rest of this
// monorepo already built and tested: an Express process that talks to Ollama
// on this machine and nothing beyond it. A rewrite of the interface does not
// require a rewrite of the parts that already work honestly, and duplicating
// a tested orchestration layer to satisfy a tech-stack wishlist would be the
// wrong kind of rebuild.

export const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/**
 * A GET against the local API, never throwing.
 *
 * Every caller here needs the same thing: the real data, or a plain reason it
 * could not be read. A network failure and a non-2xx response both become the
 * same shape, so nothing downstream has to know which one happened to show an
 * honest message.
 */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`);
    if (!response.ok) return { ok: false, reason: `The service answered with ${response.status}.` };
    const payload = await response.json();
    return { ok: true, data: (payload?.data ?? payload) as T };
  } catch {
    return { ok: false, reason: "Could not reach the local service." };
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, reason: typeof payload?.message === "string" ? payload.message : `The service answered with ${response.status}.` };
    }
    return { ok: true, data: (payload?.data ?? payload) as T };
  } catch {
    return { ok: false, reason: "Could not reach the local service." };
  }
}

export async function apiPatch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, reason: `The service answered with ${response.status}.` };
    return { ok: true, data: (payload?.data ?? payload) as T };
  } catch {
    return { ok: false, reason: "Could not reach the local service." };
  }
}

/** A stable per-browser id, the same scheme the existing web client uses. */
export function sessionId(): string {
  if (typeof window === "undefined") return "";
  const key = "trhai.session.v1";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;

  const created = crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
}
