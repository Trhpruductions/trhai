// How much of the model's context window the last prompt filled, per session.
//
// Measured where the prompt is actually built (the agent loop sizes it before
// every send, and shortens it to fit), and handed to the route that answers,
// which passes it on with the reply. The figure on screen is then the one the
// model really received - not an estimate made in the browser from the
// visible messages, which leave out the rules, the tools and the memories
// that are most of it.

export type ContextUse = {
  /** The prompt as sent, in tokens: rules, tools, memories, recent messages, the question. */
  promptTokens: number;
  /** The context window the model is run with. */
  windowTokens: number;
};

const lastUse = new Map<string, ContextUse>();
const maxSessions = 1000;

export function recordContextUse(key: string, use: ContextUse): void {
  lastUse.delete(key);
  lastUse.set(key, use);
  while (lastUse.size > maxSessions) {
    const oldest = lastUse.keys().next().value;
    if (oldest === undefined) break;
    lastUse.delete(oldest);
  }
}

/** The last measurement for a session, once: reading it clears it, so it is never shown for a later reply. */
export function takeContextUse(key: string): ContextUse | null {
  const use = lastUse.get(key) ?? null;
  lastUse.delete(key);
  return use;
}
