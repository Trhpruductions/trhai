import { useEffect, useState } from "react";
import { Conversation } from "./Conversation";
import { StatusBar } from "./StatusBar";
import { resolvePersonality, type PersonalityId } from "../personalities";
import { webEnv } from "../env";
import "./shell.css";

// The shell.
//
// One rail, one screen at a time. The previous layout ran seven top tabs and
// thirteen sidebar entries at once, and the effect was that nothing looked more
// important than anything else — including the conversation, which is what the
// app is actually for.

export type SurfaceId =
  | "chat"
  | "build"
  | "knowledge"
  | "memory"
  | "automation"
  | "calendar"
  | "agents"
  | "workspace"
  | "settings";

type Surface = {
  id: SurfaceId;
  label: string;
  /** Single glyph; the rail is too narrow for words and a tooltip carries them. */
  glyph: string;
  hint: string;
};

/**
 * The rail, in the order it is used.
 *
 * Deliberately short. Everything that used to be its own destination and is
 * really a view of something else — projects, files, terminal, marketplace —
 * now lives inside the surface it belongs to, rather than competing for a slot.
 */
const surfaces: Surface[] = [
  { id: "chat", label: "Chat", glyph: "◉", hint: "Talk to the assistant" },
  { id: "build", label: "Build", glyph: "◈", hint: "Generate a working app" },
  { id: "knowledge", label: "Knowledge", glyph: "▤", hint: "Documents it can quote" },
  { id: "memory", label: "Memory", glyph: "◇", hint: "What it remembers" },
  { id: "automation", label: "Automation", glyph: "⟲", hint: "Flows you can run" },
  { id: "calendar", label: "Calendar", glyph: "▦", hint: "Your schedule" },
  { id: "agents", label: "Agents", glyph: "◐", hint: "Installed agents" },
  { id: "workspace", label: "Workspace", glyph: "▣", hint: "Projects, host readings and a shell" },
  { id: "settings", label: "Settings", glyph: "⚙", hint: "Personality and defaults" }
];

const personalityStorageKey = "ascend.personality.v1";

export type SurfaceContext = {
  personality: PersonalityId;
  setPersonality: (id: PersonalityId) => void;
  /** A request handed over from chat, for the build surface to start from. */
  buildSeed: string | null;
  clearBuildSeed: () => void;
};

type Props = {
  /** Rendered for surfaces beyond chat; supplied by the app so the shell stays presentational. */
  renderSurface: (id: SurfaceId, context: SurfaceContext) => React.ReactNode;
  /** Whether the local model is reachable, for the status line. */
  modelLabel: string | null;
};

export function AppShell({ renderSurface, modelLabel }: Props) {
  // Always the conversation, whatever was open last. The app is a conversation
  // first, and reopening into whichever screen you happened to close on — a
  // settings page, a half-finished build — buries the thing it is for. The
  // comment here used to say this while the code restored the last surface.
  const [surface, setSurface] = useState<SurfaceId>("chat");

  // Local storage is the starting guess so the first paint is not a flicker of
  // the wrong personality; the API is the authority and corrects it a moment
  // later. Keeping the local copy also means the app still opens with the right
  // personality if the service is slow to come up.
  const [personality, setPersonalityState] = useState<PersonalityId>(
    () => resolvePersonality(window.localStorage.getItem(personalityStorageKey))
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/preferences`);
        if (!response.ok) return;
        const payload = await response.json();
        const stored = resolvePersonality(payload?.data?.personality ?? null);
        if (!cancelled) {
          setPersonalityState(stored);
          window.localStorage.setItem(personalityStorageKey, stored);
        }
      } catch {
        // Offline or still starting: the local copy stands until it answers.
      }
    })();

    return () => { cancelled = true; };
  }, []);

  /** Writes through to the API so the desktop window and a browser tab agree. */
  const setPersonality = (next: PersonalityId) => {
    setPersonalityState(next);
    window.localStorage.setItem(personalityStorageKey, next);

    void fetch(`${webEnv.apiBaseUrl}/v1/preferences`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personality: next })
    }).catch(() => {
      // The choice is already applied here; a failed write means the other
      // surface will not learn about it until this one is used again.
    });
  };

  const [buildSeed, setBuildSeed] = useState<string | null>(null);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections">
        {/* The same chevron as the core, small. A letter in a box is a
            placeholder; the mark is the app saying its own name. */}
        <div className="rail-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M5 8 L12 18 L19 8" fill="none" stroke="currentColor"
              strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {surfaces.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`rail-btn${surface === entry.id ? " active" : ""}`}
            aria-label={entry.label}
            aria-current={surface === entry.id ? "page" : undefined}
            title={`${entry.label} — ${entry.hint}`}
            onClick={() => setSurface(entry.id)}
          >
            <span aria-hidden="true">{entry.glyph}</span>
          </button>
        ))}

        <div className="rail-foot">
          {/* The one piece of always-on status worth a permanent slot: whether
              there is a model, because it decides what the assistant can do. */}
          <span
            className={`rail-status${modelLabel ? " live" : ""}`}
            title={modelLabel ? `Local model: ${modelLabel}` : "No local model — answers come from your notes and documents only"}
            aria-label={modelLabel ? `Local model ${modelLabel}` : "No local model"}
          />
        </div>
      </nav>

      <main className="stage">
        {surface === "chat" ? (
          <Conversation
            personality={personality}
            onBuildRequest={(request) => { setBuildSeed(request); setSurface("build"); }}
          />
        ) : (
          renderSurface(surface, {
            personality,
            setPersonality,
            buildSeed,
            clearBuildSeed: () => setBuildSeed(null)
          })
        )}
      </main>

      {/* Spans the full width beneath both columns: it describes the whole app,
          not the screen that happens to be open. */}
      <StatusBar />
    </div>
  );
}
