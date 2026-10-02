import os from "node:os";
import type { AddressInfo } from "node:net";

// TRH AI's own service, the local model runtime it depends on, and this PC's
// network, as they are right now - for the System and Network workspaces.
//
// Every figure here is read when asked for. The listen addresses in particular
// are recorded by index.ts from the servers it actually started, not worked
// out from how the code happens to call listen(): a page saying "reachable
// only from this PC" has to be true of the running process, not of a guess.

const startedAt = new Date();
let listening: { port: number; addresses: Array<{ address: string; family: string }>; keyRequired: boolean } | null = null;

/**
 * Called once the service is listening, with every address it bound - this
 * PC's two, usually - and whether another device has to show the access key.
 */
export function noteListening(bound: AddressInfo[], options: { keyRequired?: boolean } = {}): void {
  if (bound.length === 0) return;
  listening = {
    port: bound[0].port,
    addresses: bound.map(({ address, family }) => ({ address, family })),
    keyRequired: options.keyRequired ?? false
  };
}

/** Whether a bound address accepts connections from other machines. */
export function reachableFromNetwork(address: string): boolean {
  return address === "::" || address === "0.0.0.0" || !(address === "::1" || address.startsWith("127."));
}

export function serviceStatus() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    listening: listening
      ? { ...listening, fromNetwork: listening.addresses.some((entry) => reachableFromNetwork(entry.address)) }
      : null
  };
}

export type LoadedModel = { name: string; sizeBytes: number; vramBytes: number; expiresAt: string | null };
export type OllamaRuntime = {
  reachable: boolean;
  version: string | null;
  /** Models in memory now, with how much of each sits on the graphics card. */
  loaded: LoadedModel[];
  installed: Array<{ name: string; sizeBytes: number }>;
};

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

/** What Ollama has loaded and installed, read from Ollama itself. */
export async function ollamaRuntime(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<OllamaRuntime> {
  try {
    const [ps, tags, version] = await Promise.all([
      getJson(`${baseUrl}/api/ps`, fetchImpl) as Promise<{ models?: Array<Record<string, unknown>> }>,
      getJson(`${baseUrl}/api/tags`, fetchImpl) as Promise<{ models?: Array<Record<string, unknown>> }>,
      getJson(`${baseUrl}/api/version`, fetchImpl).catch(() => null) as Promise<{ version?: unknown } | null>
    ]);
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return {
      reachable: true,
      version: typeof version?.version === "string" ? version.version : null,
      loaded: (ps.models ?? []).map((model) => ({
        name: text(model.name),
        sizeBytes: count(model.size),
        vramBytes: count(model.size_vram),
        expiresAt: text(model.expires_at) || null
      })).filter((model) => model.name),
      installed: (tags.models ?? []).map((model) => ({ name: text(model.name), sizeBytes: count(model.size) })).filter((model) => model.name)
    };
  } catch {
    return { reachable: false, version: null, loaded: [], installed: [] };
  }
}

/**
 * Take a model out of memory now, rather than when its keep-alive runs out.
 * The way Ollama itself offers: a request with keep_alive 0 and no prompt.
 * Nothing is lost - the next request that needs it loads it again.
 */
export async function unloadModel(baseUrl: string, name: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name, keep_alive: 0 }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return { ok: false, reason: `Ollama answered with ${response.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "Ollama is not answering." };
  }
}

/** This PC's network addresses, as the operating system lists them. */
export function networkInterfaces(): Array<{ name: string; address: string; family: "IPv4" | "IPv6"; internal: boolean }> {
  const found: Array<{ name: string; address: string; family: "IPv4" | "IPv6"; internal: boolean }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      found.push({ name, address: entry.address, family: entry.family === "IPv6" ? "IPv6" : "IPv4", internal: entry.internal });
    }
  }
  return found;
}

/** The address an internet check asks: the search engine the Browser uses. */
export const internetCheckTarget = "https://lite.duckduckgo.com/lite/";

/** Whether the internet answers, and how long it took - measured once, when asked. */
export async function internetCheck(fetchImpl: typeof fetch = fetch, now: () => number = () => performance.now()) {
  const started = now();
  try {
    const response = await fetchImpl(internetCheckTarget, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    return { reachable: response.status > 0, latencyMs: Math.round(now() - started), target: internetCheckTarget, status: response.status };
  } catch {
    return { reachable: false, latencyMs: null, target: internetCheckTarget, status: null };
  }
}
