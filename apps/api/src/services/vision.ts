import { deadlineOrStop, stoppedBeforeFinishing, type LocalModelConfig } from "./localModel.js";

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
 * An image's width and height, read from its header, or null when the header
 * cannot be read. Only the header: nothing here decodes pixels.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (length: number) => bytes.length >= length;
  switch (imageKind(bytes)) {
    case "png":
      return has(24) ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    case "gif":
      return has(10) ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null;
    case "bmp":
      return has(26) ? { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) } : null;
    case "webp":
      return webpSize(bytes, view);
    case "jpeg":
      return jpegSize(bytes, view);
    default:
      return null;
  }
}

/** The frame header's size: the first SOF segment, after any number of other segments. */
function jpegSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Padding, and markers that stand alone without a length.
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    // SOF0-SOF15, less the three in that range that are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

/** WebP keeps its size in a different place in each of its three encodings. */
function webpSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8X") {
    const uint24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    return { width: uint24(24) + 1, height: uint24(27) + 1 };
  }
  if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * Roughly the tokens one image costs the vision model: one per 28x28 pixels,
 * up to the most it ever spends on one image - it shrinks anything larger.
 * Measured with qwen2.5vl, the default: 1280x720 took 1,196, 1920x1080 took
 * 2,691, and 3840x2160 took 4,080. An image whose size cannot be read counts
 * as the most.
 */
export function imageTokens(size: { width: number; height: number } | null): number {
  const most = 4096;
  if (!size || size.width <= 0 || size.height <= 0) return most;
  return Math.min(Math.max(1, Math.round(size.width / 28)) * Math.max(1, Math.round(size.height / 28)), most);
}

/**
 * The window to load the vision model with: the smallest that fits these
 * images, the instructions, the question and a full answer - reading out a
 * dense screenshot runs long.
 *
 * One image always fits 8K, the common case and the one the warm-up loads,
 * since a different window makes Ollama load the model again. Several large
 * ones did not: measured, three 1080p screenshots filled an 8K window to its
 * last 81 tokens and the answer miscounted them, and four were refused
 * outright. 16K costs 0.3 GB more than 8K on the card, so it is used only when
 * the images need it.
 */
export function visionWindowFor(images: VisionImage[]): number {
  const answerRoom = 2048;
  const needed = images.reduce((total, image) => total + imageTokens(imageSize(image.data)), 0) + answerRoom;
  return [8192, 16384].find((window) => needed <= window) ?? 32768;
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
      // The window a one-image question asks for, so that question finds the
      // model already loaded as it needs it.
      body: JSON.stringify({ model: found.model, keep_alive: visionKeepAlive, options: { num_ctx: visionWindowFor([]) } }),
      signal: AbortSignal.timeout(300_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The message in an Ollama error body. It nests: the runner's own JSON comes
 * back as a string inside Ollama's, so the useful sentence is two levels down.
 */
function ollamaError(body: string): string {
  let text = body.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const inner = typeof parsed.error === "string" ? parsed.error
        : parsed.error && typeof parsed.error === "object" ? JSON.stringify(parsed.error)
          : typeof parsed.message === "string" ? parsed.message : null;
      if (inner === null) break;
      text = inner.trim();
    } catch {
      break;
    }
  }
  return text.split("\n")[0].slice(0, 200);
}

/**
 * Asks the vision model about one or more images. Never throws.
 *
 * `cancel` is the turn's Stop. Looking can take minutes on a cold card, and
 * Stop has to end that request rather than leave the model reading the
 * images for a reply nobody will see.
 */
export async function lookAtImages(
  images: VisionImage[],
  question: string,
  config: Pick<LocalModelConfig, "baseUrl" | "timeoutMs">,
  options: { fetcher?: Fetcher; model?: string; cancel?: AbortSignal } = {}
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

  // The reply may be as long as the window and no longer, for the reason the
  // chat model's is (see replyLimit in localModel.ts): past it, the images and
  // the question have been pushed out of the model's view.
  const windowTokens = visionWindowFor(images);
  try {
    const response = await fetcher(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        options: { num_ctx: windowTokens, num_predict: windowTokens },
        // Kept loaded for a while, so the next image is answered in seconds
        // rather than after another cold load.
        keep_alive: visionKeepAlive,
        messages: [
          { role: "system", content: visionInstructions },
          { role: "user", content: question.trim() || describeQuestion, images: images.map((image) => image.data.toString("base64")) }
        ]
      }),
      // A cold start loads the model from disk - 73 s measured on a busy card -
      // and the first image after it is slow too: allowed far longer than a
      // reply. Stop ends it sooner.
      signal: deadlineOrStop(Math.max(config.timeoutMs, 300_000), options.cancel)
    });
    if (!response.ok) {
      const detail = ollamaError(await response.text().catch(() => ""));
      if (/exceeds the available context size/i.test(detail)) {
        return { ok: false, reason: "Those images are too large together for the vision model to take in at once. Try fewer of them, or smaller ones." };
      }
      return { ok: false, reason: `The vision model (${model}) answered ${response.status}${detail ? `: ${detail}` : ""}.` };
    }
    const payload = await response.json() as { message?: { content?: unknown }; done_reason?: unknown };
    // Cut off at that limit, not finished: a description that never ended is
    // not shown as one.
    if (payload.done_reason === "length") {
      return {
        ok: false,
        reason: `The vision model (${model}) ran past the length limit (${windowTokens.toLocaleString("en-US")} tokens) without finishing its reply.`
      };
    }
    const text = typeof payload.message?.content === "string" ? payload.message.content.trim() : "";
    return text ? { ok: true, text, model } : { ok: false, reason: `The vision model (${model}) returned nothing.` };
  } catch (error) {
    // Stopped, which is not the model failing to answer in time.
    if (options.cancel?.aborted) return { ok: false, reason: stoppedBeforeFinishing };
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, reason: timedOut ? `The vision model (${model}) did not answer in time.` : "The vision model could not be reached." };
  }
}
