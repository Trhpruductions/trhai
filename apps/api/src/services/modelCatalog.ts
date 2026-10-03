import { pickModel, type LocalModelConfig } from "./localModel.js";
import { discoverModels, enginePaths, listEngineModels, type EngineModel } from "./modelEngine.js";

// The models a conversation can be answered by: what is in TRH AI's models
// folder, less the ones that cannot hold a conversation - the vision model (it
// is used for images on its own route) and embedding models (they turn text
// into numbers and answer nothing).
//
// A conversation may name one of these. A name that is not installed, or no
// name at all, means the usual choice (pickModel) - never an error, because a
// model being uninstalled must not break a conversation that once used it.

export type ChatModel = {
  name: string;
  /** "7B", read from the model's name; null when the name does not say. */
  parameterSize: string | null;
  family: string | null;
  /** Size on disk, in bytes; null when it is not known. */
  sizeBytes: number | null;
};

/** A model name as a request may carry one: the characters model names use, and nothing else. */
export function isModelName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(value);
}

/** "7B" out of "qwen2.5-coder-7b" or "qwen2.5-coder:7b": the size a model's name carries. */
export function sizeFromName(name: string): string | null {
  const size = /(?:^|[-_:])(\d+(?:\.\d+)?)b(?=$|[-_.:])/i.exec(name)?.[1];
  return size ? `${size}B` : null;
}

/**
 * The engine's models that can answer a chat, by name. `onDisk` gives each
 * one's size where the engine has not loaded it yet and so does not say.
 * Pure, for testing without an engine.
 */
export function chatModelsFrom(entries: EngineModel[], onDisk: ReadonlyMap<string, number> = new Map()): ChatModel[] {
  const models: ChatModel[] = [];
  for (const entry of entries) {
    if (entry.vision) continue;
    if (/embed|bert/i.test(entry.id)) continue;
    models.push({
      name: entry.id,
      parameterSize: sizeFromName(entry.id),
      family: null,
      sizeBytes: entry.sizeBytes ?? onDisk.get(entry.id) ?? null
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
    const entries = await listEngineModels(config.baseUrl, fetchImpl);
    const onDisk = new Map(discoverModels(enginePaths().modelsDir).map((model) => [model.id, model.sizeBytes]));
    const models = chatModelsFrom(entries, onDisk);
    const defaultModel = pickModel(config.model, models.map((model) => model.name), config.modelFromEnv);
    return { models, defaultModel };
  } catch (error) {
    if (error instanceof Error && /^The model engine answered \d+/.test(error.message)) {
      return { models: [], defaultModel: null, reason: error.message };
    }
    return { models: [], defaultModel: null, reason: `No local model server is answering at ${config.baseUrl}.` };
  }
}
