import { randomUUID } from "node:crypto";
import { selectRelevantMemories, type ScorableMemory } from "./memoryRelevance.js";
import { evaluateArithmetic, formatNumber } from "./arithmetic.js";
import { describeDifference, shiftDate } from "./dateMath.js";
import { classifyRequest, deriveTitle, generateProject, planProject, slugify } from "@ascend/shared";
import { authorPrompt, findAppFault, parseAuthoredFiles, type AuthoredFile } from "./appAuthor.js";
import { verifyBuiltProject } from "./buildVerification.js";
import { describeConfirmationNeeded, requiresConfirmation } from "./toolPermissions.js";
import {
  listDirectoryAt,
  listWorkspace,
  readFileAt,
  readWorkspaceFile,
  resolveInWorkspace,
  writeFileAt,
  writeWorkspaceFile
} from "./workspace.js";
import { fetchWebPage } from "./webFetch.js";
import { commandsArmed, describeRun, runCommand } from "./commandRunner.js";
import { resolveForAccess } from "./machinePaths.js";
import { explainMiss } from "./projectContext.js";
import { noteProjectTouched, withinActiveProject } from "./activeProject.js";
import { applyEdit, describeEdit } from "./fileEdit.js";
import { beginEvent, endEvent, recordEvent } from "./executionLog.js";
import { enterStage } from "./reasoningStage.js";
import {
  addSchedule, describeAction, describeCadence, listSchedules, type Cadence
} from "./scheduleStore.js";

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
   * What the user actually asked for, in their own words.
   *
   * Used to name a built app. build_app is handed a `description` written by
   * the model, and the model writes descriptions as behaviour rather than as
   * names - so "build me a calculator" arrived as "performs basic arithmetic
   * operations like addition" and the app was filed under
   * performs-basic-arithmetic-operations-like, which is also its browser tab
   * and page heading.
   *
   * Chasing that with phrasing rules does not converge; there is always
   * another way to describe what an app does. The user's own sentence names
   * the thing, so the title comes from there when it yields something usable
   * and falls back to the description when it does not.
   */
  request?: string;
  /**
   * Tool names the user has explicitly authorised for this turn.
   *
   * Per turn, not stored: an authorisation that outlived the exchange it was
   * given in would mean "yes" to one deletion quietly permitting the next.
   */
  confirmedActions?: ReadonlySet<string>;
  /**
   * True when this turn runs with nobody watching — a schedule firing in the
   * background rather than someone at the machine.
   *
   * Command access is withheld whatever the arming window says. Switching
   * machine control on is a grant for working at the machine, and a scheduled
   * run must not inherit it because the window happens to still be open when
   * the timer fires. Checked here as well as at the tool list, so a call the
   * model writes as text rather than through the interface is caught too.
   */
  unattended?: boolean;
  /**
   * The session this turn belongs to, so each step can be recorded against it
   * as it happens.
   *
   * Optional throughout: without it the tools work exactly as before and
   * simply record nothing. A trace is for watching the work, not for the work
   * being correct, and a test exercising a tool should not need a session to
   * do it.
   */
  sessionId?: string;
  /** Overridable so a test can assert on a fixed clock. */
  now?: () => Date;
  /**
   * Overridable so a test can exercise fetch_url's dispatch without a real
   * network call — real fetchWebPage, with its own SSRF and size/timeout
   * defences, when nothing is supplied.
   */
  fetchPage?: typeof fetchWebPage;
  /**
   * Asks the local model to write an application, for requests that are not one
   * of the two shapes the templates cover.
   *
   * Optional, and its absence is a real state rather than a configuration
   * error: with no model running there is nothing to author with, and
   * build_app says so instead of falling back to a records app that would be
   * the wrong thing built confidently.
   */
  authorApp?: (description: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
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
        "List files. Omit the directory for the workspace — the folder where apps you build are "
        + "kept. Pass a full path such as D:/projects/app to look inside a real project on this "
        + "machine when machine access is on. Use this to find out what is actually there before "
        + "guessing at filenames.",
      parameters: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description:
              "A workspace subfolder, or a full path to a folder anywhere on this machine. "
              + "Omit for the whole workspace."
          }
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
        "Read a file. Use it to look at code before changing or explaining it. Accepts a "
        + "workspace path, or a full path to anywhere on this machine such as "
        + "D:/projects/app/src/index.ts when machine access is on. Never answer questions about "
        + "the contents of a file without reading it first.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "A workspace path, or a full path to a file anywhere on this machine."
          }
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
        "Write a file, creating folders as needed. Use this for code, scripts, or anything named "
        + "like a file, such as test.txt or app.js — not as a knowledge document. Accepts a "
        + "workspace path, or a full path to anywhere on this machine when machine access is on, "
        + "so it can edit a real project in place. Writing replaces the whole file, so read it "
        + "first and send back the complete updated contents rather than only the changed part.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "A workspace path, or a full path to a file anywhere on this machine."
          },
          content: { type: "string", description: "The full contents of the file." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Change part of an existing file by replacing exact text, leaving the rest untouched. "
        + "Prefer this over write_file for any file that already exists: write_file replaces the "
        + "whole file, so anything you do not repeat is deleted. Read the file first and copy the "
        + "lines to change verbatim, including indentation. The text must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "A workspace path, or a full path to a file anywhere on this machine."
          },
          old_text: {
            type: "string",
            description: "The exact text to replace, copied from the file including indentation."
          },
          new_text: { type: "string", description: "What to put in its place." }
        },
        required: ["path", "old_text", "new_text"]
      }
    }
  },
  // The app has a scheduler. The assistant could not reach it.
  //
  // Asked "remind me every day at 9am to check the build", it called no tool
  // and explained how to use Windows Task Scheduler. Asked "what schedules do
  // I have?", it answered "I do not have access to information about your
  // personal schedule" - which is false: the schedules live in this process,
  // behind /v1/schedules, and the interface lists them. An assistant denying a
  // capability the app plainly has is the same failure as claiming one it
  // lacks, pointed the other way.
  {
    type: "function",
    function: {
      name: "list_schedules",
      description: "List the user's saved schedules - what runs, how often, and whether it "
        + "is enabled. Use this whenever they ask what is scheduled.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "add_schedule",
      description: "Save a recurring schedule that asks the assistant something on a cadence. "
        + "Use it when the user asks to be reminded of something, or for something to happen "
        + "daily or every so many minutes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short name for the schedule." },
          prompt: { type: "string", description: "What to ask the assistant when it fires." },
          daily_at: { type: "string", description: "A 24-hour time like 09:00 to run once a day." },
          every_minutes: { type: "string", description: "Run every N minutes instead of daily." }
        },
        required: ["name", "prompt"]
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
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Read a web page and return its text. This is the only tool that reaches the internet — "
        + "use it when the user gives you a URL, or asks about something that needs a live page "
        + "you were not given a link for as text some other way. It fetches exactly the one address "
        + "you give it; it does not search, and there is no way to look something up without "
        + "already having a URL for it.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full address, including https://." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a command on the user's machine and get back its real output and exit code. Use this "
        + "for anything outside the workspace: installing packages, running builds and tests, "
        + "opening applications, inspecting the system. The command runs as the user, so it can do "
        + "anything they can do — say what you are about to run and why. Report failures as "
        + "failures: a non-zero exit code means it did not work, whatever the output says.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The exact command line to run, as the user would type it in a terminal."
          },
          reason: {
            type: "string",
            description: "One short line on what this is for, shown to the user in the run log."
          }
        },
        required: ["command"]
      }
    }
  }
];

/**
 * The tools actually offered on a given turn.
 *
 * run_command is withheld entirely while disarmed rather than being offered
 * and then refused. A model that can see a tool will reason about it, mention
 * it, and try to talk its way into it; one that never sees it cannot. This is
 * the same reason the capability report reads from the registry — what is
 * described and what is enforced have to be the same thing.
 */
/**
 * Tools that create a whole project, as opposed to answering about one.
 *
 * Withheld from questions. See the note on isExplanatoryQuestion: "explain how
 * promises work in javascript" reached for build_app and scaffolded a five-file
 * app into the workspace. Checking the reply afterwards cannot help, because by
 * then the directory exists - the only effective place to stop it is before the
 * tool is offered.
 */
const scaffoldingTools = new Set(["build_app", "plan_app"]);

/**
 * Tools that act on the machine, withheld when the request was only to look.
 *
 * Asked to "read server.js from the calculator app", the model read it and
 * then made three write_file calls, reporting "app.js has been written to the
 * workspace". Nobody asked for a file. An earlier run did the same thing with
 * run_command, inventing a path for it. Reading is reading.
 *
 * Safe to gate on because of the order actionIntent checks its verb groups in:
 * write is tested before read, so "read config.json and update the port"
 * classifies as write and keeps every one of these. Only a request with
 * nothing but a read verb in it lands here.
 *
 * Memory is deliberately not in this set. remember and forget act on the
 * conversation rather than on the machine, and "read notes.txt and remember
 * the port" is an ordinary thing to ask.
 */
const machineChangingTools = new Set([
  "write_file", "edit_file", "build_app", "plan_app", "run_command", "run_script"
]);

/**
 * Name a built app after what the user asked for, not the model's paraphrase.
 *
 * build_app's `description` is written by the model, and models describe an app
 * by what it does: "build me a calculator" arrived as "performs basic
 * arithmetic operations like addition", and the project was filed under
 * performs-basic-arithmetic-operations-like - which is the folder, the browser
 * tab and the page heading. Stripping those lead-ins by pattern does not
 * converge; there is always another way to phrase behaviour.
 *
 * The user's sentence names the thing, so it wins whenever it produces a real
 * name. It does not always: "build me an app" derives "App", which distinguishes
 * nothing, and there the model's fuller description is genuinely better. The
 * test is whether the derived title survives being a bare container noun.
 */
function titledFromRequest<T extends { title: string }>(spec: T, request?: string): T {
  if (!request?.trim()) return spec;

  const fromRequest = deriveTitle(request);
  if (!fromRequest) return spec;

  // "App", "Tool", "Project" - a name that names nothing. Keep the model's.
  if (/^(app|application|tool|system|program|platform|service|site|website|project|thing)$/i
    .test(fromRequest.trim())) {
    return spec;
  }

  return { ...spec, title: fromRequest };
}

/**
 * The verdict, not just the detail.
 *
 * summarize() in buildVerification returns "no output" when a smoke test exits
 * 0 without printing anything - which is a pass, decided by the exit code. The
 * reply rendered that as "verified it: no output", which reads like the
 * verification did nothing. A countdown timer that genuinely built, served
 * HTTP 200 and rendered its own UI was described in words that gave no reason
 * to believe any of it.
 */
export function verifiedDetail(output: string): string {
  return output === "no output" ? "its own checks passed, without printing anything" : output;
}

export function availableTools(
  armed: boolean,
  options: { scaffolding?: boolean; changes?: boolean } = {}
): ToolDefinition[] {
  const allowScaffolding = options.scaffolding ?? true;
  const allowChanges = options.changes ?? true;

  return toolDefinitions.filter((definition) => {
    const name = definition.function.name;
    if (!armed && name === "run_command") return false;
    if (!allowScaffolding && scaffoldingTools.has(name)) return false;
    if (!allowChanges && machineChangingTools.has(name)) return false;
    return true;
  });
}

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

  // Switching machine control on IS the authorisation for run_command.
  //
  // Asking again per command would make the switch pointless: the user has
  // just made an explicit, scoped, expiring grant, and answering "are you
  // sure" to every line afterwards is the same question twice. It is also how
  // a confirmation prompt stops being read — a dialog that appears on every
  // command is one people click through without looking, which is worse than
  // one clear decision up front.
  //
  // The grant stays bounded by everything around it: it lapses on its own, it
  // is visible on the front screen while it is on, and every command that
  // runs is recorded with its output. Other level-3 tools are unaffected —
  // forget and delete_document still ask.
  // Refused before the confirmation gate, and for a different reason. Falling
  // through to "ask the user to confirm" would be nonsense on a scheduled run
  // — there is nobody there to ask — and worse, it implies a confirmation
  // would let it through, which nothing can.
  if (call.name === "run_command" && context.unattended) {
    return {
      ok: false,
      content: "Nothing was run. This is a scheduled run with nobody watching, and command access "
        + "is only ever granted for working at the machine — it cannot be confirmed into being "
        + "here. Say what you would have run and why."
    };
  }

  const preAuthorised = call.name === "run_command" && commandsArmed();

  if (isRegistered && requiresConfirmation(call.name)
    && !preAuthorised && !context.confirmedActions?.has(call.name)) {
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

      const spec = titledFromRequest(planProject(description), context.request);

      // Which of the two templates this is, or neither.
      //
      // It used to be neither question nor choice: every request became a
      // records app, because entity extraction always finds a noun. "A snake
      // game" became a REST API storing `game` records and passed its own
      // smoke checks doing it. The template never fails at being a template,
      // which is exactly why nothing reported the app was wrong.
      const namedFields = spec.entities.some((entity) =>
        entity.fields.some((field) => !["title", "description"].includes(field.name)));
      // Classified from what the user asked for, then from the description.
      //
      // Same root cause as the title above: `description` is the model's
      // paraphrase, and a paraphrase loses the word that decides the shape.
      // "build me a calculator" arrived as "performs basic arithmetic
      // operations like addition" - which names no calculator, so it was not
      // classified as one, and a request that stores nothing was sent down the
      // path that builds a store.
      //
      // The request cannot simply win, though: "authored" is the fallback the
      // classifier returns when it recognises nothing, and a short request
      // ("build me a plant diary") lands there while the model's fuller
      // description names the tracker and the fields outright. So the specific
      // answer wins wherever it comes from, and only a request that actually
      // decides something overrules the description.
      const askedFor = context.request?.trim();
      const fromRequest = askedFor ? classifyRequest(askedFor, namedFields) : "authored";
      const archetype = fromRequest !== "authored"
        ? fromRequest
        : classifyRequest(description, namedFields);

      let files: AuthoredFile[];
      let folder: string;

      if (archetype === "authored") {
        if (!context.authorApp) {
          return {
            ok: false,
            content: "That is not a records app or a calculator, so it needs the local model to write it "
              + "- and no model is available. Start the model and ask again."
          };
        }

        // Tried more than once, because the generation is genuinely random.
        //
        // Measured over three runs of the same request: one reply could not be
        // parsed, one produced files that did not run, and one produced a
        // working game. One attempt would therefore fail most of the time on a
        // request the model is perfectly capable of. Each attempt is recorded,
        // so a build that took three goes says so rather than looking clean.
        const attempts = 3;
        let authoredFiles: AuthoredFile[] | null = null;
        let lastFault = "";

        for (let attempt = 1; attempt <= attempts && !authoredFiles; attempt += 1) {
          const tryEvent = beginEvent(context.sessionId, "create",
            `Writing the app${attempt > 1 ? ` (attempt ${attempt})` : ""}`);

          const authored = await context.authorApp(authorPrompt(description));
          if (!authored.ok) {
            lastFault = authored.reason;
            endEvent(context.sessionId, tryEvent, "failed", lastFault);
            continue;
          }

          const parsed = parseAuthoredFiles(authored.text);
          if (!parsed.ok) {
            lastFault = parsed.reason;
            endEvent(context.sessionId, tryEvent, "failed", lastFault);
            continue;
          }

          // Compiled, never run: generated code has not earned the right to
          // execute, and the machine-access switch that governs running things
          // is off by default. This catches the breakage that is detectable
          // without running - a file that does not parse, and the server that
          // exits the moment it starts.
          const fault = findAppFault(parsed.files);
          if (fault) {
            lastFault = fault;
            endEvent(context.sessionId, tryEvent, "failed", lastFault);
            continue;
          }

          authoredFiles = parsed.files;
          endEvent(context.sessionId, tryEvent, "ok", `${parsed.files.length} files`);
        }

        if (!authoredFiles) {
          return {
            ok: false,
            content: `I could not write that app. ${attempts} attempts were made and the last failed because `
              + `${lastFault}. Nothing was written.`
          };
        }

        files = authoredFiles;
        folder = slugify(spec.title, "app", 60);
      } else {
        // A calculator has nothing to store by design — spec.entities is
        // empty on purpose, not because nothing was understood. Caught live:
        // this check predates the calculator archetype and does not know
        // about it, so it was rejecting every calculator request on exactly
        // the condition that is normal for one.
        if (archetype !== "calculator" && spec.entities.length === 0) {
          return { ok: false, content: "That description does not name anything to store, so there is nothing to build yet." };
        }

        folder = slugify(spec.title, "app", 60);
        files = generateProject(archetype === "calculator" ? { ...spec, kind: "calculator" } : spec);
      }

      // Recorded as it happens, not described in advance. Each event is
      // written by the code that does the thing, at the moment it does it, so
      // the trace cannot claim a step that did not run.
      const { sessionId } = context;
      recordEvent(sessionId, "plan", `Planned "${spec.title}"`, "ok",
        `${files.length} files, ${spec.entities.length} record type${spec.entities.length === 1 ? "" : "s"}`);

      // Every file is written before anything is reported. A partial write that
      // announced success would leave the user with an app that does not run
      // and a message saying it does.
      const writing = beginEvent(sessionId, "write", `Writing ${files.length} files`);
      const written: string[] = [];
      for (const file of files) {
        const result = writeWorkspaceFile(`${folder}/${file.path}`, file.content);
        if (!result.ok) {
          // The count is what actually landed before it stopped, not the total
          // it set out to write.
          endEvent(sessionId, writing, "failed",
            `${result.reason} ${written.length} of ${files.length} files were written.`);
          return {
            ok: false,
            content: `Could not finish building: ${result.reason} Nothing was reported as built.`
          };
        }
        written.push(result.path);
      }
      endEvent(sessionId, writing, "ok", `${written.length} files`, `${folder}/`);

      // Written is not the same as working. Every generated project ships its
      // own smoke test with zero dependencies, so it can be run immediately
      // rather than trusted, rather than merely reported as built. Reporting
      // outcomes rather than intentions is the rule everywhere else in this
      // file; a build is the one action where skipping it is easiest to miss.
      // Verifying is a stage of its own, entered where verification really
      // begins — not announced when the build was requested.
      enterStage(sessionId, "verifying");
      const verifying = beginEvent(sessionId, "verify", "Running its own checks");
      const verification = await verifyBuiltProject(folder);
      // No install step, because there is nothing to install.
      //
      // This said "npm install && npm start" for every build, and the generated
      // package.json has no dependencies field at all - that is the entire
      // point of these projects, and findForeignImport now enforces it. So the
      // instruction was telling you to run a command that does nothing, while
      // implying the app needs fetching something before it will start. On a
      // machine that is offline, or where npm is having a bad day, it would
      // fail and make a working app look broken.
      const runLine = "Run it with: cd " + folder + " && npm start";

      // Three outcomes, kept distinct. "Could not check" is not "passed", and
      // reporting it as either would be the kind of quiet rounding-up this
      // whole trace exists to make impossible.
      endEvent(
        sessionId,
        verifying,
        !verification.ran ? "skipped" : verification.passed ? "ok" : "failed",
        verification.ran ? verification.output : verification.reason
      );

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

      // A build you just asked for is the project you are working in.
      noteProjectTouched(context.sessionId, folder);

      return {
        ok: true,
        content: "Built \"" + spec.title + "\" in the workspace at " + folder + "/ with "
          + written.length + " files, and verified it: " + verifiedDetail(verification.output)
          + "\n\n" + runLine
      };
    }

    case "list_files": {
      const directory = typeof call.arguments.directory === "string" && call.arguments.directory.trim()
        ? call.arguments.directory.trim()
        : ".";

      // Anywhere on the disk once machine access is granted, as read_file and
      // write_file already are. Without this the assistant could open and edit
      // a file in a project but not see what was in the folder - able to work
      // on a codebase only if told every filename in advance.
      const verdict = resolveForAccess(directory, {
        granted: commandsArmed() && !context.unattended,
        intent: "read",
        insideWorkspace: resolveInWorkspace
      });
      if (!verdict.ok) return { ok: false, content: verdict.reason };

      const inWorkspace = resolveInWorkspace(directory) === verdict.path;
      const entries = inWorkspace ? listWorkspace(directory) : listDirectoryAt(verdict.path);

      if (entries === null) {
        return { ok: false, content: `There is no folder at ${directory}.` };
      }
      if (entries.length === 0) {
        return { ok: false, content: inWorkspace ? "The workspace is empty." : `${directory} is empty.` };
      }

      const files = entries.filter((entry) => !entry.directory);
      const shown = files.slice(0, 200);
      const listing = shown.map((entry) => `- ${entry.path} (${entry.bytes} bytes)`).join("\n");

      // Says when it is showing part of a folder. A truncated listing that
      // looks complete is how "that file does not exist" gets said about a
      // file that does.
      return {
        ok: true,
        content: files.length > shown.length
          ? `${listing}\n\n[showing ${shown.length} of ${files.length} files, newest first]`
          : listing
      };
    }

    case "read_file": {
      const target = requireString(call.arguments.path);
      if (!target) return { ok: false, content: "read_file needs a path." };

      // A URL is not a file, and saying so is the whole fix.
      //
      // "fetch https://example.com and tell me what it says" called read_file,
      // which resolved the address as a relative path and reported "There is
      // no file at D:\Vexora\workspace\example.com". The model then wrote
      // "Did you mean to use fetch_url instead?" to the user - it knew, and
      // still did not do it. The prompt already describes fetch_url; another
      // sentence there would not have helped.
      //
      // Refused here rather than resolved, because the tool result is what the
      // model reads next, and a refusal that names the right tool is a move it
      // can make.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        return {
          ok: false,
          content: `"${target}" is a URL, not a file on this machine. `
            + "Use fetch_url for an address; read_file only opens files."
        };
      }

      // Anywhere on the disk once machine access is granted, the workspace
      // otherwise. run_command could always reach the whole filesystem, so a
      // sandboxed reader beside an unsandboxed shell was never a boundary -
      // only an obstruction with a shell-shaped hole in it.
      const verdict = resolveForAccess(target, {
        // Not granted to a run nobody is watching, whatever the arming window
        // says - the same rule run_command already follows. Switching machine
        // control on is a grant for working at the machine, and a schedule
        // firing at 3am must not inherit it because the window is still open.
        granted: commandsArmed() && !context.unattended,
        intent: "read",
        insideWorkspace: resolveInWorkspace
      });
      if (!verdict.ok) return { ok: false, content: verdict.reason };

      let result = readFileAt(verdict.path);

      // A bare filename means the project this session is working in.
      //
      // "read the smoke test" right after reading calculator/server.js came
      // through as a name with no directory. The prompt says which project is
      // current and the model does not reliably use it, so the resolution
      // happens here instead of being asked for again.
      if (!result.ok) {
        const inProject = withinActiveProject(context.sessionId, target);
        if (inProject) {
          const retry = resolveForAccess(inProject, {
            granted: commandsArmed() && !context.unattended,
            intent: "read",
            insideWorkspace: resolveInWorkspace
          });
          if (retry.ok) {
            const second = readFileAt(retry.path);
            if (second.ok) result = second;
          }
        }
      }

      if (result.ok) noteProjectTouched(context.sessionId, target);
      // A miss that names what does exist. "There is no file at
      // calculator/public/server.js" is true and a dead end: the model guessed
      // a subdirectory, was told no, said it would try the main directory, and
      // then stopped. Naming the real path turns that into a recovery.
      if (!result.ok) return { ok: false, content: explainMiss(result.reason, target) };

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

      const verdict = resolveForAccess(target, {
        // As above: an unattended run stays in the workspace.
        granted: commandsArmed() && !context.unattended,
        intent: "write",
        insideWorkspace: resolveInWorkspace
      });
      if (!verdict.ok) return { ok: false, content: `${verdict.reason} Nothing was written.` };

      const result = writeFileAt(verdict.path, content);
      if (!result.ok) return { ok: false, content: `${result.reason} Nothing was written.` };

      // Named the way the user asked for it. A file in the workspace reports
      // the short path they typed; one outside reports where it actually
      // landed, because "wrote config.json" is not enough information when
      // that could have been anywhere on the disk.
      const inWorkspace = resolveInWorkspace(target);
      noteProjectTouched(context.sessionId, target);
      return {
        ok: true,
        content: inWorkspace === result.path
          ? `Wrote ${target} to the workspace.`
          : `Wrote ${result.path}.`
      };
    }

    case "edit_file": {
      const target = requireString(call.arguments.path);
      const oldText = typeof call.arguments.old_text === "string" ? call.arguments.old_text : null;
      const newText = typeof call.arguments.new_text === "string" ? call.arguments.new_text : null;
      if (!target || oldText === null || newText === null) {
        return { ok: false, content: "edit_file needs a path, old_text and new_text." };
      }

      // Read and write are checked separately with the same rule, so an edit
      // cannot reach anywhere a read or a write could not.
      const readVerdict = resolveForAccess(target, {
        granted: commandsArmed() && !context.unattended,
        intent: "read",
        insideWorkspace: resolveInWorkspace
      });
      if (!readVerdict.ok) return { ok: false, content: `${readVerdict.reason} Nothing was changed.` };

      const writeVerdict = resolveForAccess(target, {
        granted: commandsArmed() && !context.unattended,
        intent: "write",
        insideWorkspace: resolveInWorkspace
      });
      if (!writeVerdict.ok) return { ok: false, content: `${writeVerdict.reason} Nothing was changed.` };

      const current = readFileAt(readVerdict.path);
      if (!current.ok) return { ok: false, content: `${current.reason} Nothing was changed.` };

      // A file too long to have been read whole must not be edited: the copy
      // in hand is missing its end, and writing it back would delete the part
      // that was never seen.
      if (current.truncated) {
        return {
          ok: false,
          content: `${target} is longer than I can read in one go, so editing it here would `
            + "discard the part I cannot see. Nothing was changed."
        };
      }

      const edited = applyEdit(current.content, oldText, newText);
      if (!edited.ok) return { ok: false, content: `${edited.reason} Nothing was changed.` };

      const written = writeFileAt(writeVerdict.path, edited.content);
      if (!written.ok) return { ok: false, content: `${written.reason} Nothing was changed.` };

      noteProjectTouched(context.sessionId, target);
      return { ok: true, content: `Edited ${written.path} — ${describeEdit(oldText, newText)}.` };
    }

    case "list_schedules": {
      const saved = listSchedules();
      if (saved.length === 0) {
        return { ok: true, content: "Nothing is scheduled." };
      }
      const lines = saved.map((entry) =>
        `- ${entry.name}: ${describeCadence(entry.cadence)}`
        + `${entry.enabled ? "" : " (paused)"} - ${describeAction(entry.action)}`);
      return { ok: true, content: lines.join("\n") };
    }

    case "add_schedule": {
      const name = requireString(call.arguments.name);
      const prompt = requireString(call.arguments.prompt);
      if (!name || !prompt) {
        return { ok: false, content: "add_schedule needs a name and what to ask." };
      }

      // Either a time of day or an interval, never both. A caller that supplies
      // both has not decided, and picking one for them would be a guess the
      // user never sees.
      const dailyAt = requireString(call.arguments.daily_at);
      const everyRaw = call.arguments.every_minutes;
      const every = typeof everyRaw === "number"
        ? everyRaw
        : Number(requireString(everyRaw as string) ?? NaN);

      let cadence: Cadence | null = null;
      if (dailyAt) {
        const at = /^([0-9]{1,2}):([0-9]{2})$/.exec(dailyAt.trim());
        const hours = at ? Number(at[1]) : NaN;
        const minutes = at ? Number(at[2]) : NaN;
        if (!at || hours > 23 || minutes > 59) {
          return { ok: false, content: `"${dailyAt}" is not a 24-hour time like 09:00.` };
        }
        cadence = { kind: "daily", minuteOfDay: hours * 60 + minutes };
      } else if (Number.isFinite(every) && every > 0) {
        cadence = { kind: "interval", minutes: Math.round(every) };
      }

      if (!cadence) {
        return {
          ok: false,
          content: "add_schedule needs either daily_at (a time like 09:00) or every_minutes."
        };
      }

      const saved = addSchedule({ id: randomUUID(), name, prompt, cadence });
      if (!saved) {
        // Reports the outcome, not the attempt - the store refuses a bad
        // cadence or a full list, and saying "scheduled" either way is the
        // false success this codebase is built against.
        return { ok: false, content: "That schedule could not be saved. Nothing was scheduled." };
      }

      return {
        ok: true,
        content: `Scheduled "${saved.name}": ${describeCadence(saved.cadence)}.`
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

    case "fetch_url": {
      const url = requireString(call.arguments.url);
      if (!url) return { ok: false, content: "fetch_url needs a url." };

      const fetchPage = context.fetchPage ?? fetchWebPage;
      const result = await fetchPage(url);
      if (!result.ok) return { ok: false, content: result.reason };

      const notice = result.truncated ? " [showing the first part of this page]" : "";
      return { ok: true, content: `From "${result.title}" (${result.url})${notice}:\n${result.text}` };
    }

    case "run_command": {
      const command = requireString(call.arguments.command);
      if (!command) return { ok: false, content: "run_command needs a command." };

      // Re-checked here, not only where the tool list is built. The arming
      // window can lapse between the model being offered the tool and the
      // call arriving, and the check that matters is the one at the moment
      // something actually runs.
      if (context.unattended) {
        return {
          ok: false,
          content: "Nothing was run: this is a scheduled run with nobody watching, and command "
            + "access is only ever granted for working at the machine. Say what you would have run."
        };
      }

      if (!commandsArmed()) {
        return {
          ok: false,
          content: "Command access is not switched on, so nothing was run. Tell the user they can "
            + "turn it on from the dashboard, and what you would have run."
        };
      }

      // The stage a command belongs to, read from the command itself — an
      // install looks like an install in the trace rather than a generic
      // "command", which is what makes the sequence legible.
      const lower = command.toLowerCase();
      const kind = /(install|add|npm i|pip install)/.test(lower) ? "install"
        : /(test|jest|vitest|pytest)/.test(lower) ? "test"
        : /(start|serve|run dev|launch)/.test(lower) ? "launch"
        : "command";

      const step = beginEvent(context.sessionId, kind, command);
      const run = await runCommand(command);
      endEvent(
        context.sessionId,
        step,
        run.timedOut ? "failed" : run.exitCode === 0 ? "ok" : "failed",
        run.timedOut
          ? "Still running after the time limit, and was stopped."
          : (run.stdout.trim() || run.stderr.trim() || "printed nothing").slice(0, 400)
      );
      // ok tracks whether the command succeeded, not whether the tool worked.
      // A failed command that was reported accurately is still a failure, and
      // labelling it ok would let the reply describe it as done.
      return { ok: run.exitCode === 0 && !run.timedOut, content: describeRun(run) };
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
