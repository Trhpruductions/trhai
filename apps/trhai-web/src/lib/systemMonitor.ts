// The System and Network workspaces' wording: where a loaded model sits, when
// it will be let go, and what the service's listen address means for who can
// reach it. Pure, so it is testable without a screen.

export type LoadedModel = { name: string; sizeBytes: number; vramBytes: number; expiresAt: string | null };
export type Listening = { address: string; port: number; family: string; fromNetwork: boolean } | null;

/** Where a loaded model sits: on the graphics card, split, or in ordinary memory. */
export function placement(model: LoadedModel): string {
  if (model.sizeBytes <= 0) return "Loaded";
  const share = model.vramBytes / model.sizeBytes;
  if (share >= 0.99) return "All on the graphics card";
  if (share <= 0.01) return "In memory - none on the graphics card";
  return `${Math.round(share * 100)}% on the graphics card, the rest in memory`;
}

/**
 * When Ollama will let a model go if nothing uses it. Ollama writes a date
 * centuries away for "keep it loaded", and nothing for one being unloaded.
 */
export function unloadsWhen(expiresAt: string | null, now: Date): string {
  const at = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(at)) return "being let go";
  const ms = at - now.getTime();
  if (ms > 24 * 60 * 60 * 1000) return "kept loaded";
  if (ms <= 30_000) return "lets go any moment";
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `lets go in ${minutes} min unless used` : `lets go in ${Math.round(minutes / 60)} h unless used`;
}

/** Who can reach the service, from what it is bound to. */
export function reachWords(listening: Listening): { text: string; fromNetwork: boolean | null } {
  if (!listening) return { text: "Not known - the service has not said what it is listening on.", fromNetwork: null };
  const where = listening.address === "::" || listening.address === "0.0.0.0" ? "every address" : listening.address;
  // What it is bound to is known; whether Windows Firewall lets the port
  // through is not, so the reach is stated with that condition.
  return listening.fromNetwork
    ? { text: `Listening on ${where}, port ${listening.port}: other devices on your network can reach it, unless a firewall blocks the port.`, fromNetwork: true }
    : { text: `Listening on ${where}, port ${listening.port}: only this PC can reach it.`, fromNetwork: false };
}

/**
 * The addresses worth showing: this PC's own, with loopback and link-local
 * left out unless asked for - fe80: in IPv6, and 169.254.x.x in IPv4, which
 * Windows gives an adapter that never got an address of its own.
 */
export function visibleAddresses<T extends { address: string; family: string; internal: boolean }>(list: T[], all: boolean): T[] {
  if (all) return list;
  return list.filter((entry) => !entry.internal && !entry.address.toLowerCase().startsWith("fe80:") && !entry.address.startsWith("169.254."));
}
