import { selectRelevantMemories, type ScorableMemory } from "./memoryRelevance.js";

// What the assistant can actually do.
//
// A model on its own can only produce text about the world it was trained on.
// Everything this app knows — what you told it to remember, the documents you
// added, what time it is here — is invisible to it unless something hands it
// over. These are the handles: the model asks for what it needs, gets a real
// answer from real storage, and answers from that.
//
// This is where "it can do more" actually comes from. Adding a capability means
// adding a tool here, not retraining anything.
//
// Two rules, both inherited from the rest of this code.
//
// A tool result is never invented. A tool that finds nothing says so, and the
// loop passes that through unchanged, because a model told "no results" will
// say it found nothing while a model told nothing at all will guess.
//
// A tool that changes something reports what it actually changed. The assistant
// spent a long time claiming "Saved." for writes that never happened, and the
// fix was to report outcomes rather than intentions. The same applies here.

/** A tool as the model sees it — the JSON-schema shape Ollama expects. */
export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
};

/** A call the model asked for. */
export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

/** What a tool returns. `ok: false` is a real answer, not an error to hide. */
export type ToolResult = {
  ok: boolean;
  /** Fed back to the model verbatim, so it must read as plain fact. */
  content: string;
};

/**
 * Everything the tools need in order to be real.
 *
 * Injected rather than imported so a test can exercise the loop against known
 * data without a session, a database or a running model.
 */
export type ToolContext = {
  /** Memories available to this session. */
  memories: ScorableMemory[];
  /** Knowledge passages available to this session. */
  knowledge: Array<ScorableMemory & { documentTitle: string }>;
  /** Writes a fact to memory. Returns false when there was nowhere to write. */
  saveMemory?: (fact: string) => boolean;
  /** Overridable so a test can assert on a fixed clock. */
  now?: () => Date;
};

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_memory",
      description:
        "Search what the user has explicitly asked to be remembered. Use this before answering "
        + "anything about the user, their projects, their preferences, or decisions they have made.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in the user's own words." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_documents",
      description:
        "Search the documents the user has added to their knowledge base. Use this for anything "
        + "that would be written down: runbooks, notes, specifications, procedures.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save a fact so it is available in future conversations. Only use this when the user "
        + "states something about themselves or their work that is worth keeping, or asks you to "
        + "remember it. Do not use it to store your own conclusions.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The fact, written as a complete sentence." }
        },
        required: ["fact"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "current_datetime",
      description:
        "The current date and time on the user's machine. Use this for anything involving today, "
        + "now, or how long ago something was — you cannot know it otherwise.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

/** How many results a search hands back before it stops being useful context. */
const searchLimit = 3;

function requireString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Run one tool call.
 *
 * Every failure path returns `ok: false` with a sentence saying what happened,
 * rather than throwing. The model has to be told that a search found nothing —
 * given silence it will fill the gap itself, which is the exact failure this
 * whole codebase is built to avoid.
 */
export function runTool(call: ToolCall, context: ToolContext): ToolResult {
  switch (call.name) {
    case "search_memory": {
      const query = requireString(call.arguments.query);
      if (!query) return { ok: false, content: "search_memory needs a query." };

      const matches = selectRelevantMemories(query, context.memories, searchLimit);
      if (matches.length === 0) {
        return { ok: false, content: `Nothing in the user's saved memory matches "${query}".` };
      }

      return {
        ok: true,
        content: matches.map((entry) => `- ${entry.memory.body}`).join("\n")
      };
    }

    case "search_documents": {
      const query = requireString(call.arguments.query);
      if (!query) return { ok: false, content: "search_documents needs a query." };

      const matches = selectRelevantMemories(query, context.knowledge, searchLimit);
      if (matches.length === 0) {
        return { ok: false, content: `No document passage matches "${query}".` };
      }

      // The source travels with the quote. An answer built on a document should
      // be able to say which document, and it cannot if this drops the title.
      return {
        ok: true,
        content: matches
          .map((entry) => `From "${entry.memory.documentTitle}":\n${entry.memory.body}`)
          .join("\n\n")
      };
    }

    case "remember": {
      const fact = requireString(call.arguments.fact);
      if (!fact) return { ok: false, content: "remember needs a fact to save." };

      if (!context.saveMemory) {
        return { ok: false, content: "There is nowhere to save to, so nothing was saved." };
      }

      const saved = context.saveMemory(fact);
      return saved
        ? { ok: true, content: `Saved: ${fact}` }
        : { ok: false, content: "The save did not go through, so nothing was stored." };
    }

    case "current_datetime": {
      const now = (context.now ?? (() => new Date()))();
      return {
        ok: true,
        content: `${now.toLocaleString(undefined, {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
          hour: "2-digit", minute: "2-digit"
        })} (local time on the user's machine)`
      };
    }

    default:
      // A model can ask for a tool that does not exist. Saying so plainly lets
      // it recover on the next turn; an exception would end the conversation.
      return { ok: false, content: `There is no tool called "${call.name}".` };
  }
}
