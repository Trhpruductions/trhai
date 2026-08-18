import { selectRelevantMemories, type ScorableMemory } from "./memoryRelevance.js";
import { evaluateArithmetic, formatNumber } from "./arithmetic.js";
import { planProject } from "@ascend/shared";

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
  /** Removes a saved memory by its id. Returns false when nothing was removed. */
  forgetMemory?: (id: string) => boolean;
  /** Documents in this session, newest first. */
  documents?: Array<{ id: string; title: string; body: string }>;
  /** Saves a new document. Returns false when it could not be stored. */
  saveDocument?: (title: string, body: string) => boolean;
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
      name: "list_memories",
      description:
        "List everything currently saved in memory. Use this when the user asks what you know "
        + "or remember about them, rather than guessing at a search term.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "forget",
      description:
        "Delete a saved memory. Only use this when the user asks you to forget something. "
        + "Find the exact wording with list_memories or search_memory first.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The saved fact to remove, as it is currently worded." }
        },
        required: ["fact"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_documents",
      description: "List the titles of every document in the user's knowledge base.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read a whole document by title. Use this after list_documents when a search result "
        + "was not enough and you need the full text.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The document title, as listed." }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_document",
      description:
        "Save a new document to the user's knowledge base. Use this when the user asks you to "
        + "write something down, take notes, or draft a document they want to keep.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short title." },
          content: { type: "string", description: "The full text of the document." }
        },
        required: ["title", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Work out an arithmetic expression exactly. Use this for any sum — do not do arithmetic "
        + "yourself, you will get it wrong. Supports + - * / % ^ and brackets.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "The expression, for example (12.5 * 3) + 7." }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "plan_app",
      description:
        "Work out what a small app described in plain words would contain — its records, their "
        + "fields, and the screens. Use this when the user describes something they want built.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What the user wants built, in their words." }
        },
        required: ["description"]
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

    case "list_memories": {
      if (context.memories.length === 0) {
        return { ok: false, content: "There is nothing saved in memory yet." };
      }
      return {
        ok: true,
        content: context.memories.map((memory) => `- ${memory.body}`).join("\n")
      };
    }

    case "forget": {
      const fact = requireString(call.arguments.fact);
      if (!fact) return { ok: false, content: "forget needs the fact to remove." };
      if (!context.forgetMemory) {
        return { ok: false, content: "There is no memory to remove from, so nothing was deleted." };
      }

      // Matched against the stored wording rather than trusted as an id: the
      // model is repeating text back, and an id it invented would delete the
      // wrong memory. An unmatched request deletes nothing and says so.
      const target = context.memories.find(
        (memory) => memory.body.trim().toLowerCase() === fact.trim().toLowerCase()
      ) ?? context.memories.find(
        (memory) => memory.body.toLowerCase().includes(fact.trim().toLowerCase())
      );

      if (!target) {
        return { ok: false, content: `Nothing saved matches "${fact}", so nothing was deleted.` };
      }

      const removed = context.forgetMemory(target.id);
      return removed
        ? { ok: true, content: `Deleted from memory: ${target.body}` }
        : { ok: false, content: "The delete did not go through, so nothing was removed." };
    }

    case "list_documents": {
      const documents = context.documents ?? [];
      if (documents.length === 0) {
        return { ok: false, content: "The knowledge base has no documents in it." };
      }
      return {
        ok: true,
        content: documents.map((document) => `- ${document.title}`).join("\n")
      };
    }

    case "read_document": {
      const title = requireString(call.arguments.title);
      if (!title) return { ok: false, content: "read_document needs a title." };

      const documents = context.documents ?? [];
      const found = documents.find(
        (document) => document.title.trim().toLowerCase() === title.trim().toLowerCase()
      ) ?? documents.find(
        (document) => document.title.toLowerCase().includes(title.trim().toLowerCase())
      );

      if (!found) {
        // The available titles come back with the refusal, so the model can
        // correct itself on the next round instead of guessing again.
        const available = documents.length > 0
          ? ` Available documents: ${documents.map((document) => document.title).join(", ")}.`
          : "";
        return { ok: false, content: `There is no document called "${title}".${available}` };
      }

      // Bounded: a long document would crowd out the rest of the exchange, and
      // a truncated read has to say it was truncated.
      const limit = 4000;
      const body = found.body.length > limit
        ? `${found.body.slice(0, limit)}\n\n[truncated — this document is longer than shown]`
        : found.body;

      return { ok: true, content: `"${found.title}":\n${body}` };
    }

    case "write_document": {
      const title = requireString(call.arguments.title);
      const content = requireString(call.arguments.content);
      if (!title || !content) {
        return { ok: false, content: "write_document needs both a title and content." };
      }
      if (!context.saveDocument) {
        return { ok: false, content: "There is nowhere to save documents, so nothing was written." };
      }

      const saved = context.saveDocument(title, content);
      return saved
        ? { ok: true, content: `Saved the document "${title}".` }
        : { ok: false, content: `"${title}" could not be saved, so nothing was written.` };
    }

    case "calculate": {
      const expression = requireString(call.arguments.expression);
      if (!expression) return { ok: false, content: "calculate needs an expression." };

      const result = evaluateArithmetic(expression);
      return result.ok
        ? { ok: true, content: `${expression} = ${formatNumber(result.value)}` }
        : { ok: false, content: result.reason };
    }

    case "plan_app": {
      const description = requireString(call.arguments.description);
      if (!description) return { ok: false, content: "plan_app needs a description." };

      const spec = planProject(description);
      if (spec.entities.length === 0) {
        return { ok: false, content: "That description does not name anything to store yet." };
      }

      const entities = spec.entities
        .map((entity) => `- ${entity.label}: ${entity.fields.map((field) => `${field.name} (${field.type})`).join(", ")}`)
        .join("\n");

      return {
        ok: true,
        content: `"${spec.title}" would hold:\n${entities}\n\n`
          + "The user can build this from the Build screen."
      };
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
