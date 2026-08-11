// AI personality system (vision §5).
//
// A personality changes how the assistant sounds, what it suggests, how the AI
// Core moves, and which widgets come first. It changes nothing about what the
// assistant is *allowed* to do: the vision's safety baseline says every
// personality inherits policy and compliance controls, and none may bypass a
// permission gate. That is enforced structurally here — a personality carries no
// capability, scope, or permission field at all, and a test asserts the shape so
// one cannot be quietly added later.
//
// Regulated domains (medical, legal, security) carry a disclaimer that the
// composer always appends. It is not a stylistic preference and there is no flag
// to turn it off.

export type PersonalityId =
  | "professional"
  | "developer"
  | "creative"
  | "business"
  | "research"
  | "teacher"
  | "cyber-security"
  | "gaming"
  | "medical"
  | "legal";

export type VoiceProfile = {
  /** How the assistant should read, in plain words. */
  tone: string;
  cadence: "measured" | "brisk" | "playful" | "deliberate";
  /** Speech synthesis rate and pitch multipliers for voice mode. */
  rate: number;
  pitch: number;
};

export type CorePalette = {
  /** Drives the AI Core's gradient and glow. */
  accent: string;
  glow: string;
  /**
   * Behaviour weighting, 0..1. Higher values make the core's idle breath and
   * thinking rotation more pronounced; it never changes which state is shown,
   * only how energetically that state renders.
   */
  energy: number;
};

export type ResponseStyle = {
  /** Soft cap on reply length. Long answers are trimmed, not truncated mid-word. */
  maxSentences: number;
  formality: "high" | "neutral" | "relaxed";
  /** Whether claims drawn from outside the workspace must name their source. */
  requiresCitations: boolean;
  /**
   * Appended to every reply in this personality. Present only for domains where
   * an unqualified answer could cause real harm.
   */
  mandatoryDisclaimer?: string;
};

export type Personality = {
  id: PersonalityId;
  label: string;
  summary: string;
  voice: VoiceProfile;
  core: CorePalette;
  /** Suggestion strategy: the prompts offered when this personality is active. */
  suggestions: string[];
  /** Widget priority: dashboard widget ids, most relevant first. */
  widgetPriority: string[];
  responseStyle: ResponseStyle;
};

/**
 * The complete set of keys a personality may declare.
 *
 * Enforced by test. The point is to make "this personality can also do X"
 * impossible to express: capability lives in the permission layer, never in a
 * cosmetic profile the user can switch with one click.
 */
export const personalityFields = [
  "id",
  "label",
  "summary",
  "voice",
  "core",
  "suggestions",
  "widgetPriority",
  "responseStyle"
] as const;

const personalities: Personality[] = [
  {
    id: "professional",
    label: "Professional",
    summary: "Clear, direct, and low-ceremony. The default for general work.",
    voice: { tone: "calm and precise", cadence: "measured", rate: 1, pitch: 1 },
    core: { accent: "#22dbff", glow: "rgba(34, 219, 255, 0.45)", energy: 0.45 },
    suggestions: [
      "Summarize what changed today",
      "Draft a status update for this project",
      "What should I do next?"
    ],
    widgetPriority: ["daily-focus", "calendar", "email", "automations", "goals"],
    responseStyle: { maxSentences: 6, formality: "high", requiresCitations: false }
  },
  {
    id: "developer",
    label: "Developer",
    summary: "Terse, code-first, and specific about files and commands.",
    voice: { tone: "matter-of-fact", cadence: "brisk", rate: 1.05, pitch: 0.98 },
    core: { accent: "#7ef0b6", glow: "rgba(126, 240, 182, 0.4)", energy: 0.6 },
    suggestions: [
      "Build me a tool that tracks...",
      "Explain this error",
      "What is failing in the test suite?"
    ],
    widgetPriority: ["cpu", "ram", "recent-files", "github", "automations"],
    responseStyle: { maxSentences: 8, formality: "neutral", requiresCitations: false }
  },
  {
    id: "creative",
    label: "Creative",
    summary: "Generative and exploratory; offers options rather than one answer.",
    voice: { tone: "warm and energetic", cadence: "playful", rate: 1.02, pitch: 1.06 },
    core: { accent: "#c08bff", glow: "rgba(192, 139, 255, 0.45)", energy: 0.85 },
    suggestions: [
      "Give me three directions for this idea",
      "Rewrite this with more energy",
      "What would make this memorable?"
    ],
    widgetPriority: ["suggestions", "recent-files", "daily-focus", "discord"],
    responseStyle: { maxSentences: 10, formality: "relaxed", requiresCitations: false }
  },
  {
    id: "business",
    label: "Business",
    summary: "Framed around cost, risk, and decisions rather than mechanics.",
    voice: { tone: "confident and concise", cadence: "measured", rate: 1, pitch: 0.99 },
    core: { accent: "#ffc879", glow: "rgba(255, 200, 121, 0.42)", energy: 0.4 },
    suggestions: [
      "What is the tradeoff here?",
      "Draft a one-page summary for a decision maker",
      "Where is time going this week?"
    ],
    widgetPriority: ["goals", "calendar", "email", "stocks", "daily-focus"],
    responseStyle: { maxSentences: 6, formality: "high", requiresCitations: false }
  },
  {
    id: "research",
    label: "Research",
    summary: "Careful and sourced; separates what is known from what is inferred.",
    voice: { tone: "even and thorough", cadence: "deliberate", rate: 0.96, pitch: 1 },
    core: { accent: "#8fb8ff", glow: "rgba(143, 184, 255, 0.42)", energy: 0.35 },
    suggestions: [
      "What does the evidence actually say?",
      "Compare these two approaches",
      "What would change my mind?"
    ],
    widgetPriority: ["recent-files", "suggestions", "goals", "calendar"],
    responseStyle: { maxSentences: 12, formality: "neutral", requiresCitations: true }
  },
  {
    id: "teacher",
    label: "Teacher",
    summary: "Builds from what you already know and checks understanding.",
    voice: { tone: "patient and encouraging", cadence: "measured", rate: 0.95, pitch: 1.04 },
    core: { accent: "#6fe3d2", glow: "rgba(111, 227, 210, 0.42)", energy: 0.5 },
    suggestions: [
      "Explain this like I am new to it",
      "Walk me through it step by step",
      "Quiz me on what we just covered"
    ],
    widgetPriority: ["daily-focus", "goals", "recent-files", "calendar"],
    responseStyle: { maxSentences: 10, formality: "neutral", requiresCitations: false }
  },
  {
    id: "cyber-security",
    label: "Cyber Security",
    summary: "Threat-aware and defensive; names assumptions and blast radius.",
    voice: { tone: "steady and exacting", cadence: "deliberate", rate: 0.98, pitch: 0.96 },
    core: { accent: "#ff9a9a", glow: "rgba(255, 154, 154, 0.42)", energy: 0.55 },
    suggestions: [
      "What is exposed here?",
      "Review this change for security risk",
      "What would an attacker try first?"
    ],
    widgetPriority: ["network", "cpu", "automations", "recent-files"],
    responseStyle: {
      maxSentences: 10,
      formality: "high",
      requiresCitations: true,
      mandatoryDisclaimer:
        "Security guidance here is general and defensive. Validate it against your own environment and authorization before acting."
    }
  },
  {
    id: "gaming",
    label: "Gaming",
    summary: "Fast, casual, and focused on what to do right now.",
    voice: { tone: "upbeat", cadence: "brisk", rate: 1.08, pitch: 1.05 },
    core: { accent: "#9dff6b", glow: "rgba(157, 255, 107, 0.45)", energy: 0.95 },
    suggestions: [
      "What should I run next?",
      "Set up a session plan",
      "Track my stats for tonight"
    ],
    widgetPriority: ["gpu", "cpu", "discord", "network", "daily-focus"],
    responseStyle: { maxSentences: 5, formality: "relaxed", requiresCitations: false }
  },
  {
    id: "medical",
    label: "Medical",
    summary: "Organizes health information carefully. Never a substitute for care.",
    voice: { tone: "calm and careful", cadence: "deliberate", rate: 0.94, pitch: 1 },
    core: { accent: "#7fd8ff", glow: "rgba(127, 216, 255, 0.4)", energy: 0.3 },
    suggestions: [
      "Help me organize these notes",
      "What questions should I ask at my appointment?",
      "Summarize this document in plain language"
    ],
    widgetPriority: ["calendar", "daily-focus", "recent-files", "goals"],
    responseStyle: {
      maxSentences: 8,
      formality: "high",
      requiresCitations: true,
      mandatoryDisclaimer:
        "This is general information, not medical advice, and not a diagnosis. Talk to a qualified clinician about your situation."
    }
  },
  {
    id: "legal",
    label: "Legal",
    summary: "Precise with terms and structure. Never a substitute for counsel.",
    voice: { tone: "formal and exact", cadence: "deliberate", rate: 0.95, pitch: 0.97 },
    core: { accent: "#d8c9a3", glow: "rgba(216, 201, 163, 0.4)", energy: 0.3 },
    suggestions: [
      "Summarize this document's obligations",
      "What terms should I look at closely?",
      "Draft questions for a lawyer"
    ],
    widgetPriority: ["recent-files", "calendar", "email", "goals"],
    responseStyle: {
      maxSentences: 8,
      formality: "high",
      requiresCitations: true,
      mandatoryDisclaimer:
        "This is general information, not legal advice, and no attorney-client relationship is created. Consult a licensed lawyer in your jurisdiction."
    }
  }
];

const byId = new Map<PersonalityId, Personality>(personalities.map((entry) => [entry.id, entry]));

export const defaultPersonality: PersonalityId = "professional";

export function allPersonalities(): Personality[] {
  return [...personalities];
}

export function personalityById(id: PersonalityId): Personality {
  const found = byId.get(id);
  if (!found) {
    throw new Error(`Unknown personality: ${id}`);
  }
  return found;
}

/**
 * Narrow an untrusted value (localStorage, a URL, an API echo) to a known id.
 * Anything unrecognized falls back to the default rather than throwing — a bad
 * stored value should not brick the shell on boot.
 */
export function resolvePersonality(value: unknown): PersonalityId {
  return typeof value === "string" && byId.has(value as PersonalityId)
    ? (value as PersonalityId)
    : defaultPersonality;
}

/**
 * Apply the personality's response-style constraints to a finished reply.
 *
 * The disclaimer is appended when absent and never duplicated, so a reply that
 * already carries it (because the composer included one) stays clean.
 */
export function applyResponseStyle(reply: string, id: PersonalityId): string {
  const { responseStyle } = personalityById(id);
  const disclaimer = responseStyle.mandatoryDisclaimer;
  const trimmed = reply.trim();

  if (!disclaimer) {
    return trimmed;
  }

  if (trimmed.includes(disclaimer)) {
    return trimmed;
  }

  return trimmed ? `${trimmed}\n\n${disclaimer}` : disclaimer;
}

/**
 * Order a set of available widget ids by this personality's priority.
 * Widgets the personality does not rank keep their original relative order and
 * follow the ranked ones, so a new widget is never silently dropped.
 */
export function orderWidgets(available: string[], id: PersonalityId): string[] {
  const priority = personalityById(id).widgetPriority;
  const rank = new Map(priority.map((widget, index) => [widget, index]));

  return [...available].sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}
