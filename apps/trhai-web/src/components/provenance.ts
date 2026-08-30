/**
 * Where an answer came from, derived from the tools that actually ran.
 *
 * The most useful thing a reply can tell you is whether it looked anything up.
 * An answer built from your own files and memory and an answer produced from
 * the model's training data look identical on screen, and they are not the
 * same claim — one can be checked against something, the other cannot.
 *
 * Derived from the real tool list rather than declared, so a source can only
 * appear when the tool that reads it genuinely ran. Nothing here can assert a
 * lookup that did not happen.
 */

export type SourceClass = "memory" | "documents" | "workspace" | "web" | "machine" | "built";

/** What each source is called, and the one-line explanation on hover. */
export const sourceLabels: Record<SourceClass, { label: string; hint: string }> = {
  memory: { label: "memory", hint: "Facts you have told TRHAI, read back from this machine." },
  documents: { label: "documents", hint: "Documents in the knowledge base on this machine." },
  workspace: { label: "workspace", hint: "Files read from the workspace on disk." },
  web: { label: "web", hint: "A page fetched from the internet during this turn." },
  machine: { label: "machine", hint: "A command that genuinely ran on this machine." },
  built: { label: "built", hint: "Files written to the workspace during this turn." }
};

/**
 * The source classes behind a reply.
 *
 * Only tools that succeeded count. A search that failed did not provide the
 * answer, and badging it as a source would credit the reply to something that
 * returned nothing — which is worse than showing no badge at all, because it
 * implies the answer was checked when it was not.
 */
export function sourcesFor(
  toolsUsed: Array<{ name: string; ok: boolean }> | undefined
): SourceClass[] {
  if (!toolsUsed?.length) return [];

  const found = new Set<SourceClass>();
  for (const tool of toolsUsed) {
    if (!tool.ok) continue;
    const name = tool.name;

    if (name.includes("memor") || name === "remember" || name === "forget") found.add("memory");
    else if (name.includes("document")) found.add("documents");
    else if (name === "fetch_url") found.add("web");
    else if (name === "run_command") found.add("machine");
    else if (name === "build_app" || name === "write_file") found.add("built");
    else if (name.startsWith("read_") || name.startsWith("list_")) found.add("workspace");
  }

  // A stable order, so the badges under two replies do not shuffle.
  const order: SourceClass[] = ["memory", "documents", "workspace", "web", "machine", "built"];
  return order.filter((source) => found.has(source));
}

/**
 * Whether a reply was produced without consulting anything.
 *
 * Worth saying out loud. "No sources" is not an absence of information, it is
 * the single most important thing to know about an answer: it came from the
 * model itself and there is nothing on this machine backing it up.
 *
 * Deliberately distinguishes "nothing was used" from "we were not told", since
 * a restored message from an earlier session carries no tool list and must not
 * be labelled as unsourced on that account.
 */
export function answeredFromModelAlone(
  toolsUsed: Array<{ name: string; ok: boolean }> | undefined
): boolean {
  return Array.isArray(toolsUsed) && toolsUsed.length === 0;
}

/**
 * Who actually answered, for the line in the footer.
 *
 * The footer said "Answered by general-core-v1" — and there is no such model.
 * That name comes from ModelRouter.pickModel, which labels the deterministic
 * composer path; when it appears, no model ran at all and the reply was
 * assembled from rules and your own stored data. Rendering it in the same
 * sentence as "qwen2.5-coder:7b" made two different things look identical, and
 * the one it flattered is the one that never involved a model.
 *
 * `strategy === "generated"` is the discriminator, and it is a real one:
 * orchestrator.ts sets it in exactly one place, on the path where a model
 * produced the text. Everything the composer returns carries one of its own
 * strategies instead. That is better than sniffing the model name for a
 * prefix, which would quietly start lying the day something other than Ollama
 * is wired in.
 *
 * Returns null when there is nothing honest to say — no reply yet, or a
 * restored turn recorded before strategy was stored. Not knowing is not the
 * same as knowing it was direct, and the caller shows its default line.
 */
export function answerCredit(
  strategy: string | undefined,
  model: string | undefined
): string | null {
  if (!strategy) return null;
  if (strategy === "generated") {
    if (!model) return null;
    return `Answered by ${model.replace(/^ollama\//, "")}`;
  }
  if (strategy === "stopped" || strategy === "error") return null;
  return "Answered directly, without a model";
}
