// The System and Network workspaces' wording: the window a loaded model was
// given, when it will be let go, and what the service's listen address means
// for who can reach it. Pure, so it is testable without a screen.

export type LoadedModel = {
  name: string;
  sizeBytes: number;
  /** The context window the engine gave it on this card, in tokens. */
  windowTokens: number | null;
};
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

/**
 * The window a loaded model was given, in words: "9,216-token window". The
 * engine fits it to the graphics card, so it differs from one model to the
 * next. Null when the engine has not said.
 */
export function windowWords(model: LoadedModel): string | null {
  return model.windowTokens && model.windowTokens > 0 ? `${model.windowTokens.toLocaleString("en-US")}-token window` : null;
}

/** When a loaded model is let go if nothing uses it: "let go after 5 idle minutes". */
export function idleWords(idleUnloadSeconds: number | null | undefined): string {
  if (!idleUnloadSeconds || idleUnloadSeconds <= 0) return "kept loaded";
  if (idleUnloadSeconds < 90) return `let go after ${Math.round(idleUnloadSeconds)} idle seconds`;
  const minutes = Math.round(idleUnloadSeconds / 60);
  return `let go after ${minutes} idle minute${minutes === 1 ? "" : "s"}`;
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
