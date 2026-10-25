// The files a chat turn made, so the reply can offer to open them.
//
// A tool that makes a file notes it here against the conversation it ran in;
// the route that answers the turn takes the list and sends it with the reply.
// The same hand-off as how full the model's window was (contextUse.ts): the
// tool and the reply are far apart, and neither should know the other.

const made = new Map<string, string[]>();

/** Most conversations held at once, and most files held for one: a turn that nobody collected from must not grow without end. */
const mostSessions = 100;
const mostFiles = 50;

/** Note files made for a session. `files` are paths in the workspace, as the Files screen speaks them. */
export function noteMadeFiles(sessionId: string | null | undefined, files: string[]): void {
  if (!sessionId || files.length === 0) return;
  const held = made.get(sessionId) ?? [];
  for (const file of files) if (!held.includes(file)) held.push(file);
  made.delete(sessionId);
  made.set(sessionId, held.slice(0, mostFiles));
  while (made.size > mostSessions) made.delete(made.keys().next().value as string);
}

/** The files noted for a session since it was last asked, and forget them. */
export function takeMadeFiles(sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  const held = made.get(sessionId) ?? [];
  made.delete(sessionId);
  return held;
}
