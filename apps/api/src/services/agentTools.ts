import { selectRelevantMemories, type ScorableMemory } from "./memoryRelevance.js";
import { evaluateArithmetic, formatNumber } from "./arithmetic.js";
import { describeDifference, shiftDate } from "./dateMath.js";
import { generateProject, planProject, slugify } from "@ascend/shared";
import { verifyBuiltProject } from "./buildVerification.js";
import { describeConfirmationNeeded, requiresConfirmation } from "./toolPermissions.js";
import {
  listWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile
} from "./workspace.js";

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
  /**
   * Set when the tool was refused only because it needs the user's
   * confirmation. Distinct from an ordinary failure: nothing was attempted,
   * and the same call would succeed once authorised.
   */
  needsConfirmation?: boolean;
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
  /**
   * Writes a fact to memory.
   *
   * "duplicate" is distinct from a failure: the fact is genuinely already
   * saved, which is a success with nothing left to do, not an error. A tool
   * that could not tell the two apart reported "the save did not go through"
   * for a fact that was, in fact, already there.
   */
  saveMemory?: (fact: string) => "saved" | "duplicate" | "empty";
  /** Removes a saved memory by its id. Returns false when nothing was removed. */
  forgetMemory?: (id: string) => boolean;
  /** Documents in this session, newest first. */
  documents?: Array<{ id: string; title: string; body: string }>;
  /** Saves a new document. Returns false when it could not be stored. */
  saveDocument?: (title: string, body: string) => boolean;
  /** Replaces a document's body by id. Returns false when nothing changed. */
  updateDocument?: (id: string, body: string) => boolean;
  /** Deletes a document by id. Returns false when nothing was deleted. */
  deleteDocument?: (id: string) => boolean;
  /** Pins or unpins a memory by id. Returns false when nothing changed. */
  pinMemory?: (id: string, pinned: boolean) => boolean;
  /**
   * Earlier turns of this conversation, oldest first.
   *
   * Separate from memory: what was said a few messages ago was never saved
   * anywhere, so without this the assistant cannot answer "what did I just
   * ask you" except by whatever happens to be in its context window.
   */
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Tool names the user has explicitly authorised for this turn.
   *
   * Per turn, not stored: an authorisation that outlived the exchange it was
   * given in would mean "yes" to one deletion quietly permitting the next.
   */
  confirmedActions?: ReadonlySet<string>;
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
        "Save a new document to the user's knowledge base, titled in plain language. Use this "
        + "when the user asks you to write something down, take notes, or draft something to keep. "
        + "Not for a file: if the name looks like a filename, such as test.txt, use write_file "
        + "instead — a knowledge document and a workspace file are different places.",
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
      name: "update_document",
      description:
        "Replace the contents of a knowledge-base document that already exists. Use this to "
        + "correct or extend one rather than writing a second document with the same title. Not "
        + "for a file on disk — a name like test.txt is a workspace file; use write_file for that.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The document to change, as listed." },
          content: { type: "string", description: "The full new text. It replaces what was there." }
        },
        required: ["title", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_document",
      description:
        "Delete a document from the knowledge base. Only use this when the user asks for it.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The document to delete, as listed." }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pin_memory",
      description:
        "Mark a saved fact as important, so it is favoured when answering later questions. "
        + "Use it when the user says something matters or should not be forgotten. "
        + "Set pinned to false to undo it.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The saved fact, as it is currently worded." },
          pinned: { type: "boolean", description: "true to mark important, false to unmark." }
        },
        required: ["fact"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_conversation",
      description:
        "Search what has already been said in this conversation. Use this when the user refers "
        + "back to something earlier that was never saved to memory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for in the earlier messages." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "days_between",
      description:
        "How many days apart two dates are. Use this for anything about durations, deadlines or "
        + "how long ago something was — do not count days yourself, you will get it wrong. "
        + "Accepts 2026-08-17, 17 August 2026, today, tomorrow, yesterday.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "The earlier date, or 'today'." },
          to: { type: "string", description: "The other date." }
        },
        required: ["from", "to"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "shift_date",
      description:
        "The date a given number of days before or after another date. Use a negative number to "
        + "go backwards. Use this for questions like 'what date is 90 days from now'.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "The starting date, or 'today'." },
          days: { type: "number", description: "Whole days to add; negative to subtract." }
        },
        required: ["from", "days"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "build_app",
      description:
        "Actually build a small working app from a plain description and write it to the "
        + "workspace. It produces a runnable REST server with a web UI, then starts it and runs "
        + "its own tests before reporting back, so the result you see is verified, not assumed. "
        + "Use this when the user wants something built, not just described.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "What the app should do, in the user's words. If the user gave it a specific name "
              + "(\"build Aurora Notes\"), lead with that exact name — it becomes the app's title. "
              + "A description that only explains the purpose, without the name, builds something "
              + "real but titled generically instead of what the user actually called it."
          }
        },
        required: ["description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List the files in the user's workspace — the folder where apps you build and files you "
        + "write are kept. Use this to see what is already there.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "A subfolder to list. Omit for everything." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the workspace. Use it to look at code you or the user wrote before "
        + "changing or explaining it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path as shown by list_files." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a file into the workspace, creating folders as needed. Use this for code, scripts, "
        + "or anything named like a file, such as test.txt or app.js — not as a knowledge document.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where to write it, relative to the workspace." },
          content: { type: "string", description: "The full contents of the file." }
        },
        required: ["path", "content"]
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
/**
 * Find a document by title: exact match first, then a partial one.
 *
 * The model is repeating a title back from an earlier listing, and it
 * paraphrases. Matching loosely is what makes that survivable; matching an id
 * it invented would act on the wrong document.
 */
function findDocument(context: ToolContext, title: string) {
  const documents = context.documents ?? [];
  const wanted = title.trim().toLowerCase();

  return documents.find((document) => document.title.trim().toLowerCase() === wanted)
    ?? documents.find((document) => document.title.toLowerCase().includes(wanted));
}

/** A refusal that lists what does exist, so the model can correct itself. */
function describeMissingDocument(context: ToolContext, title: string): string {
  const documents = context.documents ?? [];
  const available = documents.length > 0
    ? ` Available documents: ${documents.map((document) => document.title).join(", ")}.`
    : "";
  // Caught live: asked to update "test.txt", update_document correctly found
  // no such document — but "test.txt" was a real workspace file the whole
  // time, and the model recovered by calling write_document instead, which
  // created a stray knowledge entry and left the actual file untouched while
  // the assistant reported the file itself as changed. Checking the real
  // workspace here, rather than guessing from the name, is what lets the
  // refusal point at the tool that would have actually worked.
  const fileHint = readWorkspaceFile(title).ok
    ? ` "${title}" is a real file in the workspace, not a knowledge document — use read_file or `
      + "write_file instead."
    : "";
  return `There is no document called "${title}".${available}${fileHint}`;
}

/** The same exact-then-partial rule, for a saved fact. */
function findMemory(context: ToolContext, fact: string) {
  const wanted = fact.trim().toLowerCase();

  return context.memories.find((memory) => memory.body.trim().toLowerCase() === wanted)
    ?? context.memories.find((memory) => memory.body.toLowerCase().includes(wanted));
}

export async function runTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  // The permission gate, applied once here rather than inside each handler.
  //
  // Every tool call in the app goes through this function, so this is the
  // only place it can be enforced without relying on someone remembering to
  // add a check to a new tool — and permissionLevelOf treats an unclassified
  // tool as destructive, so forgetting fails closed.
  //
  // Refused before the handler runs, not after: a check that happens once the
  // work is done is not a permission system, it is a log.
  // Only registered tools are gated. A name that is not a tool at all is not
  // a permission question — it is a mistake, and must reach the switch's
  // default so the model is told what is actually callable. Without this the
  // fail-closed default treats every hallucinated name as a destructive
  // action awaiting approval, which teaches the model to ask the user to
  // confirm a tool that does not exist.
  const isRegistered = toolDefinitions.some((definition) => definition.function.name === call.name);

  if (isRegistered && requiresConfirmation(call.name) && !context.confirmedActions?.has(call.name)) {
    return { ok: false, content: describeConfirmationNeeded(call.name), needsConfirmation: true };
  }

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

      const outcome = context.saveMemory(fact);

      // "duplicate" first checked myself against context.memories with a
      // simple string match before writing, which missed cases where the
      // model's fact argument was phrased differently from the stored
      // wording even though the store's own fingerprint-based check still
      // caught it as the same fact. The store is the one place that actually
      // knows, so its answer is used instead of a second guess at this layer.
      switch (outcome) {
        case "saved":
          return { ok: true, content: `Saved: ${fact}` };
        case "duplicate":
          return { ok: true, content: `Already saved: ${fact}` };
        case "empty":
          return { ok: false, content: "The save did not go through, so nothing was stored." };
      }
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
      const target = findMemory(context, fact);

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

      const found = findDocument(context, title);
      if (!found) {
        // The available titles come back with the refusal, so the model can
        // correct itself on the next round instead of guessing again.
        return { ok: false, content: describeMissingDocument(context, title) };
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

      // Same check as the missing-document refusal, applied before a write
      // instead of after a miss. Without it, a request naming a real file —
      // "update test.txt" — that the model routes to the wrong tool family
      // does not fail loudly; it quietly creates a same-named document while
      // the file itself is never touched, and the reply claims the file
      // changed. Refusing here is the one place that can still stop it,
      // since write_document does not check for an existing document first.
      if (readWorkspaceFile(title).ok) {
        return {
          ok: false,
          content: `"${title}" is a real file in the workspace, not a knowledge document. Use `
            + "write_file to change it, or read_file to see what it currently contains."
        };
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

    case "update_document": {
      const title = requireString(call.arguments.title);
      const content = requireString(call.arguments.content);
      if (!title || !content) {
        return { ok: false, content: "update_document needs both a title and the new content." };
      }
      if (!context.updateDocument) {
        return { ok: false, content: "There is nowhere to save documents, so nothing was changed." };
      }

      const found = findDocument(context, title);
      if (!found) {
        return { ok: false, content: describeMissingDocument(context, title) };
      }

      // Deliberately does not create on a miss. A model that misremembers a
      // title would otherwise silently make a second document instead of
      // editing the one the user meant.
      const updated = context.updateDocument(found.id, content);
      return updated
        ? { ok: true, content: `Replaced the contents of "${found.title}".` }
        : { ok: false, content: `"${found.title}" could not be changed, so nothing was written.` };
    }

    case "delete_document": {
      const title = requireString(call.arguments.title);
      if (!title) return { ok: false, content: "delete_document needs a title." };
      if (!context.deleteDocument) {
        return { ok: false, content: "There is no knowledge base to delete from, so nothing was removed." };
      }

      const found = findDocument(context, title);
      if (!found) {
        return { ok: false, content: describeMissingDocument(context, title) };
      }

      const deleted = context.deleteDocument(found.id);
      return deleted
        ? { ok: true, content: `Deleted the document "${found.title}".` }
        : { ok: false, content: `"${found.title}" could not be deleted, so nothing was removed.` };
    }

    case "pin_memory": {
      const fact = requireString(call.arguments.fact);
      if (!fact) return { ok: false, content: "pin_memory needs the fact to mark." };
      if (!context.pinMemory) {
        return { ok: false, content: "There is no memory to change, so nothing was marked." };
      }

      // Absent means pin. Unpinning is the rarer request and is always stated.
      const pinned = call.arguments.pinned !== false;

      const target = findMemory(context, fact);
      if (!target) {
        return { ok: false, content: `Nothing saved matches "${fact}", so nothing was marked.` };
      }

      const changed = context.pinMemory(target.id, pinned);
      if (!changed) {
        return { ok: false, content: "That could not be changed, so nothing was marked." };
      }

      return {
        ok: true,
        content: pinned
          ? `Marked as important: ${target.body}`
          : `No longer marked as important: ${target.body}`
      };
    }

    case "search_conversation": {
      const query = requireString(call.arguments.query);
      if (!query) return { ok: false, content: "search_conversation needs a query." };

      const turns = context.conversation ?? [];
      if (turns.length === 0) {
        return { ok: false, content: "Nothing has been said in this conversation yet." };
      }

      // Scored with the same relevance code as everything else, so a search of
      // the transcript behaves like a search of memory rather than like a
      // separate, differently-behaved feature.
      const scorable = turns.map((turn, index) => ({
        id: `turn-${index}`,
        title: turn.role === "user" ? "the user said" : "you said",
        body: turn.content,
        pinned: false,
        createdAt: new Date(index).toISOString()
      }));

      const matches = selectRelevantMemories(query, scorable, searchLimit);
      if (matches.length === 0) {
        return { ok: false, content: `Nothing earlier in this conversation matches "${query}".` };
      }

      return {
        ok: true,
        content: matches
          .map((entry) => `${entry.memory.title}: ${entry.memory.body}`)
          .join("\n\n")
      };
    }

    case "days_between": {
      const from = requireString(call.arguments.from);
      const to = requireString(call.arguments.to);
      if (!from || !to) return { ok: false, content: "days_between needs two dates." };

      const result = describeDifference(from, to, (context.now ?? (() => new Date()))());
      return result.ok
        ? { ok: true, content: result.value }
        : { ok: false, content: result.reason };
    }

    case "shift_date": {
      const from = requireString(call.arguments.from);
      if (!from) return { ok: false, content: "shift_date needs a starting date." };

      const days = typeof call.arguments.days === "number"
        ? call.arguments.days
        : Number(call.arguments.days);

      const result = shiftDate(from, days, (context.now ?? (() => new Date()))());
      return result.ok
        ? { ok: true, content: result.value }
        : { ok: false, content: result.reason };
    }

    case "build_app": {
      const description = requireString(call.arguments.description);
      if (!description) return { ok: false, content: "build_app needs a description." };

      const spec = planProject(description);
      // A calculator has nothing to store by design — spec.entities is
      // empty on purpose, not because nothing was understood. Caught live:
      // this check predates the calculator archetype and does not know
      // about it, so it was rejecting every calculator request on exactly
      // the condition that is normal for one.
      if (spec.kind !== "calculator" && spec.entities.length === 0) {
        return { ok: false, content: "That description does not name anything to store, so there is nothing to build yet." };
      }

      const folder = slugify(spec.title, "app", 60);
      const files = generateProject(spec);

      // Every file is written before anything is reported. A partial write that
      // announced success would leave the user with an app that does not run
      // and a message saying it does.
      const written: string[] = [];
      for (const file of files) {
        const result = writeWorkspaceFile(`${folder}/${file.path}`, file.content);
        if (!result.ok) {
          return {
            ok: false,
            content: `Could not finish building: ${result.reason} Nothing was reported as built.`
          };
        }
        written.push(result.path);
      }

      // Written is not the same as working. Every generated project ships its
      // own smoke test with zero dependencies, so it can be run immediately
      // rather than trusted, rather than merely reported as built. Reporting
      // outcomes rather than intentions is the rule everywhere else in this
      // file; a build is the one action where skipping it is easiest to miss.
      const verification = await verifyBuiltProject(folder);
      const runLine = "Run it with: cd " + folder + " && npm install && npm start";

      if (!verification.ran) {
        return {
          ok: true,
          content: "Built \"" + spec.title + "\" in the workspace at " + folder + "/ with "
            + written.length + " files. Could not verify it automatically: " + verification.reason
            + "\n\n" + runLine
        };
      }

      if (!verification.passed) {
        return {
          ok: false,
          content: "Built \"" + spec.title + "\" at " + folder + "/, but it failed its own checks "
            + "and is not working:\n" + verification.output
            + "\n\nThe files are on disk but the app should not be reported as done."
        };
      }

      return {
        ok: true,
        content: "Built \"" + spec.title + "\" in the workspace at " + folder + "/ with "
          + written.length + " files, and verified it: " + verification.output
          + "\n\n" + runLine
      };
    }

    case "list_files": {
      const directory = typeof call.arguments.directory === "string" && call.arguments.directory.trim()
        ? call.arguments.directory.trim()
        : ".";

      const entries = listWorkspace(directory);
      if (entries === null) {
        return { ok: false, content: "That path is outside the workspace, so it was not listed." };
      }
      if (entries.length === 0) {
        return { ok: false, content: "The workspace is empty." };
      }

      return {
        ok: true,
        content: entries
          .filter((entry) => !entry.directory)
          .map((entry) => `- ${entry.path} (${entry.bytes} bytes)`)
          .join("\n")
      };
    }

    case "read_file": {
      const target = requireString(call.arguments.path);
      if (!target) return { ok: false, content: "read_file needs a path." };

      const result = readWorkspaceFile(target);
      if (!result.ok) return { ok: false, content: result.reason };

      // A truncated read says so. Answering about a file it has only partly
      // seen, with no way for the reader to know, is the failure to avoid.
      return {
        ok: true,
        content: result.truncated
          ? `${result.content}\n\n[truncated - this file is longer than shown]`
          : result.content
      };
    }

    case "write_file": {
      const target = requireString(call.arguments.path);
      const content = typeof call.arguments.content === "string" ? call.arguments.content : null;
      if (!target || content === null) {
        return { ok: false, content: "write_file needs both a path and content." };
      }

      const result = writeWorkspaceFile(target, content);
      return result.ok
        ? { ok: true, content: `Wrote ${result.path} to the workspace.` }
        : { ok: false, content: `${result.reason} Nothing was written.` };
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
      // A model can ask for a tool that does not exist. Saying so plainly,
      // with what is actually callable, lets it pick a real one on the next
      // turn instead of guessing again; an exception would end the conversation.
      return {
        ok: false,
        content: `There is no tool called "${call.name}". Available tools: `
          + `${toolDefinitions.map((definition) => definition.function.name).join(", ")}.`
      };
  }
}
