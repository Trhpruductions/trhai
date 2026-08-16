// The navigation blueprint from the product vision (§4 Main Layout Blueprint).
//
// The vision names the exact destinations the top nav and left sidebar must
// carry, in order. Keeping them in one registry rather than two hand-written
// arrays is what stops the two lists drifting apart, and lets a test assert the
// rendered order against the document.
//
// §1 forbids purposeless controls, which rules out a nav item that routes
// nowhere. A destination therefore declares whether a real view backs it: a
// `planned` destination states why in the UI instead of presenting a dead link
// that looks live until clicked.

export type DestinationId =
  | "home"
  | "files"
  | "projects"
  | "memory"
  | "terminal"
  | "browser"
  | "email"
  | "calendar"
  | "marketplace"
  | "plugins"
  | "settings"
  | "agents"
  | "automation"
  | "knowledge";

export type DestinationStatus = "live" | "planned";

export type Destination = {
  id: DestinationId;
  /** Display label, as written in the vision. */
  label: string;
  /** One line describing what the view does. Shown as the view subtitle. */
  summary: string;
  status: DestinationStatus;
  /**
   * Why the destination is not live yet. Required when status is "planned" —
   * an unexplained dead end is exactly the clutter §1 prohibits.
   */
  plannedReason?: string;
};

const destinations: Destination[] = [
  {
    id: "home",
    label: "Home",
    summary: "Live system state, AI core status, and the widgets you pin.",
    status: "live"
  },
  {
    id: "files",
    label: "Files",
    summary: "Workspace files and folders, opened through the desktop bridge.",
    status: "live"
  },
  {
    id: "projects",
    label: "Projects",
    summary: "Every project on this host, with build and open actions.",
    status: "live"
  },
  {
    id: "memory",
    label: "Memory",
    summary: "What the assistant remembers, with pin, edit, and forget controls.",
    status: "live"
  },
  {
    id: "terminal",
    label: "Terminal",
    summary: "Run real commands in the workspace and watch the output stream.",
    status: "live"
  },
  {
    id: "browser",
    label: "Browser",
    summary: "Research and summarize sources with citations.",
    status: "planned",
    plannedReason:
      "Needs an embedded browsing engine with its own permission gate; the shell has no network fetch path yet."
  },
  {
    id: "email",
    label: "Email",
    summary: "Triage and draft mail from the command surface.",
    status: "planned",
    plannedReason:
      "Requires a connected mail account. No third-party credentials are configured for this build."
  },
  {
    id: "calendar",
    label: "Calendar",
    summary: "Your schedule, kept on this machine. No connected account required.",
    status: "live"
  },
  {
    id: "marketplace",
    label: "Marketplace",
    summary: "Browse and install agents that change how the assistant works.",
    status: "live"
  },
  {
    id: "plugins",
    label: "Plugins",
    summary: "Extensions that add capabilities to the workspace.",
    status: "planned",
    plannedReason: "Waiting on the Plugin SDK, which the vision schedules for Phase 3."
  },
  {
    id: "settings",
    label: "Settings",
    summary: "Personality, appearance, and operating defaults.",
    status: "live"
  },
  {
    id: "agents",
    label: "Agents",
    summary: "Installed agents, their roles, and which one is active.",
    status: "live"
  },
  {
    id: "automation",
    label: "Automation",
    summary: "Build flows from blocks. Control flow and scripts run for real; steps needing credentials are dry-run only.",
    status: "live"
  },
  {
    id: "knowledge",
    label: "Knowledge",
    summary: "Documents and references the assistant can draw on.",
    status: "planned",
    plannedReason:
      "Needs per-workspace document indexing (backlog E5-S1) before it can answer from anything real."
  }
];

const byId = new Map<DestinationId, Destination>(destinations.map((entry) => [entry.id, entry]));

/** Top navigation, in the order the vision lists it. */
const topNavOrder: DestinationId[] = [
  "home",
  "projects",
  "agents",
  "automation",
  "knowledge",
  "marketplace",
  "settings"
];

/** Left sidebar, in the order the vision lists it. */
const sidebarOrder: DestinationId[] = [
  "home",
  "files",
  "projects",
  "memory",
  "terminal",
  "browser",
  "email",
  "calendar",
  "marketplace",
  "plugins",
  "settings"
];

function resolve(ids: DestinationId[]): Destination[] {
  return ids.map((id) => {
    const found = byId.get(id);
    if (!found) {
      throw new Error(`Navigation references unknown destination: ${id}`);
    }
    return found;
  });
}

export function topNavDestinations(): Destination[] {
  return resolve(topNavOrder);
}

export function sidebarDestinations(): Destination[] {
  return resolve(sidebarOrder);
}

export function allDestinations(): Destination[] {
  return [...destinations];
}

export function destinationById(id: DestinationId): Destination {
  const found = byId.get(id);
  if (!found) {
    throw new Error(`Unknown destination: ${id}`);
  }
  return found;
}

export const defaultDestination: DestinationId = "home";

/**
 * Whether selecting this destination should render its view or explain itself.
 * Callers use it to decide between routing and disclosure.
 */
export function isRoutable(id: DestinationId): boolean {
  return destinationById(id).status === "live";
}
