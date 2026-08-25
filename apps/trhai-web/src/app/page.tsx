"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Core } from "../components/Core";
import { useAssistant, type AssistantStatus } from "../hooks/useAssistant";
import { useMicrophone } from "../hooks/useMicrophone";
import { apiBaseUrl, apiGet, sessionId } from "../lib/api";
import { readStoredPersonality } from "../lib/personality";
import { activeAgent, personalityById, readMarketplaceState, readFlow, type Agent } from "@ascend/shared";
import { marketplaceStorageKey } from "../lib/agents";
import "./dash.css";

// The command centre: one screen, with TRHAI's core at the middle of it.
//
// Every reading on this screen is something this machine actually knows. The
// panels are shaped like the HUD they were designed from, but nothing is
// filled with a plausible-looking number to complete the picture — where a
// figure would have to be invented (host CPU and RAM, which need the desktop
// bridge this app does not have), the panel reports something real instead
// rather than a convincing fiction. A HUD that lies to look finished is
// worse than one with fewer dials.

type ModelInfo = { available: true; model: string } | { available: false; reason: string };

type Presence = { core: "idle" | "listening" | "thinking" | "executing" | "success" | "error"; label: string };

/**
 * What the core does and what the status line says, from real state alone.
 *
 * Listening outranks the request states because it describes the device
 * rather than the request: if the microphone is genuinely open, that is the
 * most important true thing on the screen.
 */
function presence(status: AssistantStatus, listening: boolean): Presence {
  if (listening) return { core: "listening", label: "LISTENING" };
  if (status.state === "executing") return { core: "executing", label: `WORKING · ${status.tool.replace(/_/g, " ").toUpperCase()}` };
  if (status.state === "thinking") return { core: "thinking", label: "THINKING" };
  if (status.state === "success") return { core: "success", label: "COMPLETE" };
  if (status.state === "error") return { core: "error", label: "ERROR" };
  return { core: "idle", label: "STANDING BY" };
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The activity trace across the top.
 *
 * Bars are a rolling window of the core's own real activity level — 0 when
 * idle, higher while the model is working — not a synthesised audio signal.
 * There is no microphone in this build, so a waveform claiming to show a
 * voice would be showing nothing at all.
 */
function ActivityTrace({ level, label }: { level: number; label: string }) {
  const bars = 72;
  const [seed, setSeed] = useState(0);

  // Idle still advances, just slowly and shallowly: an instrument at rest
  // shows a live baseline, not a flat line, and a flat line here reads as
  // "disconnected" rather than "ready". The amplitude below is what carries
  // the real distinction between resting and working.
  //
  // Deliberately keyed on *whether* there is activity, not on the level
  // itself: while the microphone is open the level changes every animation
  // frame, and depending on it here would tear down and rebuild this
  // interval dozens of times a second.
  const active = level > 0;
  useEffect(() => {
    const period = active ? 90 : 420;
    const timer = window.setInterval(() => setSeed((value) => value + 1), period);
    return () => window.clearInterval(timer);
  }, [active]);

  return (
    <div className="trace" aria-hidden="true">
      <div className="trace-bars">
        {Array.from({ length: bars }, (_, index) => {
          // Deterministic per (index, seed): a stable shape that advances,
          // rather than a fresh random field every frame.
          const wave = Math.sin((index + seed) * 0.55) * Math.sin((index + seed) * 0.17);
          const raw = active
            ? 3 + Math.abs(wave) * level * 26
            : 2 + Math.abs(wave) * 4;
          // Rounded for the same reason Core.tsx rounds its tick geometry:
          // Math.sin is only required to be implementation-approximated, so
          // Node's V8 and the browser's V8 can legitimately differ in the
          // last digits for identical input. Full precision made the first
          // paint a hydration mismatch on every bar.
          const height = Math.round(raw * 100) / 100;
          return <span key={index} className="trace-bar" style={{ height: `${height}px` }} />;
        })}
      </div>
      <span className={`trace-label${level > 0 ? " trace-label-live" : ""}`}>{label}</span>
    </div>
  );
}

const navItems = [
  { href: "/", label: "Dashboard", hint: "Overview & system status" },
  { href: "/chat", label: "AI Chat", hint: "Talk to TRHAI" },
  { href: "/tasks", label: "Tasks", hint: "Your to-do list" },
  { href: "/calendar", label: "Calendar", hint: "Your schedule" },
  { href: "/memory", label: "Memory Core", hint: "Stored knowledge" },
  { href: "/knowledge", label: "Knowledge", hint: "Documents & sources" },
  { href: "/automation", label: "Automation", hint: "Flows & runs" },
  { href: "/agents", label: "Agents", hint: "Installed lenses" },
  { href: "/security", label: "Security", hint: "Tools & permissions" },
  { href: "/settings", label: "Settings", hint: "Voice, theme, personality" }
];

const quickCommands = [
  "What can you do?",
  "Summarise what changed today",
  "What is on my task list?",
  "What do you remember about me?"
];

export default function DashboardPage() {
  const { messages, status, send } = useAssistant();
  const [clock, setClock] = useState<Date | null>(null);
  const [draft, setDraft] = useState("");
  const [online, setOnline] = useState<boolean | null>(null);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [counts, setCounts] = useState<{ tools: number | null; memories: number | null; documents: number | null; tasks: number | null }>({
    tools: null, memories: null, documents: null, tasks: null
  });
  const [agent, setAgent] = useState<Agent | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [flowName, setFlowName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const mic = useMicrophone();
  const { core, label } = presence(status, mic.listening);

  /**
   * The microphone button. Starting listens; stopping transcribes and puts
   * what was said in the command box for the user to check and send.
   *
   * Deliberately not sent automatically: a transcript is a guess at speech,
   * and firing a request off a guess the user has not seen is how a voice
   * feature does something they did not ask for.
   */
  async function handleMic() {
    if (!mic.listening) {
      await mic.start();
      return;
    }

    const said = await mic.stop();
    if (said) setDraft((existing) => (existing ? `${existing} ${said}` : said));
  }
  // While the microphone is open the trace shows the room's actual loudness;
  // otherwise it shows how hard the core is working. Both are real readings,
  // and neither is a stand-in for the other.
  const level = mic.listening
    ? mic.amplitude
    : status.state === "executing" ? 1 : status.state === "thinking" ? 0.6 : 0;
  const busy = status.state === "thinking" || status.state === "executing";
  const lastReply = [...messages].reverse().find((message) => message.role === "assistant") ?? null;

  // Clock starts null and fills in on the client: rendering a time on the
  // server guarantees it disagrees with the client a second later, which is
  // a real hydration error rather than a cosmetic one.
  useEffect(() => {
    setClock(new Date());
    const ticker = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    const personality = personalityById(readStoredPersonality(window.localStorage));
    const installed = activeAgent(readMarketplaceState(window.localStorage, marketplaceStorageKey));
    setAgent(installed);
    setSuggestions(installed?.suggestions ?? personality.suggestions);
    setFlowName(readFlow(window.localStorage, "trhai.automation.flow.v1")?.name ?? null);
  }, []);

  const probe = useCallback(async () => {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${apiBaseUrl}/v1/assist/model`);
      const elapsed = Math.round(performance.now() - startedAt);
      setOnline(response.ok);
      setLatency(response.ok ? elapsed : null);
      if (response.ok) {
        const payload = await response.json();
        setInfo(payload?.data?.available
          ? { available: true, model: payload.data.model }
          : { available: false, reason: payload?.data?.reason ?? "No local model is running." });
      }
    } catch {
      setOnline(false);
      setLatency(null);
    }
  }, []);

  useEffect(() => {
    void probe();
    const poller = window.setInterval(probe, 5000);
    return () => window.clearInterval(poller);
  }, [probe]);

  // Real counts from the real routes. Anything unreachable stays null and
  // renders as a dash — never as a zero, which would be a measurement.
  useEffect(() => {
    const id = sessionId();
    void Promise.all([
      apiGet<{ tools: unknown[] }>("/v1/capabilities"),
      apiGet<{ memories: unknown[] }>(`/v1/assist/memory?sessionId=${id}`),
      apiGet<{ documents: unknown[] }>(`/v1/knowledge?sessionId=${id}`),
      apiGet<{ tasks: Array<{ done: boolean }> }>(`/v1/tasks?sessionId=${id}`)
    ]).then(([capabilities, memory, knowledge, tasks]) => {
      setCounts({
        tools: capabilities.ok ? capabilities.data.tools.length : null,
        memories: memory.ok ? memory.data.memories.length : null,
        documents: knowledge.ok ? knowledge.data.documents.length : null,
        tasks: tasks.ok ? tasks.data.tasks.filter((task) => !task.done).length : null
      });
    });
  }, []);

  // Answered right here rather than by handing the request to another screen.
  // The core reacting to your own question, on the screen you asked it from,
  // is the entire point of a command centre — bouncing to /chat to watch it
  // happen somewhere else is the "navigating a website" feeling this screen
  // exists to avoid. The full transcript still lives on /chat; this shows
  // the latest exchange.
  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft("");
    void send(trimmed);
  }

  const modelName = info?.available ? info.model.replace(/^ollama\//, "").replace(/:latest$/, "") : null;

  return (
    <div className={`hud hud-${core}`}>
      <header className="hud-top">
        <div className="hud-top-left">
          <span className={`hud-dot${online ? " live" : ""}`} aria-hidden="true" />
          <span className="hud-label">TRHAI {online === null ? "CONNECTING" : online ? "ONLINE" : "OFFLINE"}</span>
        </div>
        <div className="hud-top-mark">
          <span className="hud-wordmark">TRHAI</span>
          <span className="hud-version">v1.0</span>
        </div>
        <div className="hud-top-right mono">
          {clock ? (
            <>
              <span className="hud-clock">{clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
              <span className="hud-date">{clock.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
            </>
          ) : <span className="hud-clock">--:--</span>}
        </div>
      </header>

      <div className="hud-body">
        <div className="hud-rail-col">
          <nav className="hud-rail" aria-label="Sections">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className={`rail-item${item.href === "/" ? " active" : ""}`}>
                <span className="rail-label">{item.label}</span>
                <span className="rail-hint">{item.hint}</span>
              </Link>
            ))}
          </nav>

          <section className="hud-panel hud-quick">
            <span className="hud-label">Quick commands</span>
            {quickCommands.map((command) => (
              <button key={command} type="button" className="hud-quick-item" onClick={() => ask(command)}>
                {command}
              </button>
            ))}
          </section>
        </div>

        <main className="hud-stage">
          <ActivityTrace level={level} label={label} />

          <div className="hud-core-wrap">
            <Core state={core} size={380} amplitude={mic.listening ? mic.amplitude : undefined} />
            <div className="hud-core-text">
              <span className="hud-core-name">TRHAI</span>
            </div>
          </div>
          <span className="hud-core-tag">YOUR MACHINE · YOUR MODEL · NO KEYS</span>

          {agent ? (
            <p className="hud-agent">
              <span aria-hidden="true">{agent.avatar}</span> <b>{agent.name}</b> — {agent.focus}
            </p>
          ) : null}

          <div className="hud-ask">
            <input
              ref={inputRef}
              className="hud-ask-field"
              value={draft}
              placeholder={busy ? "TRHAI is working…" : "Ask TRHAI anything…"}
              aria-label="Ask TRHAI anything"
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") ask(draft); }}
            />
            {mic.supported ? (
              <button
                type="button"
                className={`hud-mic${mic.listening ? " hud-mic-live" : ""}`}
                aria-pressed={mic.listening}
                disabled={mic.transcribing}
                aria-label={mic.listening ? "Stop listening" : "Start listening"}
                title={mic.listening
                  ? "Stop and transcribe"
                  : mic.transcriptionAvailable === false
                    ? `${mic.transcriptionReason} The microphone still works as a level meter.`
                    : "Speak your request. The audio is transcribed on this machine and never uploaded."}
                onClick={() => void handleMic()}
              >
                {mic.transcribing ? "…" : "●"}
              </button>
            ) : null}
            <button type="button" className="hud-ask-go" onClick={() => ask(draft)} disabled={!draft.trim() || busy}>
              {busy ? "…" : "Send"}
            </button>
          </div>

          {mic.error ? <p className="hud-mic-note">{mic.error}</p> : null}

          {mic.transcribing ? (
            <p className="hud-mic-note">Transcribing on this machine&hellip;</p>
          ) : mic.listening ? (
            <p className="hud-mic-note">
              {mic.transcriptionAvailable
                ? "Listening. Press again to stop — what you said is transcribed on this machine and never uploaded."
                : `Listening, but only as a level meter: ${mic.transcriptionReason}`}
            </p>
          ) : null}

          <div className="hud-suggestions">
            {(suggestions.length > 0 ? suggestions : quickCommands).slice(0, 4).map((suggestion) => (
              <button key={suggestion} type="button" className="hud-chip" onClick={() => ask(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </main>

        <aside className="hud-side">
          <section className="hud-panel">
            <span className="hud-label">System status</span>
            <div className="hud-gauges">
              <Gauge label="Tools" value={counts.tools} suffix="" />
              <Gauge label="Memory" value={counts.memories} suffix="" />
              <Gauge label="Docs" value={counts.documents} suffix="" />
            </div>
            <dl className="hud-readouts">
              <div><dt>Model</dt><dd className={modelName ? "ok" : "warn"}>{modelName ?? "none"}</dd></div>
              <div><dt>Latency</dt><dd>{latency === null ? "—" : `${latency}ms`}</dd></div>
              <div><dt>Open tasks</dt><dd>{counts.tasks === null ? "—" : counts.tasks}</dd></div>
              <div><dt>Core</dt><dd className={online ? "ok" : "danger"}>{online === null ? "—" : online ? "OPERATIONAL" : "UNREACHABLE"}</dd></div>
            </dl>
          </section>

          <section className="hud-panel hud-say">
            <div className="hud-say-head">
              <span className="hud-label">TRHAI</span>
              {lastReply?.model ? (
                <span className="hud-say-model mono">{lastReply.model.replace(/^ollama\//, "").replace(/:latest$/, "")}</span>
              ) : null}
            </div>
            <p className="hud-say-text">
              {status.state === "error"
                ? status.detail
                : busy
                  ? label === "THINKING" ? "Thinking…" : "Working on it…"
                  : online === false
                    ? "The local API is not responding. Start it and this updates on its own."
                    : lastReply
                      ? lastReply.text
                      : modelName
                        ? `${greetingFor(clock ?? new Date())}, Hank. Answering with ${modelName}. How can I help?`
                        : "Reachable, but no local model is loaded — I can't generate a reply yet."}
            </p>
            {lastReply?.toolsUsed && lastReply.toolsUsed.length > 0 && !busy ? (
              <div className="hud-say-tools">
                {lastReply.toolsUsed.map((tool, index) => (
                  <span key={`${tool.name}-${index}`} className="hud-tool-chip">
                    {tool.name.replace(/_/g, " ")}{tool.ok ? "" : " — nothing changed"}
                  </span>
                ))}
              </div>
            ) : null}
            {lastReply ? <Link href="/chat" className="hud-more">Full conversation</Link> : null}
          </section>

          <section className="hud-panel">
            <span className="hud-label">Automation</span>
            {flowName ? (
              <div className="hud-flow">
                <b>{flowName}</b>
                <span className="faint">Saved on this machine · run it from Automation</span>
              </div>
            ) : (
              <p className="faint">No flow saved yet.</p>
            )}
            <Link href="/automation" className="hud-more">Open automation</Link>
          </section>
        </aside>
      </div>

      <footer className="hud-bottom mono">
        <span>{label}</span>
        <span className="hud-sep">·</span>
        <span>{counts.tools === null ? "—" : `${counts.tools} tools registered`}</span>
        <span className="hud-sep">·</span>
        <span>Everything on this screen is measured on this machine.</span>
      </footer>
    </div>
  );
}

/** A count, or a dash. Never a zero standing in for "not known". */
function Gauge({ label, value, suffix }: { label: string; value: number | null; suffix: string }) {
  return (
    <div className="gauge">
      <div className="gauge-ring">
        <span className="gauge-value">{value === null ? "—" : `${value}${suffix}`}</span>
      </div>
      <span className="gauge-label">{label}</span>
    </div>
  );
}
