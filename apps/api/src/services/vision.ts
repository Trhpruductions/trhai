import type { LocalModelConfig } from "./localModel.js";

// Looking at an image, with a local vision model in Ollama.
//
// The chat model reads text only. An image - pasted into the chat, or a file
// on disk - goes to a separate vision model (qwen2.5vl:3b by default,
// OLLAMA_VISION_MODEL to change it), which answers the question asked about
// it. Nothing leaves the machine and nothing needs a key, the same as
// everything else here. Ollama swaps the two models on an 8 GB card, and a
// cold load from disk took 73 s on a busy one - so the client warms the vision
// model the moment an image is attached (warmVisionModel), while the question
// is still being typed.

export const defaultVisionModel = "qwen2.5vl:3b";

/** The most images looked at in one turn. */
export const maxImagesPerTurn = 4;
/** The vision model's window: a large screenshot and an answer, and no more. */
export const visionContextTokens = 8192;
/** How long the vision model stays loaded after it is used or warmed. */
export const visionKeepAlive = "15m";
/** The largest image read, decoded. The web client shrinks big ones before sending. */
export const maxImageBytes = 20 * 1024 * 1024;

/** Model families Ollama runs with image input, for finding one when the named model is not installed. */
const visionFamilies = ["qwen2.5vl", "qwen2.5-vl", "qwen3-vl", "llava", "llama3.2-vision", "gemma3", "minicpm-v", "moondream", "bakllava"];

export type VisionImage = { name: string; data: Buffer };
export type VisionResult = { ok: true; text: string; model: string } | { ok: false; reason: string };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export function visionModelName(env: NodeJS.ProcessEnv = process.env): string {
  return env.OLLAMA_VISION_MODEL?.trim() || defaultVisionModel;
}

/** What kind of image the bytes are, or null if they are not one this can show the model. */
export function imageKind(bytes: Uint8Array): "png" | "jpeg" | "gif" | "webp" | "bmp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  return null;
}

/**
 * The vision model to use: the named one if it is installed, otherwise any
 * installed model of a family that takes images, otherwise null. `reachable`
 * is false when Ollama did not answer at all - a different problem from no
 * vision model being installed, and the reply should not confuse the two.
 */
export async function findVisionModel(
  baseUrl: string,
  wanted: string,
  fetcher: Fetcher = fetch
): Promise<{ reachable: boolean; model: string | null }> {
  try {
    const response = await fetcher(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { reachable: false, model: null };
    const payload = await response.json() as { models?: Array<{ name?: unknown }> };
    const names = (payload.models ?? []).map((model) => (typeof model.name === "string" ? model.name : "")).filter(Boolean);
    const base = (name: string) => name.replace(/:latest$/, "");
    const exact = names.find((name) => name === wanted || base(name) === base(wanted));
    const model = exact ?? names.find((name) => visionFamilies.some((family) => name.toLowerCase().startsWith(family))) ?? null;
    return { reachable: true, model };
  } catch {
    return { reachable: false, model: null };
  }
}

const visionInstructions = [
  "You are looking at images the user shared from their own computer.",
  "Answer what they asked about them directly and concretely.",
  "Read any text in an image exactly as written - numbers, names, prices, error messages.",
  "If something is not visible, cut off or too small to read, say so rather than guessing."
].join(" ");

/** The default question when an image arrives with none. */
export const describeQuestion = "Describe what this image shows. If there is text in it, read it out exactly.";

/**
 * The images a chat turn carries: `[{ name, data }]`, data as base64 or a
 * data: URL. Anything malformed is dropped rather than failing the turn, and
 * only the first maxImagesPerTurn are kept.
 */
export function parseImages(value: unknown): VisionImage[] {
  if (!Array.isArray(value)) return [];
  const images: VisionImage[] = [];
  for (const entry of value) {
    if (images.length >= maxImagesPerTurn) break;
    const candidate = entry as { name?: unknown; data?: unknown } | null;
    if (!candidate || typeof candidate.data !== "string") continue;
    const base64 = candidate.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue;
    const data = Buffer.from(base64, "base64");
    if (data.length === 0) continue;
    const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim().slice(0, 120) : "image";
    images.push({ name, data });
  }
  return images;
}

/** Why an image cannot be shown to the model, or null when it can. */
export function imageProblem(image: VisionImage): string | null {
  if (image.data.length === 0) return `"${image.name}" is empty.`;
  if (image.data.length > maxImageBytes) return `"${image.name}" is larger than ${maxImageBytes / 1024 / 1024} MB.`;
  if (!imageKind(image.data)) return `"${image.name}" is not an image the vision model can read (PNG, JPEG, GIF, WebP or BMP).`;
  return null;
}

/**
 * Loads the vision model ahead of a question, so the load happens while the
 * user is still typing. An Ollama request with no prompt loads the model and
 * returns; nothing is generated. Never throws, and false when nothing was
 * loaded - there is no vision model, or Ollama did not answer.
 */
export async function warmVisionModel(
  config: Pick<LocalModelConfig, "baseUrl">,
  options: { fetcher?: Fetcher; model?: string } = {}
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const found = await findVisionModel(config.baseUrl, options.model ?? visionModelName(), fetcher);
  if (!found.model) return false;
  try {
    const response = await fetcher(`${config.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: found.model, keep_alive: visionKeepAlive, options: { num_ctx: visionContextTokens } }),
      signal: AbortSignal.timeout(300_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Asks the vision model about one or more images. Never throws. */
export async function lookAtImages(
  images: VisionImage[],
  question: string,
  config: Pick<LocalModelConfig, "baseUrl" | "timeoutMs">,
  options: { fetcher?: Fetcher; model?: string } = {}
): Promise<VisionResult> {
  if (images.length === 0) return { ok: false, reason: "There was no image to look at." };
  if (images.length > maxImagesPerTurn) return { ok: false, reason: `Up to ${maxImagesPerTurn} images can be looked at at once.` };
  for (const image of images) {
    const problem = imageProblem(image);
    if (problem) return { ok: false, reason: problem };
  }

  const fetcher = options.fetcher ?? fetch;
  const wanted = options.model ?? visionModelName();
  const found = await findVisionModel(config.baseUrl, wanted, fetcher);
  if (!found.reachable) {
    return { ok: false, reason: "The local model service (Ollama) is not answering, so the image could not be looked at. Start Ollama and try again." };
  }
  const model = found.model;
  if (!model) {
    return {
      ok: false,
      reason: `Seeing images needs a vision model, and none is installed in Ollama. Install one with: ollama pull ${wanted}`
    };
  }

  try {
    const response = await fetcher(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        // Room for a large screenshot - the model spends roughly a token per
        // 28x28 pixels, so a 1080p image is about 2,600 tokens - and no more:
        // on an 8 GB card shared with the chat model, every gigabyte of
        // cache spills the image encoder toward system memory. Measured: a
        // small receipt took three minutes to read with 16K and a full card.
        options: { num_ctx: visionContextTokens },
        // Kept loaded for a while, so the next image is answered in seconds
        // rather than after another cold load.
        keep_alive: visionKeepAlive,
        messages: [
          { role: "system", content: visionInstructions },
          { role: "user", content: question.trim() || describeQuestion, images: images.map((image) => image.data.toString("base64")) }
        ]
      }),
      // A cold start loads the model from disk - 73 s measured on a busy card -
      // and the first image after it is slow too: allowed far longer than a reply.
      signal: AbortSignal.timeout(Math.max(config.timeoutMs, 300_000))
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).split("\n")[0].slice(0, 200);
      return { ok: false, reason: `The vision model (${model}) answered ${response.status}${detail ? `: ${detail}` : ""}.` };
    }
    const payload = await response.json() as { message?: { content?: unknown } };
    const text = typeof payload.message?.content === "string" ? payload.message.content.trim() : "";
    return text ? { ok: true, text, model } : { ok: false, reason: `The vision model (${model}) returned nothing.` };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, reason: timedOut ? `The vision model (${model}) did not answer in time.` : "The vision model could not be reached." };
  }
}
