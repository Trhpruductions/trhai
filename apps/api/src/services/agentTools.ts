import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeSpelling } from "./spelling.js";
import { matchMemories, type FactMatch } from "./factWording.js";
import { selectRelevantMemories, type ScorableMemory } from "./memoryRelevance.js";
import { evaluateArithmetic, formatNumber } from "./arithmetic.js";
import { describeDifference, shiftDate } from "./dateMath.js";
import { shiftClock } from "./clockMath.js";
import {
  amendProject, changesFrom, classifyRequest, deriveTitle, findScriptFault, generateProject, originalRequestFrom,
  parseVideoScript, planProject, slugify, titleFrom, videoScriptPrompt, withChanges, type VideoScript
} from "@ascend/shared";
import { renderVideo } from "./videoRender.js";
import type { RunningApp, StartResult } from "./appRunner.js";
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
import { webSearch } from "./webSearch.js";
import { renderMockupPrompt, extractRendering, findRenderFault, saveRendering, inferKind, type RenderKind } from "./renderMockup.js";
import { commandsArmed, describeRun, runCommand } from "./commandRunner.js";
import { resolveForAccess } from "./machinePaths.js";
import { explainMiss } from "./projectContext.js";
import { activeProject, impliedFileFor, noteFileTouched, noteProjectTouched, withinActiveProject } from "./activeProject.js";
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
   * The file this turn is about, when the request said "it" and the previous
   * turn had touched one. See resolveFilePronoun in activeProject.ts. The file
   * tools use it to correct a call that names the file by its name in the
   * wrong place, and write_document refuses to make a document of it.
   */
  impliedFile?: string;
  /**
   * Tool names the user has explicitly authorised for this turn.
   *
   * Per turn, not stored: an authorisation that outlived the exchange it was
   * given in would mean "yes" to one deletion quietly permitting the next.
   */
  confirmedActions?: ReadonlySet<string>;
  /**
   * Starts a built app on a free port and waits for it to answer, so a build
   * is something running rather than a folder. Injected (like saveMemory) so
   * unit tests that call runTool never spawn a real server - only the live
   * API wires it. Absent means "cannot launch here", reported as such.
   */
  launchApp?: (project: string) => Promise<StartResult>;
  stopApp?: (project: string) => boolean;
  runningApps?: () => RunningApp[];
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
   * Searches the web, injected the same way as fetchPage so a test exercises
   * web_search's dispatch without a real network call — the real webSearch,
   * scraping a no-key engine through fetchRawPage's defences, when nothing is
   * supplied.
   */
  searchWeb?: typeof webSearch;
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
        "Change a knowledge-base document that already exists. To add to it, pass append. To "
        + "change one passage, read the document first and pass old_text and new_text. Only when "
        + "the user asked for it to be rewritten, pass content with replace_everything: true - "
        + "that discards the current text. Not for a file on disk — a name like test.txt is a "
        + "workspace file; use write_file for that.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The document to change, as listed." },
          append: { type: "string", description: "Text to add at the end, keeping everything already there." },
          old_text: { type: "string", description: "The exact passage to change, as it currently reads." },
          new_text: { type: "string", description: "What old_text becomes." },
          content: { type: "string", description: "A full replacement. Needs replace_everything: true." },
          replace_everything: { type: "boolean", description: "true to discard the current text and use content instead." }
        },
        required: ["title"]
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
      name: "shift_time",
      description:
        "The clock time a number of hours and minutes after or before a given time. Use this for "
        + "arrival times, how long something runs, or 'what time is it 90 minutes from 3pm' - do "
        + "not add hours and minutes yourself, you will get it wrong. Negative values go backwards.",
      parameters: {
        type: "object",
        properties: {
          time: { type: "string", description: "The starting clock time: 3pm, 3:15 PM, 15:00, noon, midnight." },
          hours: { type: "number", description: "Hours to add; negative to subtract. 0 if none." },
          minutes: { type: "number", description: "Minutes to add; negative to subtract. 0 if none." }
        },
        required: ["time"]
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
          },
          recursive: {
            type: "boolean",
            description: "true to list inside the folders as well. Default: the folder's own entries only."
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Find which files contain some text, with the matching lines. Use this to find where a "
        + "function, word or setting is defined or used, anywhere on this machine. Searches "
        + "recursively, skipping node_modules and .git.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "The folder to search, as a workspace path or a full path." },
          pattern: { type: "string", description: "The text to look for. Plain text, matched case-insensitively." },
          extension: { type: "string", description: "Only files with this extension, like ts or js. Optional." }
        },
        required: ["directory", "pattern"]
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
        "Change part of an existing file, leaving the rest untouched. To add lines at the end, pass "
        + "append. To change a passage, read the file first and pass old_text (copied verbatim, "
        + "including indentation; it must appear exactly once) and new_text. Prefer this over "
        + "write_file for any file that already exists: write_file replaces the whole file, so "
        + "anything you do not repeat is deleted.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "A workspace path, or a full path to a file anywhere on this machine."
          },
          append: { type: "string", description: "Text to add at the end of the file, on its own line." },
          old_text: {
            type: "string",
            description: "The exact text to replace, copied from the file including indentation."
          },
          new_text: { type: "string", description: "What to put in place of old_text." }
        },
        required: ["path"]
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
          weekdays_only: { type: "boolean", description: "With daily_at: true to skip Saturday and Sunday (\"every weekday\", \"on workdays\")." },
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
      name: "web_search",
      description:
        "Search the web and get back a short list of real result pages — a title, address and "
        + "snippet for each. Use this when the user asks you to look something up, search for "
        + "something, or asks about current or recent information you cannot know from your own "
        + "training. The snippets often already contain the answer — use them directly when they do. "
        + "Only follow up with fetch_url on a result's address when you genuinely need more detail than "
        + "the snippets give, and if a page cannot be read, answer from the snippets you already have "
        + "rather than giving up.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for, in a few words." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "render_mockup",
      description:
        "Show the user a visual: a UI mockup (a screen, dashboard, form) or a diagram "
        + "(flowchart, architecture, blueprint). Use this when they ask to see, show, render, "
        + "mock up, sketch, wireframe or diagram something. It produces one self-contained visual "
        + "that appears live on screen right away — not a running app (that is build_app) and not a "
        + "video (that is make_video). Describe what to show in full; the visual is generated here.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What to show, described fully." },
          kind: { type: "string", description: "Either \"mockup\" for a UI or \"diagram\" for a flow/architecture. Omit to decide from the description." }
        },
        required: ["description"]
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
  },
  {
    type: "function",
    function: {
      name: "change_app",
      description:
        "Change an app that build_app built: add or remove a field, or add a feature (dashboard, "
        + "calendar, board, search, status, priority, due dates). The app is rebuilt from its own "
        + "description plus the change, in the same folder, keeping its data. Use this for \"add a "
        + "notes field\", \"add a dashboard\" - never build_app, which would make a second app.",
      parameters: {
        type: "object",
        properties: {
          change: { type: "string", description: "What to add, remove or change, in the user's words." },
          project: { type: "string", description: "The app's folder in the workspace. Omit for the app worked on most recently." }
        },
        required: ["change"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_app",
      description:
        "Start an app that build_app built, on a local port, and return the URL it is running at. "
        + "Use this to actually launch an app so the user can open and use it - after building one "
        + "when they want to see it, or when they ask to run, open or launch it. Never start a "
        + "server with run_command; a server never exits and would hang the turn.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "The app's folder in the workspace. Omit for the app worked on most recently." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_app",
      description: "Stop an app that run_app started.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "The app's folder in the workspace." }
        },
        required: ["project"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "make_video",
      description:
        "Build a short motion-graphics video entirely on this machine - scripted, narrated, "
        + "rendered and encoded locally, no cloud rendering - and write it to the workspace. Not "
        + "triple-A generative video: this produces a scripted, narrated presentation-style video, "
        + "which is what this machine's own GPU can actually render and encode in real time. Use "
        + "this when the user wants a video made, not just described.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "What the video should cover and say, in the user's own words."
          }
        },
        required: ["description"]
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
  "write_file", "edit_file", "build_app", "change_app", "make_video", "plan_app", "run_command", "run_script", "run_app"
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

  // Spelling is corrected here and nowhere else in this path: the transcript
  // keeps the user's words, but "buld me a smal app that trakcs my gym
  // visits" produced a folder called buld-me-a-smal-app, which is also the
  // page heading and the browser tab.
  const fromRequest = deriveTitle(normalizeSpelling(request));
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

/** Offered only when the request is about dates; see looksLikeDateMath. */
const dateTools = new Set(["days_between", "shift_date"]);
/**
 * Withheld from a plain question. run_command is deliberately not here: "is
 * anything listening on port 4000?" and "what version of node is installed?"
 * are questions the machine answers, and withholding it left them unanswered.
 * A question does not write files, documents or apps, though.
 */
const writingTools = new Set([
  "write_file", "edit_file", "build_app", "change_app", "make_video", "plan_app",
  "write_document", "update_document", "delete_document", "remember", "forget", "pin_memory", "add_schedule"
]);

/**
 * The workspace file writers, withheld when the request is about a knowledge
 * document. "save a document called Meeting Notes" was writing a Meeting
 * Notes.txt file instead; with these off, write_document is what is left.
 */
const fileWritingTools = new Set(["write_file", "edit_file"]);

/**
 * Offered only when the user asks for something to be kept. "run its smoke
 * test" failed and the model then called remember with "The 'test' script is
 * missing from the package.json file" - a note to itself, saved as the
 * user's fact. Explicit "remember that ..." is handled before the model, so
 * this is only ever for the compound turns.
 */
const memoryWritingTools = new Set(["remember"]);

/** Offered only when the request names a clock time; see looksLikeClockMath. */
const clockTools = new Set(["shift_time"]);
/** Offered only when the request mentions the web or asks for a lookup; see mentionsWeb and wantsWebSearch. */
const webTools = new Set(["fetch_url", "web_search"]);
/** Offered only when the request asks to see/show/render something; see wantsRendering. */
const renderTools = new Set(["render_mockup"]);
/** Offered only when the request mentions the time or the date; see mentionsTime. */
const timeTools = new Set(["current_datetime"]);

export function availableTools(
  armed: boolean,
  options: {
    scaffolding?: boolean; changes?: boolean; arithmetic?: boolean; dates?: boolean; clock?: boolean;
    web?: boolean; time?: boolean; writes?: boolean; memory?: boolean; render?: boolean; files?: boolean;
  } = {}
): ToolDefinition[] {
  const allowScaffolding = options.scaffolding ?? true;
  const allowChanges = options.changes ?? true;
  // See looksArithmetic. Offered to everything, calculate was grabbed for
  // pattern questions and syllogisms and answered them with its output.
  const allowArithmetic = options.arithmetic ?? true;
  const allowDates = options.dates ?? true;
  const allowClock = options.clock ?? true;
  const allowWeb = options.web ?? true;
  const allowTime = options.time ?? true;
  const allowRender = options.render ?? true;
  const allowWrites = options.writes ?? true;
  const allowFileWrites = options.files ?? true;
  const allowMemory = options.memory ?? true;

  return toolDefinitions.filter((definition) => {
    const name = definition.function.name;
    if (!armed && name === "run_command") return false;
    if (!allowScaffolding && scaffoldingTools.has(name)) return false;
    if (!allowArithmetic && name === "calculate") return false;
    if (!allowDates && dateTools.has(name)) return false;
    if (!allowClock && clockTools.has(name)) return false;
    if (!allowWeb && webTools.has(name)) return false;
    if (!allowTime && timeTools.has(name)) return false;
    if (!allowRender && renderTools.has(name)) return false;
    if (!allowFileWrites && fileWritingTools.has(name)) return false;
    if (!allowChanges && machineChangingTools.has(name)) return false;
    if (!allowWrites && writingTools.has(name)) return false;
    if (!allowMemory && memoryWritingTools.has(name)) return false;
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

const searchSkipped = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage", ".cache"]);
const searchMaxMatches = 60;
const searchMaxFiles = 4000;
const searchMaxFileBytes = 512_000;

/** A recursive, case-insensitive plain-text search; see the search_files tool. */
function searchFiles(
  root: string,
  pattern: string,
  extension: string | null
): { kind: "missing" } | { kind: "ok"; matches: Array<{ file: string; line: number; text: string }>; truncated: boolean } {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return { kind: "missing" };
  }
  if (!stat.isDirectory()) return { kind: "missing" };

  const needle = pattern.toLowerCase();
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let visited = 0;
  let truncated = false;

  const walk = (directory: string): void => {
    if (truncated || visited > searchMaxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (searchSkipped.has(entry)) continue;
      const full = path.join(directory, entry);
      let entryStat;
      try {
        entryStat = statSync(full);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entryStat.isFile() || entryStat.size > searchMaxFileBytes) continue;
      if (extension && !entry.toLowerCase().endsWith(`.${extension}`)) continue;
      visited += 1;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        matches.push({ file: full, line: index + 1, text: lines[index].trim().slice(0, 200) });
        if (matches.length >= searchMaxMatches) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(root);
  return { kind: "ok", matches, truncated };
}

/**
 * What an app was built from, kept in the folder in a file of its own.
 *
 * The README carries the same request for people, and the model rewrote it
 * three times in the turn after the build - "Tracks the health and growth
 * of your houseplants" - so change_app then found no description to rebuild
 * from. This file is not a file the model is offered anything about.
 */
const appManifestName = ".vexora-app.json";

type AppManifest = { request: string; title: string; changes: string[] };

function readAppManifest(project: string): AppManifest | null {
  const read = readWorkspaceFile(`${project}/${appManifestName}`);
  if (!read.ok) return null;
  try {
    const parsed = JSON.parse(read.content) as Partial<AppManifest>;
    if (typeof parsed.request !== "string" || !parsed.request.trim()) return null;
    return {
      request: parsed.request,
      title: typeof parsed.title === "string" ? parsed.title : "",
      changes: Array.isArray(parsed.changes) ? parsed.changes.filter((entry): entry is string => typeof entry === "string") : []
    };
  } catch {
    return null;
  }
}

function writeAppManifest(project: string, manifest: AppManifest): void {
  writeWorkspaceFile(`${project}/${appManifestName}`, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * A knowledge document whose title is this file name without its extension.
 *
 * The other direction of the file/document confusion. "add 'then clear the
 * cache' to the end of my Deploy Steps note" went to edit_file on "Deploy
 * Steps.txt", which does not exist, and the model asked the user to check
 * the filename - with a document called "Deploy Steps" sitting in the
 * knowledge base the whole time.
 */
function documentNamedLike(context: ToolContext, target: string): { title: string } | null {
  const stem = target.trim().replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{1,6}$/i, "").trim().toLowerCase();
  if (!stem) return null;
  const found = (context.documents ?? []).find((document) => document.title.trim().toLowerCase() === stem);
  return found ? { title: found.title } : null;
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
  // When it is not a file either, the model reached for update_document to
  // create something new. Point it at the tool that does - "save a document
  // called X" arrives as update_document on a document that does not exist yet.
  const createHint = fileHint ? "" : ` To create a new document, use write_document with a title and content.`;
  return `There is no document called "${title}".${available}${fileHint}${createHint}`;
}

/** The same exact-then-partial rule, for a saved fact. */
/**
 * The saved memory the model is naming. See matchMemories: the model repeats
 * text back and paraphrases it, so this is matched by wording, never trusted
 * as an id - an id it invented would delete the wrong memory.
 */
function findMemory(context: ToolContext, fact: string): FactMatch<ScorableMemory> {
  return matchMemories(fact, context.memories);
}

/** The refusal for a name that fits more than one memory: nothing done, and the choice listed. */
function describeSeveral(tool: string, fact: string, candidates: ScorableMemory[], outcome: string): string {
  const listed = candidates.map((memory) => `- ${memory.body}`).join("\n");
  return `Several saved memories match "${fact}":\n${listed}\nNothing was ${outcome}. `
    + `Call ${tool} again with the full wording of the one you mean.`;
}

/**
 * Start a just-built app and describe where it is running, or null when there
 * is no launcher wired (unit tests) so the caller keeps its plain run line.
 * A launch failure is not a build failure: the files are good, so this says
 * how to run it by hand rather than turning a successful build into an error.
 */
async function launchLine(context: ToolContext, project: string): Promise<string | null> {
  if (!context.launchApp) return null;
  const started = await context.launchApp(project);
  return started.ok
    ? `It is running live at ${started.app.url} - open that to use it.`
    : `Built, but I could not start it automatically (${started.reason}). Run it yourself: cd ${project} && npm start`;
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
    // A call with nothing in it is not held for confirmation; it is refused so
    // the model tries again with a target. "forget my api port" arrived as
    // forget with an empty fact, was held, and the user - had they said yes -
    // would have confirmed a call that could only fail. Validated first, the
    // model is told what is missing and the confirmation is asked for the
    // call that would actually run.
    const values = Object.values(call.arguments ?? {});
    const allBlank = values.length === 0
      || values.every((value) => typeof value !== "string" || value.trim() === "");
    if (allBlank) {
      // The wording names the tool and the argument, and says to call the
      // same tool again. The first version said "Say exactly what it should
      // apply to", and the model read that as an instruction to state the
      // fact: asked to forget that the printer is on the second floor, it
      // called remember with that sentence and reported it saved. A refusal
      // is read as the next instruction, so it has to be one.
      const required = toolDefinitions.find((definition) => definition.function.name === call.name)
        ?.function.parameters.required ?? [];
      const missing = required.length > 0 ? required.join(" and ") : "its arguments";
      return {
        ok: false,
        content: `${call.name} was called with ${missing} empty, so nothing was done. `
          + `Call ${call.name} again with ${missing} filled in from the user's request. `
          + "Do not switch to a different tool."
      };
    }
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
      const match = findMemory(context, fact);

      if (match.kind === "several") {
        return { ok: false, content: describeSeveral(call.name, fact, match.candidates, "deleted") };
      }
      if (match.kind === "none") {
        return { ok: false, content: `Nothing saved matches "${fact}", so nothing was deleted.` };
      }
      const target = match.memory;

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
      // The same mistake for a file outside the workspace, when this turn is
      // about one: "add a line to the end of it" ended as a knowledge
      // document called notes.txt with the new line in it, and the file
      // itself untouched.
      if (context.impliedFile && impliedFileFor(context.impliedFile, title) === context.impliedFile) {
        return {
          ok: false,
          content: `"${title}" is the file ${context.impliedFile}, not a knowledge document. `
            + "Use edit_file with append to add to it, or write_file to replace it."
        };
      }

      if (!context.saveDocument) {
        return { ok: false, content: "There is nowhere to save documents, so nothing was written." };
      }

      // A title that exists is changed, never doubled. A session ended up
      // with two documents called "Deploy Steps" - one from the save, one
      // from a repeat of it - and every later read quoted both.
      const wanted = title.trim().toLowerCase();
      const existing = (context.documents ?? []).find((document) => document.title.trim().toLowerCase() === wanted);
      if (existing) {
        return {
          ok: false,
          content: `A document called "${existing.title}" already exists, so nothing was written. To add to it `
            + "call update_document with append; to change part of it pass old_text and new_text; or save "
            + "under a different title."
        };
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
      if (!title) return { ok: false, content: "update_document needs the document's title." };
      if (!context.updateDocument) {
        return { ok: false, content: "There is nowhere to save documents, so nothing was changed." };
      }

      // Deliberately does not create on a miss. A model that misremembers a
      // title would otherwise silently make a second document instead of
      // editing the one the user meant.
      const found = findDocument(context, title);
      if (!found) {
        return { ok: false, content: describeMissingDocument(context, title) };
      }

      // Three ways to change a document, and whole replacement is the one
      // that has to be asked for by name. This tool used to take only the
      // full new text: asked to add "then clear the cache" to the end of a
      // note, the model did not read the note first and sent a body it made
      // up - "1. Build the project 2. Run tests 3. Deploy to server 4. Then
      // clear the cache" - and the user's actual steps were gone. Appending
      // and passage edits cannot lose what is there; a replacement without
      // the flag is refused with the current text, so the model can do the
      // append it meant.
      const addition = requireString(call.arguments.append);
      const oldText = requireString(call.arguments.old_text);
      const newText = typeof call.arguments.new_text === "string" ? call.arguments.new_text : null;
      const content = requireString(call.arguments.content);
      const replaceEverything = call.arguments.replace_everything === true;

      let next: string;
      let did: string;
      if (addition) {
        const current = found.body.trimEnd();
        next = current ? `${current}\n${addition}` : addition;
        did = `Added to the end of "${found.title}".`;
      } else if (oldText !== null) {
        if (newText === null) return { ok: false, content: "update_document needs new_text alongside old_text." };
        if (!found.body.includes(oldText)) {
          return {
            ok: false,
            content: `"${found.title}" does not contain that old_text, so nothing was changed. Its current text is:\n${found.body}`
          };
        }
        next = found.body.replace(oldText, newText);
        did = `Changed a passage in "${found.title}".`;
      } else if (content) {
        if (!replaceEverything && found.body.trim().length > 0) {
          return {
            ok: false,
            content: `Nothing was changed: content would replace the whole of "${found.title}", whose current text is:\n`
              + `${found.body}\n\nTo add to it, call update_document with append. To change part of it, pass old_text `
              + "and new_text. To discard all of it and start over, pass replace_everything: true."
          };
        }
        next = content;
        did = `Replaced the contents of "${found.title}".`;
      } else {
        return {
          ok: false,
          content: "update_document needs append, or old_text with new_text, or content with replace_everything: true."
        };
      }

      const updated = context.updateDocument(found.id, next);
      return updated
        ? { ok: true, content: did }
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

      const match = findMemory(context, fact);
      if (match.kind === "several") {
        return { ok: false, content: describeSeveral(call.name, fact, match.candidates, "marked") };
      }
      if (match.kind === "none") {
        return { ok: false, content: `Nothing saved matches "${fact}", so nothing was marked.` };
      }
      const target = match.memory;

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

    case "shift_time": {
      const time = requireString(call.arguments.time);
      if (!time) return { ok: false, content: "shift_time needs a starting clock time, like 3pm or 15:00." };
      const hours = call.arguments.hours === undefined || call.arguments.hours === "" ? 0 : Number(call.arguments.hours);
      const minutes = call.arguments.minutes === undefined || call.arguments.minutes === "" ? 0 : Number(call.arguments.minutes);
      const result = shiftClock(time, hours, minutes);
      return result.ok ? { ok: true, content: result.value } : { ok: false, content: result.reason };
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
      // Says what the tool is for, so a model that reached for it with "2
      // hours 30 minutes" answers the question itself instead of giving up.
      if (!Number.isFinite(days)) {
        return {
          ok: false,
          content: "shift_date moves a date by a whole number of days, and days was not a number. "
            + "For hours and minutes, work the time out yourself and answer."
        };
      }

      const result = shiftDate(from, days, (context.now ?? (() => new Date()))());
      return result.ok
        ? { ok: true, content: result.value }
        : { ok: false, content: result.reason };
    }

    case "change_app": {
      const change = requireString(call.arguments.change);
      if (!change) return { ok: false, content: "change_app needs the change, in words." };
      const project = requireString(call.arguments.project)?.replace(/[\\/]+$/, "") ?? activeProject(context.sessionId);
      if (!project) {
        return {
          ok: false,
          content: "change_app needs to know which app: none has been built or worked on in this session. "
            + "Pass project with its folder name in the workspace."
        };
      }

      // The manifest first; the README's first paragraph for apps built
      // before the manifest existed.
      const manifest = readAppManifest(project);
      const readme = readWorkspaceFile(`${project}/README.md`);
      const original = manifest?.request ?? (readme.ok ? originalRequestFrom(readme.content) : null);
      if (!original) {
        return {
          ok: false,
          content: `${project} was not built by build_app - nothing in it carries the description it was built from - `
            + "so it cannot be rebuilt from one. Change its files with edit_file instead."
        };
      }
      const earlier = manifest?.changes ?? (readme.ok ? changesFrom(readme.content) : []);
      const title = (manifest?.title || (readme.ok ? titleFrom(readme.content) : null)) ?? undefined;

      const amended = amendProject(original, earlier, change, title);
      if (!amended) {
        return {
          ok: false,
          content: `I could not map "${change}" onto the app's plan, so nothing was changed. change_app can add or `
            + "remove a field (\"add a notes text field\", \"remove the species field\") or add a feature (dashboard, "
            + "calendar, board, search, status, priority, due dates). For anything else, change the files with edit_file."
        };
      }

      const { sessionId } = context;
      recordEvent(sessionId, "plan", `Changing "${amended.spec.title}"`, "ok", amended.changes.join("; "));

      // The README carries the whole change list, so the next change starts
      // from all of them. data/ is not among the generated files and is left
      // exactly as it is: the records are the user's.
      const files = generateProject(amended.spec).map((file) =>
        file.path === "README.md" ? { ...file, content: withChanges(file.content, [...earlier, change]) } : file);
      const writing = beginEvent(sessionId, "write", `Rewriting ${files.length} files`);
      let count = 0;
      for (const file of files) {
        const result = writeWorkspaceFile(`${project}/${file.path}`, file.content);
        if (!result.ok) {
          endEvent(sessionId, writing, "failed", `${result.reason} ${count} of ${files.length} files were written.`);
          return { ok: false, content: `Could not finish the change: ${result.reason} The app may be half-written; run change_app again.` };
        }
        count += 1;
      }
      endEvent(sessionId, writing, "ok", `${count} files`, `${project}/`);
      writeAppManifest(project, { request: original, title: amended.spec.title, changes: [...earlier, change] });
      noteProjectTouched(sessionId, `${project}/server.js`);

      enterStage(sessionId, "verifying");
      const verifying = beginEvent(sessionId, "verify", "Running its own checks");
      const verification = await verifyBuiltProject(project);
      endEvent(
        sessionId,
        verifying,
        !verification.ran ? "skipped" : verification.passed ? "ok" : "failed",
        verification.ran ? verification.output : verification.reason
      );

      const did = amended.changes.join("; ");
      const runLine = `The user can run it with: cd ${project} && npm start (do not start it here).`;
      if (!verification.ran) {
        return { ok: true, content: `Changed "${amended.spec.title}" (${project}/): ${did}. Could not verify it automatically: ${verification.reason}\n\n${runLine}` };
      }
      if (!verification.passed) {
        return { ok: false, content: `Changed "${amended.spec.title}" (${project}/): ${did} - but its own checks FAILED:\n${verification.output}` };
      }
      const liveLine = await launchLine(context, project);
      return { ok: true, content: `Changed "${amended.spec.title}" (${project}/): ${did}. Verified: ${verification.output}\n\n${liveLine ?? runLine}` };
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
      const runLine = "The user can run it with: cd " + folder + " && npm start (do not start it here).";

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
      // What it was built from, for change_app. The user's own words when
      // they were given; the model's description otherwise.
      if (archetype !== "authored") {
        writeAppManifest(folder, { request: askedFor || description, title: spec.title, changes: [] });
      }

      const built = "Built \"" + spec.title + "\" in the workspace at " + folder + "/ with "
        + written.length + " files, and verified it: " + verifiedDetail(verification.output);
      const liveLine = await launchLine(context, folder);
      return { ok: true, content: `${built}\n\n${liveLine ?? runLine}` };
    }

    case "run_app": {
      const project = requireString(call.arguments.project)?.replace(/[\\/]+$/, "") ?? activeProject(context.sessionId);
      if (!project) {
        return {
          ok: false,
          content: "run_app needs to know which app: none has been built or worked on this session. Pass project with its folder name."
        };
      }
      if (!context.launchApp) {
        return { ok: false, content: "Apps cannot be launched here." };
      }
      const started = await context.launchApp(project);
      if (!started.ok) {
        return { ok: false, content: `Could not start ${project}: ${started.reason}` };
      }
      noteProjectTouched(context.sessionId, `${project}/server.js`);
      const was = started.alreadyRunning ? "was already running" : "is now running";
      return { ok: true, content: `"${project}" ${was} at ${started.app.url} - open that to use it.` };
    }

    case "stop_app": {
      const project = requireString(call.arguments.project)?.replace(/[\\/]+$/, "");
      if (!project) return { ok: false, content: "stop_app needs the app's folder name." };
      if (!context.stopApp) return { ok: false, content: "Apps cannot be stopped here." };
      const stopped = context.stopApp(project);
      return stopped
        ? { ok: true, content: `Stopped "${project}".` }
        : { ok: false, content: `"${project}" was not running.` };
    }

    case "make_video": {
      const description = requireString(call.arguments.description);
      if (!description) return { ok: false, content: "make_video needs a description." };

      if (!context.authorApp) {
        return {
          ok: false,
          content: "Writing a video script needs the local model, and no model is available. "
            + "Start the model and ask again."
        };
      }

      const { sessionId } = context;
      const attempts = 3;
      let script: VideoScript | null = null;
      let lastFault = "";

      for (let attempt = 1; attempt <= attempts && !script; attempt += 1) {
        const scriptEvent = beginEvent(sessionId, "create",
          `Writing the video script${attempt > 1 ? ` (attempt ${attempt})` : ""}`);

        const authored = await context.authorApp(videoScriptPrompt(description));
        if (!authored.ok) {
          lastFault = authored.reason;
          endEvent(sessionId, scriptEvent, "failed", lastFault);
          continue;
        }

        const parsed = parseVideoScript(authored.text);
        if (!parsed.ok) {
          lastFault = parsed.reason;
          endEvent(sessionId, scriptEvent, "failed", lastFault);
          continue;
        }

        const fault = findScriptFault(parsed.script);
        if (fault) {
          lastFault = fault;
          endEvent(sessionId, scriptEvent, "failed", lastFault);
          continue;
        }

        script = parsed.script;
        endEvent(sessionId, scriptEvent, "ok", `${parsed.script.scenes.length} scenes`);
      }

      if (!script) {
        return {
          ok: false,
          content: `I could not write a usable script for that video. ${attempts} attempts were `
            + `made and the last failed because ${lastFault}. Nothing was rendered.`
        };
      }

      const folder = slugify(script.title, "video", 60);
      const renderEvent = beginEvent(sessionId, "create", `Rendering "${script.title}"`);
      const rendered = await renderVideo(script, {
        folder,
        onProgress: (message) => recordEvent(sessionId, "create", message, "ok")
      });

      if (!rendered.ok) {
        endEvent(sessionId, renderEvent, "failed", rendered.reason);
        return {
          ok: false,
          content: `The script was written but the render failed: ${rendered.reason} Nothing was reported as built.`
        };
      }

      endEvent(sessionId, renderEvent, "ok", `${rendered.frames} frames, ${rendered.seconds}s`, rendered.path);
      noteProjectTouched(context.sessionId, folder);

      return {
        ok: true,
        content: `Rendered "${script.title}" to the workspace at ${rendered.path} - ${rendered.seconds}s, `
          + `${rendered.frames} frames, ${script.scenes.length} scene${script.scenes.length === 1 ? "" : "s"}.`
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

      // The folder's own entries, folders first, unless the deep listing was
      // asked for. Asked for the top-level folders of a repository, the old
      // recursive, newest-first listing answered with apps/api/data/tasks.json
      // and its neighbours - two hundred files from wherever the last write
      // happened, and not one folder name.
      const deep = call.arguments.recursive === true || call.arguments.recursive === "true";
      // Workspace listings are relative to the workspace root, not to the
      // folder asked about, so the asked-about folder's own prefix is what
      // depth is counted from.
      const prefix = inWorkspace && directory !== "." ? directory.replace(/^[.\\/]+/, "").replace(/[\\/]+$/, "") : "";
      const relativeTo = (entryPath: string) =>
        prefix && (entryPath.startsWith(`${prefix}/`) || entryPath.startsWith(`${prefix}\\`)) ? entryPath.slice(prefix.length + 1) : entryPath;
      const depthOf = (entryPath: string) => relativeTo(entryPath).split(/[\\/]/).length;
      const byName = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path);
      const top = entries.filter((entry) => depthOf(entry.path) === 1);
      // Alphabetical at the top level, the way a directory listing reads;
      // the deep listing keeps newest first, which is what it is for.
      const chosen = deep || top.length === 0 ? entries : [...top].sort(byName);
      const folders = chosen.filter((entry) => entry.directory);
      const files = chosen.filter((entry) => !entry.directory);
      const shown = files.slice(0, 200);
      const folderLines = folders.map((entry) => {
        const inside = entries.filter((child) => child.path.startsWith(`${entry.path}/`) || child.path.startsWith(`${entry.path}\\`)).length;
        return `- ${entry.path}/${inside > 0 ? ` (${inside} entries)` : ""}`;
      });
      const fileLines = shown.map((entry) => `- ${entry.path} (${entry.bytes} bytes)`);
      const listing = [...folderLines, ...fileLines].join("\n");

      // Says when it is showing part of a folder. A truncated listing that
      // looks complete is how "that file does not exist" gets said about a
      // file that does.
      const note = files.length > shown.length
        ? `\n\n[showing ${shown.length} of ${files.length} files, newest first]`
        : !deep && entries.length > chosen.length
          ? "\n\n[top level only; pass recursive: true to list inside the folders]"
          : "";
      return { ok: true, content: `${listing}${note}` };
    }

    case "search_files": {
      const directory = requireString(call.arguments.directory);
      const pattern = requireString(call.arguments.pattern);
      if (!directory || !pattern) return { ok: false, content: "search_files needs a directory and a pattern." };
      const extension = requireString(call.arguments.extension)?.replace(/^\./, "").toLowerCase() ?? null;

      const verdict = resolveForAccess(directory, {
        granted: commandsArmed() && !context.unattended,
        intent: "read",
        insideWorkspace: resolveInWorkspace
      });
      if (!verdict.ok) return { ok: false, content: verdict.reason };

      const found = searchFiles(verdict.path, pattern, extension);
      if (found.kind === "missing") return { ok: false, content: `There is no folder at "${directory}".` };
      if (found.matches.length === 0) {
        return { ok: false, content: `Nothing under ${directory} contains "${pattern}"${extension ? ` in .${extension} files` : ""}.` };
      }
      const lines = found.matches.map((match) => `${match.file}:${match.line}: ${match.text}`);
      const note = found.truncated ? `\n[first ${found.matches.length} matches shown]` : "";
      return { ok: true, content: lines.join("\n") + note };
    }

    case "read_file": {
      const target = impliedFileFor(context.impliedFile, requireString(call.arguments.path) ?? "") || null;
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

      if (result.ok) {
        noteProjectTouched(context.sessionId, target);
        noteFileTouched(context.sessionId, target);
      }
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
      const target = impliedFileFor(context.impliedFile, requireString(call.arguments.path) ?? "") || null;
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
      noteFileTouched(context.sessionId, target);
      return {
        ok: true,
        content: inWorkspace === result.path
          ? `Wrote ${target} to the workspace.`
          : `Wrote ${result.path}.`
      };
    }

    case "edit_file": {
      const target = impliedFileFor(context.impliedFile, requireString(call.arguments.path) ?? "") || null;
      // Leading newlines dropped: the addition always starts on its own line,
      // and a model that passes "\nomega" to be safe was adding a blank line.
      const additionRaw = typeof call.arguments.append === "string" ? call.arguments.append.replace(/^(?:\r?\n)+/, "") : "";
      const addition = additionRaw.length > 0 ? additionRaw : null;
      const oldText = typeof call.arguments.old_text === "string" ? call.arguments.old_text : null;
      const newText = typeof call.arguments.new_text === "string" ? call.arguments.new_text : null;
      // Appending is its own operation. "add a line saying omega to the end
      // of it" was tried as a replacement - old_text "beta\n", "omega\n",
      // "" - and failed every time, because there is no passage to replace
      // when the change is an addition.
      if (!target || (addition === null && (oldText === null || newText === null))) {
        return { ok: false, content: "edit_file needs a path, and either append or old_text with new_text." };
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
      if (!current.ok) {
        const document = documentNamedLike(context, target);
        return {
          ok: false,
          content: document
            ? `${current.reason} There is a knowledge document called "${document.title}", though - `
              + "use update_document for it. Nothing was changed."
            : `${current.reason} Nothing was changed.`
        };
      }

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

      if (addition !== null) {
        const base = current.content.length === 0 || current.content.endsWith("\n")
          ? current.content
          : `${current.content}\n`;
        const appended = `${base}${addition.endsWith("\n") ? addition : `${addition}\n`}`;
        const written = writeFileAt(writeVerdict.path, appended);
        if (!written.ok) return { ok: false, content: `${written.reason} Nothing was changed.` };

        noteProjectTouched(context.sessionId, target);
        noteFileTouched(context.sessionId, target);
        const lines = addition.replace(/\n$/, "").split("\n").length;
        return { ok: true, content: `Added ${lines} line${lines === 1 ? "" : "s"} to the end of ${written.path}.` };
      }

      const edited = applyEdit(current.content, oldText as string, newText as string);
      if (!edited.ok) return { ok: false, content: `${edited.reason} Nothing was changed.` };

      const written = writeFileAt(writeVerdict.path, edited.content);
      if (!written.ok) return { ok: false, content: `${written.reason} Nothing was changed.` };

      noteProjectTouched(context.sessionId, target);
      noteFileTouched(context.sessionId, target);
      return { ok: true, content: `Edited ${written.path} — ${describeEdit(oldText as string, newText as string)}.` };
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
        const weekdaysOnly = call.arguments.weekdays_only === true || call.arguments.weekdays_only === "true";
        cadence = weekdaysOnly
          ? { kind: "daily", minuteOfDay: hours * 60 + minutes, weekdaysOnly: true }
          : { kind: "daily", minuteOfDay: hours * 60 + minutes };
      } else if (Number.isFinite(every) && every > 0) {
        cadence = { kind: "interval", minutes: Math.round(every) };
      }

      if (!cadence) {
        return {
          ok: false,
          content: "add_schedule needs either daily_at (a time like 09:00) or every_minutes."
        };
      }

      // The same schedule is not made twice. Asked for one daily check, the
      // model called add_schedule four times across four rounds - varying the
      // prompt each time - and four "Build Check" schedules were saved.
      const duplicate = listSchedules().find((schedule) =>
        describeCadence(schedule.cadence) === describeCadence(cadence)
        && (schedule.name.trim().toLowerCase() === name.trim().toLowerCase()
          || schedule.prompt.trim().toLowerCase() === prompt.trim().toLowerCase()));
      if (duplicate) {
        // Reported as done, not refused: the schedule the user asked for
        // exists, which is the state they wanted. Refused, the model treated
        // it as an obstacle and called add_schedule four more times with the
        // prompt reworded each time until one got past the check.
        return {
          ok: true,
          content: `Already scheduled - "${duplicate.name}": ${describeCadence(duplicate.cadence)}. `
            + "Nothing new was added; that one covers it."
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
      // A path on this machine is not a web address. "read C:/.../notes.txt"
      // arrived here and was refused as "not http" - true, and useless.
      if (/^(?:[a-z]:[\\/]|\\\\|\/(?!\/)|~[\\/]|\.{1,2}[\\/])/i.test(url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        return { ok: false, content: `"${url}" is a file path on this machine, not a web address. Use read_file for it.` };
      }

      const fetchPage = context.fetchPage ?? fetchWebPage;
      const result = await fetchPage(url);
      if (!result.ok) return { ok: false, content: result.reason };

      const notice = result.truncated ? " [showing the first part of this page]" : "";
      return { ok: true, content: `From "${result.title}" (${result.url})${notice}:\n${result.text}` };
    }

    case "web_search": {
      const query = requireString(call.arguments.query);
      if (!query) return { ok: false, content: "web_search needs something to search for." };

      const search = context.searchWeb ?? webSearch;
      const outcome = await search(query);
      if (!outcome.ok) return { ok: false, content: `The web search found nothing — ${outcome.reason}.` };

      const lines = outcome.results.map((entry, index) => {
        const snippet = entry.snippet ? `\n   ${entry.snippet}` : "";
        return `${index + 1}. ${entry.title}\n   ${entry.url}${snippet}`;
      });
      return {
        ok: true,
        content: `Web results for "${outcome.query}" (use fetch_url to read one in full):\n${lines.join("\n")}`
      };
    }

    case "render_mockup": {
      const description = requireString(call.arguments.description);
      if (!description) return { ok: false, content: "render_mockup needs a description of what to show." };
      if (!context.authorApp) {
        return { ok: false, content: "Rendering needs the local model, which is not available here." };
      }
      const rawKind = requireString(call.arguments.kind);
      const kind: RenderKind = rawKind === "diagram" || rawKind === "mockup" ? rawKind : inferKind(description);

      const authored = await context.authorApp(renderMockupPrompt(description, kind));
      if (!authored.ok) return { ok: false, content: `Could not render that: ${authored.reason}` };

      const extracted = extractRendering(authored.text);
      if (!extracted) return { ok: false, content: "The model did not return a usable rendering. Try describing what to show a little differently." };

      const fault = findRenderFault(extracted.html);
      if (fault) return { ok: false, content: `The rendering was rejected: ${fault}.` };

      const saved = saveRendering(extracted.title || description, kind, extracted.html);
      return { ok: true, content: `Rendered "${saved.title}" — it is on screen now.` };
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
      // These carried literal backspace characters where \b was meant - an
      // escaping collapse in the commit that added them - so no command was
      // ever an install, a test or a launch in the trace.
      const kind = /\b(install|add|npm i\b|pip install)/.test(lower) ? "install"
        : /\b(test|jest|vitest|pytest)\b/.test(lower) ? "test"
        : /\b(start|serve|run dev|launch)\b/.test(lower) ? "launch"
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
