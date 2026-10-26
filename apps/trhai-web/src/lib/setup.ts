// First-run setup, from the interface's side: what the API says this PC has
// and needs, starting and stopping the install, and the arithmetic the
// screens show. The API does the downloading (apps/api/src/services/modelSetup.ts).

import { apiBaseUrl, apiFetch, apiGet, requestHeaders } from "./api";

export type Hardware = {
  totalMemoryBytes: number;
  cpuCores: number;
  gpu: { vendor: "nvidia"; name: string; memoryMiB: number; driver: string } | null;
};

export type StepState = "waiting" | "downloading" | "verifying" | "unpacking" | "done" | "failed" | "cancelled";

export type SetupStep = {
  kind: "engine" | "model" | "tool";
  id: string;
  label: string;
  totalBytes: number;
  doneBytes: number;
  state: StepState;
  error: string | null;
};

export type SetupJob = {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  steps: SetupStep[];
  error: string | null;
};

export type CatalogEntry = {
  id: string;
  label: string;
  summary: string;
  needs: string;
  license: { name: string; url: string; commercialUse: boolean };
  vision: boolean;
  sizeBytes: number;
  installed: boolean;
  recommended: boolean;
};

/** The voice, listening and video tools: optional for answering, needed for those screens. */
export type ToolEntry = {
  id: string;
  label: string;
  summary: string;
  needs: string;
  license: { name: string; url: string; commercialUse: boolean };
  /** The parts that have a licence of their own - the voices - each with it. Absent from an older service. */
  included?: Array<{ label: string; license: { name: string; url: string; commercialUse: boolean } }>;
  installed: boolean;
  /** Bytes still to download: none once it is installed. */
  sizeBytes: number;
  /** Bytes of its own parts not here yet, whether or not it works: a copy with one voice still speaks. Absent from an older service. */
  missingBytes?: number;
  supported: boolean;
};

/** What is left to download for a tool, counting the parts a working copy is still short of. */
export function toolRemainingBytes(tool: ToolEntry): number {
  return tool.missingBytes ?? tool.sizeBytes;
}

/** Whether a tool has anything left to install: it is not installed, or it works and is short of some of its own parts. */
export function toolHasMore(tool: ToolEntry): boolean {
  return !tool.installed || (tool.missingBytes ?? 0) > 0;
}

export type SetupStatus = {
  hardware: Hardware;
  engine: { installed: boolean; build: string | null; running: boolean; reason: string | null; recommendedVariant: string; downloadBytes: number };
  catalog: CatalogEntry[];
  installed: Array<{ id: string; sizeBytes: number; vision: boolean; inCatalog: boolean }>;
  tools: ToolEntry[];
  needsSetup: boolean;
  recommendedModel: string;
  runtimeDir: string;
  freeBytes: number | null;
  job: SetupJob | null;
};

export async function readSetup(): Promise<SetupStatus | null> {
  const result = await apiGet<SetupStatus>("/v1/setup");
  return result.ok ? result.data : null;
}

export type SetupOutcome = { ok: true; status: SetupStatus } | { ok: false; reason: string };

async function send(method: "POST" | "DELETE", path: string, body?: unknown): Promise<SetupOutcome> {
  try {
    const response = await apiFetch(`${apiBaseUrl}${path}`, {
      method,
      headers: requestHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json().catch(() => null) as { data?: SetupStatus; message?: string } | null;
    if (!response.ok || !payload?.data) return { ok: false, reason: payload?.message ?? `The service answered ${response.status}.` };
    return { ok: true, status: payload.data };
  } catch {
    return { ok: false, reason: "TRH AI's service could not be reached." };
  }
}

export function startInstall(request: { engine: boolean; models: string[]; tools?: string[] }): Promise<SetupOutcome> {
  return send("POST", "/v1/setup/install", request);
}

export function stopInstall(): Promise<SetupOutcome> {
  return send("DELETE", "/v1/setup/job");
}

export function removeInstalledModel(id: string): Promise<SetupOutcome> {
  return send("DELETE", `/v1/setup/models/${encodeURIComponent(id)}`);
}

/** "2.5 GB", "19 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** The PC in one line: "8 GB of memory, 4 processor cores, no NVIDIA graphics card". */
export function describeHardware(hardware: Hardware): string {
  const memory = `${Math.round(hardware.totalMemoryBytes / 1024 ** 3)} GB of memory`;
  const cores = `${hardware.cpuCores} processor cores`;
  const card = hardware.gpu ? `${hardware.gpu.name} with ${Math.round(hardware.gpu.memoryMiB / 1024)} GB` : "no NVIDIA graphics card";
  return `${memory}, ${cores}, ${card}`;
}

/** The models picked to start with: what is recommended, unless something that can chat is already there. */
export function initialSelection(status: SetupStatus): string[] {
  const canChat = status.installed.some((model) => !model.vision);
  if (canChat) return [];
  const recommended = status.catalog.find((model) => model.recommended && !model.installed);
  return recommended ? [recommended.id] : [];
}

/** The tools to offer ticked: every one this PC can use that has something left to install, so that one click installs everything. */
export function initialToolSelection(status: SetupStatus): string[] {
  return (status.tools ?? []).filter((tool) => tool.supported && toolHasMore(tool)).map((tool) => tool.id);
}

/**
 * Why the setup screen should open by itself, if it should.
 *
 * "first-run": there is nothing to answer with yet. "tools": TRH AI can answer,
 * but this PC has not been offered the voice, listening and video tools, which a
 * copy installed before they existed never was; the screen offers them once and
 * they stay in Settings after that.
 */
export function setupReason(status: SetupStatus, toolsAlreadyOffered: boolean): "first-run" | "tools" | null {
  if (status.needsSetup) return "first-run";
  if (!toolsAlreadyOffered && (status.tools ?? []).some((tool) => tool.supported && !tool.installed)) return "tools";
  return null;
}

/** What an install of the selection would download, engine included when it is missing. */
export function plannedBytes(status: SetupStatus, selected: string[], selectedTools: string[] = []): number {
  const models = status.catalog.filter((model) => selected.includes(model.id) && !model.installed).reduce((sum, model) => sum + model.sizeBytes, 0);
  const tools = (status.tools ?? []).filter((tool) => selectedTools.includes(tool.id) && toolHasMore(tool)).reduce((sum, tool) => sum + toolRemainingBytes(tool), 0);
  return models + tools + (status.engine.installed ? 0 : status.engine.downloadBytes);
}

/** 0 to 100 across every step of a job, by bytes. */
export function jobPercent(job: SetupJob): number {
  const total = job.steps.reduce((sum, step) => sum + step.totalBytes, 0);
  if (total <= 0) return job.state === "done" ? 100 : 0;
  const done = job.steps.reduce((sum, step) => sum + Math.min(step.doneBytes, step.totalBytes), 0);
  return Math.min(100, Math.floor((done / total) * 100));
}

/** What a step is doing, in words. */
export function stepText(step: SetupStep): string {
  switch (step.state) {
    case "waiting": return `Waiting · ${formatBytes(step.totalBytes)}`;
    case "downloading": return `Downloading · ${formatBytes(step.doneBytes)} of ${formatBytes(step.totalBytes)}`;
    case "verifying": return "Checking it is exactly what its makers published";
    case "unpacking": return "Unpacking";
    case "done": return "Installed";
    case "cancelled": return "Stopped";
    default: return step.error ?? "Failed";
  }
}
