// Images attached to a chat message: picked, pasted or dropped, shrunk in the
// browser if they are large, and sent with the message to the local API, which
// shows them to the vision model. A large photo sent as it is would be
// megabytes of base64 for detail the vision model throws away - it shrinks
// anything past about 3 megapixels itself. At 1920 pixels on the long side text
// stays readable, and a 1080p image costs the model 2,691 tokens, measured.

export type Attachment = {
  id: string;
  name: string;
  /** The image as base64, no data: prefix - what the API reads. */
  data: string;
  /** An object URL for the thumbnail; revoke it when the attachment goes. */
  previewUrl: string;
  bytes: number;
};

export const maxAttachments = 4;
/** The longest side an image is sent at. */
export const maxSide = 1920;
/** Above this an image is re-encoded even when it is already small enough on screen. */
export const reencodeAboveBytes = 2_000_000;
export const maxImageFileBytes = 20 * 1024 * 1024;
export const acceptedImageTypes = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
/** What is asked when an image is sent with no words. */
export const defaultImageQuestion = "What's in this image?";

/** The size an image is sent at: within maxSide on its long side, its proportions kept. */
export function scaledSize(width: number, height: number, max = maxSide): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= max || longest <= 0) return { width, height, scaled: false };
  const factor = max / longest;
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), scaled: true };
}

/** Why a file is not attached, or null when it can be. */
export function refuseImage(file: { name: string; type: string; size: number }): string | null {
  if (!acceptedImageTypes.split(",").includes(file.type)) {
    return `"${file.name || "That file"}" is not an image TRH AI can look at (PNG, JPEG, GIF, WebP or BMP).`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > maxImageFileBytes) return `"${file.name}" is larger than ${maxImageFileBytes / 1024 / 1024} MB.`;
  return null;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** An image file made ready to send: shrunk if it is large, and read as base64. Browser only. */
export async function prepareImage(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  const size = scaledSize(bitmap.width, bitmap.height);
  let blob: Blob = file;
  if (size.scaled || file.size > reencodeAboveBytes || file.type === "image/bmp") {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, size.width, size.height);
    blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made ?? file), "image/jpeg", 0.92));
  }
  bitmap.close();
  return {
    id: crypto.randomUUID(),
    name: file.name || "image",
    data: await blobToBase64(blob),
    previewUrl: URL.createObjectURL(blob),
    bytes: blob.size
  };
}
