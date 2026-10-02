import { pickModel, type LocalModelConfig } from "./localModel.js";
import { visionModelName } from "./vision.js";

// The models a conversation can be answered by: what Ollama has installed,
// less the ones that cannot hold a conversation - the vision model (it is
// used for images on its own route) and embedding models (they turn text into
// numbers and answer nothing).
//
// A conversation may name one of these. A name that is not installed, or no
// name at all, means the usual choice (pickModel) - never an error, because a
// model being uninstalled must not break a conversation that once used it.

export type ChatModel = {
  name: string;
  /** "7.6B", as Ollama reports it; null when it does not say. */
  parameterSize: string | null;
  family: string | null;
  /** Download size on disk, in bytes. */
  sizeBytes: number | null;
};

type TagEntry = {
  name?: unknown;
  size?: unknown;
  details?: { family?: unknown; families?: unknown; parameter_size?: unknown };
};

/** A model name as a request may carry one: the characters Ollama names use, and nothing else. */
export function isModelName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(value);
}

const sameModel = (a: string, b: string) => a === b || a.split(":")[0] === b.split(":")[0];

/** Installed models that can answer a chat, by name. Pure, for testing without Ollama. */
export function chatModelsFrom(entries: TagEntry[], visionModel: string): ChatModel[] {
  const models: ChatModel[] = [];
  for (const entry of entries) {
    if (typeof entry?.name !== "string" || !entry.name) continue;
    const family = typeof entry.details?.family === "string" ? entry.details.family : null;
    const families = Array.isArray(entry.details?.families)
      ? entry.details.families.filter((value): value is string => typeof value === "string")
      : [];
    if (sameModel(entry.name, visionModel)) continue;
    if (/embed/i.test(entry.name) || [family, ...families].some((value) => /bert|embed/i.test(value ?? ""))) continue;
    models.push({
      name: entry.name,
      parameterSize: typeof entry.details?.parameter_size === "string" ? entry.details.parameter_size : null,
      family,
      sizeBytes: typeof entry.size === "number" ? entry.size : null
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The model calls' config with the conversation's choice in it. Marked as a
 * deliberate choice so pickModel takes it when installed; when it is not,
 * pickModel falls through to the usual preference order by itself.
 */
export function withChosenModel(config: LocalModelConfig, chosen?: string | null): LocalModelConfig {
  return isModelName(chosen) ? { ...config, model: chosen, modelFromEnv: true } : config;
}

/** The chat models installed now, and which one answers when a conversation names none. */
export async function listChatModels(
  config: LocalModelConfig,
  fetchImpl: typeof fetch = fetch
): Promise<{ models: ChatModel[]; defaultModel: string | null; reason?: string }> {
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { models: [], defaultModel: null, reason: `Ollama answered ${response.status}.` };
    const payload = await response.json() as { models?: TagEntry[] };
    const entries = Array.isArray(payload.models) ? payload.models : [];
    const models = chatModelsFrom(entries, visionModelName());
    const defaultModel = pickModel(config.model, models.map((model) => model.name), config.modelFromEnv);
    return { models, defaultModel };
  } catch {
    return { models: [], defaultModel: null, reason: `No local model server is answering at ${config.baseUrl}.` };
  }
}
