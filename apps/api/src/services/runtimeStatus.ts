import os from "node:os";
import type { AddressInfo } from "node:net";
import {
  discoverModels, engineOffReason, enginePaths, idleUnloadSeconds, listEngineModels, unloadEngineModel
} from "./modelEngine.js";

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

export type LoadedModel = {
  name: string;
  sizeBytes: number;
  /** The context window the engine gave it on this card, in tokens. */
  windowTokens: number | null;
};
export type EngineRuntime = {
  reachable: boolean;
  /** The engine's build, as it says it: "b11366-2923cf286". */
  version: string | null;
  /** The model in memory now. One at most: the engine lets it go to load another. */
  loaded: LoadedModel[];
  installed: Array<{ name: string; sizeBytes: number }>;
  /** A loaded model that nothing uses is let go after this long. */
  idleUnloadSeconds: number;
  /** Why the engine is not running, when this service is the one that starts it. */
  reason: string | null;
};

/** What the model engine has loaded and installed, read from the engine itself. */
export async function engineRuntime(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<EngineRuntime> {
  // The engine gives a model's size only once it has loaded it; the files in
  // the models folder give the rest.
  const onDisk = new Map(discoverModels(enginePaths().modelsDir).map((model) => [model.id, model.sizeBytes]));
  try {
    const [models, build] = await Promise.all([
      listEngineModels(baseUrl, fetchImpl),
      fetchImpl(`${baseUrl}/props`, { signal: AbortSignal.timeout(4000) })
        .then((response) => (response.ok ? response.json() as Promise<{ build_info?: unknown }> : null))
        .then((props) => (typeof props?.build_info === "string" ? props.build_info : null))
        .catch(() => null)
    ]);
    const size = (model: { id: string; sizeBytes: number | null }) => model.sizeBytes ?? onDisk.get(model.id) ?? 0;
    return {
      reachable: true,
      version: build,
      loaded: models.filter((model) => model.status === "loaded")
        .map((model) => ({ name: model.id, sizeBytes: size(model), windowTokens: model.windowTokens })),
      installed: models.map((model) => ({ name: model.id, sizeBytes: size(model) })),
      idleUnloadSeconds: idleUnloadSeconds(),
      reason: null
    };
  } catch {
    return { reachable: false, version: null, loaded: [], installed: [], idleUnloadSeconds: idleUnloadSeconds(), reason: engineOffReason() };
  }
}

/**
 * Take a model out of memory now, rather than after it has sat idle.
 * Nothing is lost - the next request that needs it loads it again.
 */
export async function unloadModel(baseUrl: string, name: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; reason: string }> {
  return unloadEngineModel(baseUrl, name, fetchImpl);
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
