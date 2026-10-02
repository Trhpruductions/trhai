// What the loading screen checks, and what it found.
//
// Every step is a real request to the local service, and the screen moves on
// when the answers arrive - not on a timer. A loading bar that fills at a
// fixed pace says nothing about whether anything is ready, and this app's
// rule is that the interface never shows a state it did not observe.

import type { SignedInAccount } from "./auth";

export type BootStepId = "service" | "model" | "account" | "tools";
export type BootState = "pending" | "running" | "ok" | "warn" | "fail";

export type BootStep = {
  id: BootStepId;
  label: string;
  state: BootState;
  /** What was found, in a few words. Empty until the step has an answer. */
  detail: string;
};

export type BootFindings = {
  version: string | null;
  model: string | null;
  /** The signed-in account, when a stored session is still good. */
  account: SignedInAccount | null;
  /** True when a stored session was refused and should be forgotten. */
  sessionExpired: boolean;
};

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const bootSteps: Array<Pick<BootStep, "id" | "label">> = [
  { id: "service", label: "Local service" },
  { id: "model", label: "AI model" },
  { id: "account", label: "Your account" },
  { id: "tools", label: "Tools and workspace" }
];

export function initialSteps(): BootStep[] {
  return bootSteps.map((step) => ({ ...step, state: "pending", detail: "" }));
}

async function readJson(fetcher: Fetcher, url: string, init?: RequestInit): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetcher(url, init);
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return null;
  }
}

function dataOf<T>(body: unknown): T | null {
  const value = body as { data?: T } | null;
  return value && typeof value === "object" && "data" in value ? (value.data ?? null) : null;
}

/** Whether the local service answers its health check at all. */
export async function checkService(baseUrl: string, fetcher: Fetcher): Promise<boolean> {
  const result = await readJson(fetcher, `${baseUrl}/health`);
  return result?.status === 200 && (result.body as { status?: unknown } | null)?.status === "ok";
}

/**
 * Everything after the service is up, checked side by side.
 *
 * `onStep` is called as each answer arrives, so the screen shows them in the
 * order they really landed.
 */
export async function checkTheRest(
  baseUrl: string,
  fetcher: Fetcher,
  token: string | null,
  onStep: (step: Omit<BootStep, "label">) => void
): Promise<BootFindings> {
  const findings: BootFindings = { version: null, model: null, account: null, sessionExpired: false };

  const model = (async () => {
    onStep({ id: "model", state: "running", detail: "" });
    const result = await readJson(fetcher, `${baseUrl}/v1/assist/model`);
    const data = dataOf<{ available?: boolean; model?: string; reason?: string }>(result?.body);
    if (data?.available && typeof data.model === "string") {
      findings.model = data.model;
      onStep({ id: "model", state: "ok", detail: data.model });
    } else {
      // Not a failure of the app: memory, files and tools work without one.
      onStep({ id: "model", state: "warn", detail: "No model loaded - memory, files and tools still work" });
    }
  })();

  const account = (async () => {
    if (!token) {
      onStep({ id: "account", state: "ok", detail: "Not signed in" });
      return;
    }
    onStep({ id: "account", state: "running", detail: "" });
    const result = await readJson(fetcher, `${baseUrl}/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const data = dataOf<{ account?: SignedInAccount }>(result?.body);
    if (result?.status === 200 && data?.account) {
      findings.account = data.account;
      onStep({ id: "account", state: "ok", detail: `Signed in as ${data.account.displayName}` });
    } else if (result?.status === 401) {
      findings.sessionExpired = true;
      onStep({ id: "account", state: "warn", detail: "Your session ended - sign in again" });
    } else {
      onStep({ id: "account", state: "warn", detail: "Could not confirm your session" });
    }
  })();

  const tools = (async () => {
    onStep({ id: "tools", state: "running", detail: "" });
    const [capabilities, build] = await Promise.all([
      readJson(fetcher, `${baseUrl}/v1/capabilities`),
      readJson(fetcher, `${baseUrl}/v1/build-info`)
    ]);
    const version = dataOf<{ webVersion?: string; apiVersion?: string }>(build?.body);
    findings.version = version?.webVersion ?? version?.apiVersion ?? null;
    const list = dataOf<{ tools?: unknown[] }>(capabilities?.body)?.tools;
    if (Array.isArray(list)) {
      onStep({ id: "tools", state: "ok", detail: `${list.length} tools ready` });
    } else {
      onStep({ id: "tools", state: "warn", detail: "The tool list did not load" });
    }
  })();

  await Promise.all([model, account, tools]);
  return findings;
}

/** How far along the checks are, 0..1, counting only steps with an answer. */
export function bootProgress(steps: BootStep[], serviceUp: boolean): number {
  const done = steps.filter((step) => step.state === "ok" || step.state === "warn" || step.state === "fail").length;
  // The service is the first quarter on its own: nothing else can start
  // until it answers.
  return Math.min(1, done / steps.length + (serviceUp && done === 0 ? 0.05 : 0));
}
