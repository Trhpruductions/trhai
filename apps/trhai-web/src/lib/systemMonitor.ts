// The System and Network workspaces' wording: where a loaded model sits, when
// it will be let go, and what the service's listen address means for who can
// reach it. Pure, so it is testable without a screen.

export type LoadedModel = { name: string; sizeBytes: number; vramBytes: number; expiresAt: string | null };
export type Listening = {
  port: number;
  /** Every address the service bound: this PC's two, unless other devices are let in. */
  addresses: Array<{ address: string; family: string }>;
  fromNetwork: boolean;
  /** Whether a request from another device has to carry the access key. */
  keyRequired: boolean;
} | null;
/** Whether other devices are let in, and - on this PC only - the key they need. */
export type NetworkAccess = { otherDevices: boolean; header: string; key: string | null };

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

/** "127.0.0.1 and ::1", "every address" - what the service is bound to, in words. */
function boundTo(addresses: Array<{ address: string }>): string {
  if (addresses.some(({ address }) => address === "::" || address === "0.0.0.0")) return "every address";
  const names = addresses.map(({ address }) => address);
  if (names.length <= 1) return names[0] ?? "no address";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Who can reach the service, from what it is bound to. */
export function reachWords(listening: Listening): { text: string; fromNetwork: boolean | null } {
  if (!listening) return { text: "Not known - the service has not said what it is listening on.", fromNetwork: null };
  const where = `Listening on ${boundTo(listening.addresses)}, port ${listening.port}`;
  if (!listening.fromNetwork) return { text: `${where}: only this PC can reach it.`, fromNetwork: false };
  // What it is bound to is known; whether Windows Firewall lets the port
  // through is not, so the reach is stated with that condition.
  const reach = `${where}: other devices on your network can reach it, unless a firewall blocks the port`;
  return listening.keyRequired
    ? { text: `${reach}, and only with the access key.`, fromNetwork: true }
    : { text: `${reach}.`, fromNetwork: true };
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
