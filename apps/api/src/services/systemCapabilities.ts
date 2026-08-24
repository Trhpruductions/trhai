import { toolDefinitions } from "./agentTools.js";
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
  /**
   * Neither exists in this build. Stated as fields rather than left implicit,
   * so a capability report can say "unavailable" instead of staying silent
   * about something a user might otherwise assume it has.
   */
  web: boolean;
  codeExecution: boolean;
  /**
   * Third-party services this build talks to. Always empty today — everything
   * it does runs against this machine's own storage and a local model, and an
   * empty list here is that fact, not an oversight.
   */
  integrations: string[];
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
  const names = toolDefinitions.map((definition) => definition.function.name);

  const tools: ToolCapability[] = toolDefinitions.map((definition) => {
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
    web: false,
    codeExecution: false,
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
