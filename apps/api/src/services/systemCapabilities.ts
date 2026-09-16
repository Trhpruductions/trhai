import { availableTools } from "./agentTools.js";
import { commandsArmed } from "./commandRunner.js";
import { lockedProtectedFiles } from "./protectedJson.js";
import { persistenceFailures } from "./persistenceHealth.js";
import { permissionLabels, permissionLevelOf, requiresConfirmation, type PermissionLevel } from "./toolPermissions.js";

// What this build can actually do, read from the registry rather than
// written down separately.
//
// A hand-written capability list drifts: a tool gets added or removed and the
// paragraph describing it does not, and the next capability question answers
// from the paragraph rather than from what is actually registered. This
// reads the same registry runTool enforces, so the two can never disagree —
// a tool is never described as available here and refused there, or the
// reverse.

export type ToolCapability = {
  name: string;
  description: string;
  level: PermissionLevel;
  levelLabel: string;
  requiresConfirmation: boolean;
};

export type SystemCapabilities = {
  /** e.g. "ollama/llama3.2:latest", or null when no local model is running. */
  model: string | null;
  /** Every registered tool, in the order the model sees them. */
  tools: ToolCapability[];
  /** Whether tools for each area are actually registered — not assumed. */
  filesystem: boolean;
  memory: boolean;
  documents: boolean;
  applicationBuilding: boolean;
  /** Whether the local motion-graphics video pipeline is registered. */
  videoRendering: boolean;
  /**
   * `web` is reaching the internet at all: fetch_url reads a page given its
   * exact URL, and web_search now finds pages for a query (scraping a no-key
   * engine — still no account, still no API key). Stated as a real field rather
   * than left implicit, so a capability report can say "unavailable" outright
   * instead of staying silent about something a user might otherwise assume.
   */
  web: boolean;
  /**
   * Whether it can run commands on this machine *right now*.
   *
   * This used to be hard-false, because there was genuinely no tool for it.
   * There is one now, and it is gated on machine control being switched on —
   * so this answers "can it, at this moment", not "does this build have the
   * feature". Reporting it any other way would put the capability report back
   * in the business of describing something other than what is enforced.
   */
  codeExecution: boolean;
  /**
   * Third-party services this build talks to. Always empty today — everything
   * it does runs against this machine's own storage and a local model, and an
   * empty list here is that fact, not an oversight.
   */
  integrations: string[];
  /**
   * Stored data that could not be decrypted with the current key, by file.
   *
   * Empty is the ordinary case and means everything opened. A non-empty list is
   * serious and is the one thing here that describes a fault rather than a
   * feature: those stores started empty and refuse to be written over, so the
   * assistant has lost access to what they held and cannot save anything new
   * into them.
   *
   * Reported because the alternative is silence. Every store catches the read
   * error and carries on - which is right, an unreadable file must not stop the
   * API from starting - and the visible result is an assistant that has
   * forgotten your memories and will not remember anything new, with nothing
   * anywhere saying why. Almost always this means TRHAI_DATA_KEY changed or the
   * machine key file was lost; the data is still on disk and still recoverable
   * with the original key, which is exactly why the files are locked rather
   * than overwritten.
   */
  lockedData: string[];
  /**
   * Stores that cannot currently write, and why.
   *
   * Empty is the ordinary case. A non-empty list means the app is still
   * answering normally while nothing it is told survives a restart - a disk
   * that filled up, a file held open by something else, a permission change on
   * the data directory.
   *
   * Distinct from lockedData, which is specifically a key that no longer opens
   * existing data. This is the ordinary I/O version of the same problem, and it
   * was silent in five stores until now: each caught its write error, correctly
   * refused to fail the request over it, and recorded nothing.
   */
  failingStores: Array<{ store: string; error: string; at: string }>;
};

function hasAll(names: string[], ...required: string[]): boolean {
  return required.every((name) => names.includes(name));
}

/**
 * The real capability set, read from the tool registry.
 *
 * `model` is passed in rather than checked here — availability depends on a
 * live call to the local model service, and this function stays synchronous
 * and free of I/O so it can be used anywhere, including a reply composer that
 * has no event loop access of its own.
 */
export function getSystemCapabilities(model: string | null): SystemCapabilities {
  // The tools actually on offer right now, not every tool that exists.
  // run_command is withheld while machine control is switched off, and this
  // report has to agree with that — the whole reason this function reads the
  // registry instead of a hand-written list is so what is described and what
  // is enforced can never diverge. Listing a tool here that the loop will not
  // offer is that same divergence by another route.
  const offered = availableTools(commandsArmed());
  const names = offered.map((definition) => definition.function.name);

  const tools: ToolCapability[] = offered.map((definition) => {
    const level = permissionLevelOf(definition.function.name);
    return {
      name: definition.function.name,
      description: definition.function.description,
      level,
      levelLabel: permissionLabels[level],
      requiresConfirmation: requiresConfirmation(definition.function.name)
    };
  });

  return {
    model,
    tools,
    filesystem: hasAll(names, "list_files", "read_file", "write_file"),
    memory: hasAll(names, "search_memory", "remember"),
    documents: hasAll(names, "search_documents", "write_document"),
    applicationBuilding: hasAll(names, "build_app"),
    videoRendering: hasAll(names, "make_video"),
    lockedData: lockedProtectedFiles(),
    failingStores: persistenceFailures(),
    // Reaching the internet at all: reading a page via fetch_url, or finding
    // pages via web_search. Either one present means the web is in reach.
    web: names.includes("fetch_url") || names.includes("web_search"),
    // True only while machine control is on, since `offered` already excludes
    // run_command otherwise. It was hard-false when no such tool existed;
    // leaving it false now that one does would be the same misreport in the
    // opposite direction.
    codeExecution: hasAll(names, "run_command"),
    integrations: []
  };
}

/** Tool names grouped under their permission label, in ladder order. */
export function toolsByLevel(capabilities: SystemCapabilities): Array<{ label: string; tools: ToolCapability[] }> {
  const levels: PermissionLevel[] = [1, 2, 3, 4];
  return levels
    .map((level) => ({
      label: permissionLabels[level],
      tools: capabilities.tools.filter((tool) => tool.level === level)
    }))
    .filter((group) => group.tools.length > 0);
}
