import { blobToBase64, scaledSize, type Attachment } from "./imageAttach";

// A picture of the screen, for a question about what is on it.
//
// Taken only when the user asks about their screen or presses SCREEN, and
// sent with that one message to the local API and the local vision model.
// Nothing is saved, and nothing leaves the machine.
//
// Inside the desktop app it is every screen, taken by the app itself with its
// own window left out (see ascend:capture-screens in apps/desktop). In a
// browser it is whatever the user picks in the browser's own share prompt -
// a page cannot take a picture of the screen any other way, and should not.

/** The desktop app's bridge, when this page is running inside it. */
type DesktopBridge = {
  captureScreens?: () => Promise<
    { ok: true; screens: Array<{ name: string; data: string }> } | { ok: false; error?: string }
  >;
};

/**
 * The longest side a screen is sent at. Past about 3 megapixels the vision
 * model shrinks an image itself, so 2560 keeps every pixel it would use.
 */
export const maxScreenSide = 2560;

export type ScreenShare = { ok: true; shots: Attachment[] } | { ok: false; reason: string };

export const screenNotShared = "The screen wasn't shared, so there was nothing to look at. Press SCREEN to pick what to share, then ask again.";

function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { ascendDesktop?: DesktopBridge }).ascendDesktop;
}

/** Whether this page can share the screen at all. */
export function canShareScreen(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(desktopBridge()?.captureScreens || navigator.mediaDevices?.getDisplayMedia);
}

/**
 * The screen, ready to send. Call it straight from a click or a key press: a
 * browser shows its share prompt only in answer to one.
 */
export async function shareScreen(): Promise<ScreenShare> {
  const desktop = desktopBridge();
  if (desktop?.captureScreens) {
    const result = await desktop.captureScreens().catch(() => null);
    if (!result || !result.ok) return { ok: false, reason: `The screen could not be captured${result?.error ? `: ${result.error}` : "."}` };
    return { ok: true, shots: result.screens.map((screen) => attachmentFromBase64(screen.name, screen.data)) };
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    return { ok: false, reason: "This browser can't share the screen. Use the TRH AI app, or attach a screenshot with VISION." };
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    // Cancelled in the prompt, or asked for without a click to answer.
    return { ok: false, reason: screenNotShared };
  }
  try {
    return { ok: true, shots: [await grabFrame(stream)] };
  } catch {
    return { ok: false, reason: "The shared screen sent no picture. Try again." };
  } finally {
    // One picture, then the share ends: the browser's "sharing" bar goes away.
    for (const track of stream.getTracks()) track.stop();
  }
}

/** One frame of a shared screen, as an attachment. */
async function grabFrame(stream: MediaStream): Promise<Attachment> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    // The first frames can arrive before the picture does; wait for one that
    // has a size.
    for (let tries = 0; tries < 20 && (video.videoWidth === 0 || video.videoHeight === 0); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error("no frame");
    const size = scaledSize(video.videoWidth, video.videoHeight, maxScreenSide);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d")?.drawImage(video, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("no frame");
    return { id: crypto.randomUUID(), name: "screen.jpg", data: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob), bytes: blob.size };
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

function attachmentFromBase64(name: string, data: string): Attachment {
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  const blob = new Blob([bytes], { type: "image/jpeg" });
  return { id: crypto.randomUUID(), name, data, previewUrl: URL.createObjectURL(blob), bytes: blob.size };
}
