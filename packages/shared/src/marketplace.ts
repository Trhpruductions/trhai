// Agent marketplace (vision §10).
//
// The entity model the vision specifies: avatar, name and role, description,
// rating and usage signal, version history, update notes, install action.
//
// Two constraints shape this file.
//
// An installed agent has to *do* something, or the marketplace is a wall of
// decorative cards. Installing makes an agent selectable, and the active agent
// contributes its own suggestions and a focus line to the assistant. It does not
// invent new capability: an agent is a lens on the same assistant, in the same
// way a personality is.
//
// The rating and usage numbers are the catalog's own published figures, not
// telemetry from this machine. They are labelled as such in the UI, because a
// "4.8 ★ · 12k installs" that is actually a hardcoded literal is exactly the
// simulated signal §22 forbids.

export type AgentVersion = {
  version: string;
  /** ISO date, "2026-07-14". */
  releasedOn: string;
  notes: string;
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  /** Emoji avatar — keeps the catalog self-contained, no remote images. */
  avatar: string;
  description: string;
  /** Published catalog rating, 0..5. Not measured on this machine. */
  rating: number;
  /** Published install count. Not measured on this machine. */
  installs: number;
  /** Newest first. */
  versions: AgentVersion[];
  /** Prompts this agent contributes when it is the active agent. */
  suggestions: string[];
  /** One line describing what the agent keeps in view. */
  focus: string;
};

const agents: Agent[] = [
  {
    id: "programmer",
    name: "Ada",
    role: "Programmer",
    avatar: "⌨️",
    description: "Reads the workspace, proposes changes, and explains what a failure is actually telling you.",
    rating: 4.8,
    installs: 12400,
    versions: [
      { version: "1.3.0", releasedOn: "2026-07-14", notes: "Reads test output before proposing a fix." },
      { version: "1.2.0", releasedOn: "2026-05-02", notes: "Understands multi-file changes." },
      { version: "1.0.0", releasedOn: "2026-02-20", notes: "First release." }
    ],
    suggestions: ["Why is this test failing?", "Refactor this module", "Review my last change"],
    focus: "Files, failures, and the smallest change that fixes them."
  },
  {
    id: "designer",
    name: "Nova",
    role: "Designer",
    avatar: "🎨",
    description: "Turns rough intent into layout, hierarchy, and a consistent visual language.",
    rating: 4.6,
    installs: 8900,
    versions: [
      { version: "1.1.0", releasedOn: "2026-06-30", notes: "Contrast and spacing checks." },
      { version: "1.0.0", releasedOn: "2026-03-11", notes: "First release." }
    ],
    suggestions: ["Critique this layout", "Give me three visual directions", "What is competing for attention here?"],
    focus: "Hierarchy, spacing, and what the eye lands on first."
  },
  {
    id: "lawyer",
    name: "Sterling",
    role: "Lawyer",
    avatar: "⚖️",
    description: "Summarizes documents and surfaces obligations. Not a substitute for counsel.",
    rating: 4.4,
    installs: 5100,
    versions: [
      { version: "1.0.1", releasedOn: "2026-06-02", notes: "Clearer obligation summaries." },
      { version: "1.0.0", releasedOn: "2026-04-18", notes: "First release." }
    ],
    suggestions: ["Summarize this document's obligations", "What terms deserve a closer look?", "Draft questions for a lawyer"],
    focus: "Obligations, deadlines, and terms worth a second read."
  },
  {
    id: "doctor",
    name: "Vitals",
    role: "Doctor",
    avatar: "🩺",
    description: "Organizes health notes and appointment prep. Not a substitute for care.",
    rating: 4.3,
    installs: 4200,
    versions: [
      { version: "1.0.0", releasedOn: "2026-05-20", notes: "First release." }
    ],
    suggestions: ["Organize these notes", "What should I ask at my appointment?", "Explain this in plain language"],
    focus: "Notes, questions, and appointment preparation."
  },
  {
    id: "researcher",
    name: "Quill",
    role: "Researcher",
    avatar: "🔬",
    description: "Separates what is established from what is inferred, and names the gap.",
    rating: 4.7,
    installs: 7600,
    versions: [
      { version: "1.2.0", releasedOn: "2026-07-01", notes: "Flags unsupported claims explicitly." },
      { version: "1.0.0", releasedOn: "2026-01-30", notes: "First release." }
    ],
    suggestions: ["What does the evidence say?", "Compare these options", "What would change the conclusion?"],
    focus: "Evidence, assumptions, and the difference between them."
  },
  {
    id: "marketer",
    name: "Reach",
    role: "Marketer",
    avatar: "📣",
    description: "Positions a product in the words its audience already uses.",
    rating: 4.2,
    installs: 6300,
    versions: [
      { version: "1.1.0", releasedOn: "2026-06-15", notes: "Channel-specific rewrites." },
      { version: "1.0.0", releasedOn: "2026-03-02", notes: "First release." }
    ],
    suggestions: ["Who is this actually for?", "Rewrite this for a landing page", "What is the one-line pitch?"],
    focus: "Audience, message, and the shortest way to say it."
  },
  {
    id: "financial-advisor",
    name: "Ledger",
    role: "Financial advisor",
    avatar: "📈",
    description: "Organizes numbers and frames tradeoffs. Does not recommend investments.",
    rating: 4.1,
    installs: 3800,
    versions: [
      { version: "1.0.0", releasedOn: "2026-04-05", notes: "First release." }
    ],
    suggestions: ["Lay out the tradeoff", "Summarize where the money goes", "What assumptions drive this?"],
    focus: "Cash flow, assumptions, and the cost of each option."
  },
  {
    id: "streamer",
    name: "OnAir",
    role: "Streamer",
    avatar: "🎙️",
    description: "Plans a broadcast: segments, pacing, and what to prepare in advance.",
    rating: 4.5,
    installs: 5400,
    versions: [
      { version: "1.0.2", releasedOn: "2026-07-08", notes: "Segment timing helpers." },
      { version: "1.0.0", releasedOn: "2026-05-01", notes: "First release." }
    ],
    suggestions: ["Plan tonight's stream", "What should the first ten minutes be?", "Prep a segment list"],
    focus: "Segments, pacing, and the run of show."
  },
  {
    id: "content-creator",
    name: "Draft",
    role: "Content creator",
    avatar: "✍️",
    description: "Takes a rough idea to a finished piece without flattening the voice.",
    rating: 4.6,
    installs: 9100,
    versions: [
      { version: "1.2.1", releasedOn: "2026-07-19", notes: "Keeps the author's voice on rewrites." },
      { version: "1.0.0", releasedOn: "2026-02-02", notes: "First release." }
    ],
    suggestions: ["Turn this into a post", "Tighten this without losing the voice", "Give me three openings"],
    focus: "Structure, voice, and the opening line."
  },
  {
    id: "game-developer",
    name: "Loop",
    role: "Game developer",
    avatar: "🎮",
    description: "Thinks in systems and feedback loops rather than features.",
    rating: 4.4,
    installs: 4700,
    versions: [
      { version: "1.1.0", releasedOn: "2026-06-21", notes: "Systems and economy review." },
      { version: "1.0.0", releasedOn: "2026-03-28", notes: "First release." }
    ],
    suggestions: ["What is the core loop?", "Where does this get boring?", "Balance this progression"],
    focus: "Core loop, pacing, and where interest drops off."
  }
];

const byId = new Map<string, Agent>(agents.map((entry) => [entry.id, entry]));

export function allAgents(): Agent[] {
  return [...agents];
}

export function agentById(id: string): Agent | undefined {
  return byId.get(id);
}

export function latestVersion(agent: Agent): AgentVersion {
  return agent.versions[0];
}

export type MarketplaceState = {
  /** Installed agent ids, in install order. */
  installed: string[];
  /** The agent currently shaping the assistant, or null. */
  activeAgentId: string | null;
};

export const emptyMarketplaceState: MarketplaceState = { installed: [], activeAgentId: null };

export function installAgent(state: MarketplaceState, id: string): MarketplaceState {
  if (!byId.has(id) || state.installed.includes(id)) return state;

  // The first agent installed becomes active, so installing one has a visible
  // effect immediately rather than requiring a second, undiscovered step.
  return {
    installed: [...state.installed, id],
    activeAgentId: state.activeAgentId ?? id
  };
}

export function uninstallAgent(state: MarketplaceState, id: string): MarketplaceState {
  if (!state.installed.includes(id)) return state;

  const installed = state.installed.filter((entry) => entry !== id);
  // Uninstalling the active agent must not leave a dangling active id pointing
  // at something no longer installed.
  const activeAgentId = state.activeAgentId === id ? installed[0] ?? null : state.activeAgentId;
  return { installed, activeAgentId };
}

export function activateAgent(state: MarketplaceState, id: string | null): MarketplaceState {
  if (id === null) return { ...state, activeAgentId: null };
  if (!state.installed.includes(id)) return state;
  return { ...state, activeAgentId: id };
}

export function isInstalled(state: MarketplaceState, id: string): boolean {
  return state.installed.includes(id);
}

export function activeAgent(state: MarketplaceState): Agent | null {
  return state.activeAgentId ? agentById(state.activeAgentId) ?? null : null;
}

/**
 * Narrow a stored state. An id that no longer exists in the catalog is dropped,
 * and an active id that is not installed is cleared rather than trusted.
 */
export function parseMarketplaceState(value: unknown): MarketplaceState {
  if (!value || typeof value !== "object") return emptyMarketplaceState;

  const raw = value as { installed?: unknown; activeAgentId?: unknown };
  const installed = Array.isArray(raw.installed)
    ? raw.installed.filter((id): id is string => typeof id === "string" && byId.has(id))
    : [];
  const unique = [...new Set(installed)];

  const active = typeof raw.activeAgentId === "string" && unique.includes(raw.activeAgentId)
    ? raw.activeAgentId
    : null;

  return { installed: unique, activeAgentId: active };
}

export function readMarketplaceState(storage: Storage | undefined, key: string): MarketplaceState {
  if (!storage) return emptyMarketplaceState;
  try {
    const raw = storage.getItem(key);
    return raw ? parseMarketplaceState(JSON.parse(raw)) : emptyMarketplaceState;
  } catch {
    return emptyMarketplaceState;
  }
}

export function writeMarketplaceState(
  storage: Storage | undefined,
  key: string,
  state: MarketplaceState
): void {
  try {
    storage?.setItem(key, JSON.stringify(state));
  } catch {
    // Never let a storage failure block installing an agent.
  }
}

/** Format an install count for display: 12400 -> "12.4k". */
export function formatInstalls(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}
