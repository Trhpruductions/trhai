// The key the model engine is started with, and that every request to it
// carries.
//
// llama.cpp's server answers any page in any browser unless it is given a key:
// it allows every origin, so a site you visit could use your model, load and
// unload models, and keep this PC busy. Started with --api-key, it refuses
// everything but /health without the key. The key is made fresh at each start,
// written beside the engine's process id so a second copy of the app on this PC
// can use the same engine, and never leaves the PC.
//
// TRHAI_ENGINE_API_KEY gives the key of an engine someone else runs
// (TRHAI_ENGINE_URL).

let current: string | null = null;

export function setEngineKey(key: string | null): void {
  current = key && key.trim() ? key.trim() : null;
}

/** The engine's key, or null when it has none (an engine run without one, or none started yet). */
export function engineKey(): string | null {
  return current ?? (process.env.TRHAI_ENGINE_API_KEY?.trim() || null);
}
