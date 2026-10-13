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
  kind: "engine" | "model";
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

export type SetupStatus = {
  hardware: Hardware;
  engine: { installed: boolean; build: string | null; running: boolean; reason: string | null; recommendedVariant: string; downloadBytes: number };
  catalog: CatalogEntry[];
  installed: Array<{ id: string; sizeBytes: number; vision: boolean; inCatalog: boolean }>;
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

export function startInstall(request: { engine: boolean; models: string[] }): Promise<SetupOutcome> {
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

/** What an install of the selection would download, engine included when it is missing. */
export function plannedBytes(status: SetupStatus, selected: string[]): number {
  const models = status.catalog.filter((model) => selected.includes(model.id) && !model.installed).reduce((sum, model) => sum + model.sizeBytes, 0);
  return models + (status.engine.installed ? 0 : status.engine.downloadBytes);
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
