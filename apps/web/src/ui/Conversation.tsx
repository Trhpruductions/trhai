import { useEffect, useRef, useState } from "react";
import { useAssistant, type ChatMessage } from "../state/useAssistant";
import { personalityById, resolvePersonality, type PersonalityId } from "../personalities";
import { readEvents } from "../localCalendar";
import { webEnv } from "../env";
import { Core } from "./Core";
import { greetingFor } from "../greeting";
import "./conversation.css";

// The home screen: a conversation.
//
// It opens here because this is what the app is for. The previous shell opened
// on a dashboard whose most prominent control was labelled "Ask anything..."
// and wired to the project generator, so the ordinary act of asking a question
// produced a scaffold path instead of an answer.

type Props = {
  personality: PersonalityId;
  onBuildRequest: (request: string) => void;
};

/**
 * How a reply was produced, in the user's words rather than the code's.
 *
 * Shown on every assistant turn. The whole app is built on not implying
 * knowledge it does not have, and this is where that becomes visible: a
 * sentence quoted from a saved note reads very differently from one a model
 * wrote, and the user is entitled to know which they are looking at.
 */
function provenanceOf(message: ChatMessage): { label: string; tone: string } | null {
  switch (message.strategy) {
    case "generated":
      // Same shape as the status bar shows, so the two never look like they
      // are naming different models.
      return { label: message.model?.replace(/^ollama\//, "").replace(/:latest$/, "") ?? "local model", tone: "chip-live" };
    case "answer":
      return { label: "from your notes", tone: "chip-ok" };
    case "no-answer":
    case "not-saved":
      return { label: "nothing matched", tone: "chip-warn" };
    case "plan":
      return { label: "plan", tone: "chip" };
    case "error":
      return { label: "service error", tone: "chip-danger" };
    default:
      return null;
  }
}

/** Tool names as an action the reader recognises, not as an identifier. */
function toolLabel(tool: string): string {
  switch (tool) {
    case "search_memory": return "searched memory";
    case "search_documents": return "searched documents";
    case "remember": return "saved to memory";
    case "current_datetime": return "checked the time";
    case "list_memories": return "read memory";
    case "forget": return "deleted from memory";
    case "list_documents": return "listed documents";
    case "read_document": return "read a document";
    case "write_document": return "wrote a document";
    case "calculate": return "calculated";
    case "plan_app": return "planned an app";
    default: return tool.replace(/_/g, " ");
  }
}

function Turn({ message, onBuildRequest }: { message: ChatMessage; onBuildRequest: (r: string) => void }) {
  const provenance = message.role === "assistant" ? provenanceOf(message) : null;

  return (
    <article className={`turn turn-${message.role}`}>
      <header className="turn-head">
        <span className="label">{message.role === "user" ? "You" : "Ascend"}</span>
        {provenance ? <span className={`chip ${provenance.tone}`}>{provenance.label}</span> : null}
      </header>

      {/* Preserves the newlines the assistant writes; its answers are often
          lists, and collapsing them made every reply a wall. */}
      <div className="turn-body">{message.text}</div>

      {/* What it actually did to answer. A reply that searched your notes and
          found nothing reads very differently from one it simply wrote, and
          without this the two look identical. */}
      {message.toolsUsed && message.toolsUsed.length > 0 ? (
        <div className="turn-tools">
          {message.toolsUsed.map((tool, index) => (
            <span key={`${tool}-${index}`} className="chip chip-tool">{toolLabel(tool)}</span>
          ))}
        </div>
      ) : null}

      {message.buildRequest ? (
        <button type="button" className="btn btn-primary btn-sm turn-action"
          onClick={() => onBuildRequest(message.buildRequest!)}>
          Build this
        </button>
      ) : null}
    </article>
  );
}

export function Conversation({ personality, onBuildRequest }: Props) {
  const { messages, status, restored, send, clear, sessionId } = useAssistant();
  const [draft, setDraft] = useState("");
  const [stats, setStats] = useState<Array<{ label: string; value: string }>>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [linkMs, setLinkMs] = useState<number | null>(null);
  // Bumped on every completed poll. Used as a React key so the reading
  // remounts and replays its animation — the flicker marks a real refresh
  // rather than running on a timer of its own.
  const [pollCount, setPollCount] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const endRef = useRef<HTMLDivElement>(null);
  const profile = personalityById(resolvePersonality(personality));

  // The clock on the home screen is the real one, ticking. It is the cheapest
  // honest signal that the app is running rather than a screenshot of itself.
  useEffect(() => {
    const ticker = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  // Reachability and which model is answering. Polled while the home screen is
  // showing so the core reflects the service rather than assuming it.
  useEffect(() => {
    if (messages.length > 0) return;
    let cancelled = false;

    async function probe() {
      // Timed here rather than reported by the server, so the figure is the
      // round trip the user actually waits on.
      const startedAt = performance.now();
      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/model`);
        const elapsed = Math.round(performance.now() - startedAt);
        const payload = response.ok ? await response.json() : null;
        if (cancelled) return;
        setOnline(response.ok);
        setLinkMs(response.ok ? elapsed : null);
        setModel(payload?.data?.available ? payload?.data?.model ?? null : null);
        setPollCount((count) => count + 1);
      } catch {
        if (!cancelled) { setOnline(false); setModel(null); setLinkMs(null); }
      }
    }

    void probe();
    const poll = window.setInterval(probe, 5000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [messages.length]);

  // Real counts for the opening screen, read once when there is nothing to show.
  // They are what this app is holding, so an empty conversation still says
  // something true about the state of the system.
  useEffect(() => {
    if (messages.length > 0) return;
    let cancelled = false;

    (async () => {
      const ask = async (path: string, key: string) => {
        try {
          const response = await fetch(`${webEnv.apiBaseUrl}${path}?sessionId=${encodeURIComponent(sessionId)}`);
          if (!response.ok) return 0;
          const payload = await response.json();
          return (payload?.data?.[key] ?? []).length as number;
        } catch {
          return 0;
        }
      };

      const [memories, documents] = await Promise.all([
        ask("/v1/assist/memory", "memories"),
        ask("/v1/knowledge", "documents")
      ]);

      const events = readEvents(window.localStorage, "ascend.calendar.events.v1").length;
      if (cancelled) return;

      // Singular when there is one of something: "1 documents" is the kind of
      // detail that makes an interface feel unattended.
      const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

      setStats([
        { label: plural(memories, "remembered", "remembered"), value: String(memories) },
        { label: plural(documents, "document", "documents"), value: String(documents) },
        { label: plural(events, "event", "events"), value: String(events) }
      ]);
    })();

    return () => { cancelled = true; };
  }, [messages.length, sessionId]);

  // Follow the conversation as it grows, including while a reply streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, status.state]);

  const busy = status.state === "thinking";

  function submit() {
    if (!draft.trim() || busy) return;
    void send(draft);
    setDraft("");
  }

  return (
    <section className="conversation" aria-label="Conversation">
      <header className="conversation-head">
        <div className="row">
          <h2 className="label">Conversation</h2>
          <span className="chip">{profile.label}</span>
        </div>
        {messages.length > 0 ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void clear()}>
            Clear
          </button>
        ) : null}
      </header>

      <div className="conversation-scroll scroll-y">
        {messages.length === 0 ? (
          <div className="home">
            {/* Corner brackets. The home screen is a panel in an instrument
                rather than a page in a document, and the brackets are what
                say so without adding a single word. */}
            <span className="home-frame" aria-hidden="true" />

            <div className="home-assembly">
              {/* Left rail: the link. What is answering, and how quickly. */}
              <dl className="home-rail home-rail-left">
                <div className="home-readout">
                  <dt className="label">Model</dt>
                  <dd className={`mono${model ? "" : " home-readout-absent"}`}>
                    {model ? model.replace(/:latest$/, "") : "none"}
                  </dd>
                </div>
                <div className="home-readout">
                  <dt className="label">Link</dt>
                  <dd key={pollCount} className={`mono home-readout-live${linkMs === null ? " home-readout-absent" : ""}`}>
                    {linkMs === null ? "—" : `${linkMs}ms`}
                  </dd>
                </div>
                <div className="home-readout">
                  <dt className="label">Voice</dt>
                  <dd className="mono">{profile.label}</dd>
                </div>
              </dl>

              <div className="home-core">
                <Core state={busy ? "thinking" : online === false ? "offline" : "idle"} />

                {/* Sits inside the rings. The clock is live and the date is
                    today's, so the centre of the screen is never stale. */}
                <div className="home-core-face">
                  <span className="home-time mono">
                    {clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="home-date label">
                    {clock.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                  </span>
                </div>
              </div>

              {/* Right rail: the store. What the app is actually holding.
                  These are counts it read, not figures it composed. */}
              <dl className="home-rail home-rail-right">
                {stats.map((stat) => (
                  <div key={stat.label} className="home-readout">
                    <dt className="label">{stat.label}</dt>
                    <dd className="mono home-readout-count">{stat.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="home-greeting">
              <h3 className="home-hello">{greetingFor(clock)}</h3>
              <span className="home-rule" aria-hidden="true" />
              <p className="home-sub muted">
                {online === false
                  ? "The local service is not responding. Nothing can be answered until it is back."
                  : model
                    ? "Answers come from the local model, from what you have asked me to remember, and from your documents."
                    : "No local model is running — answers come from your notes and documents only."}
              </p>
            </div>

            <div className="row wrap conversation-suggestions">
              {profile.suggestions.map((suggestion) => (
                <button key={suggestion} type="button" className="btn btn-sm"
                  onClick={() => { setDraft(suggestion); }}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <Turn key={message.id} message={message} onBuildRequest={onBuildRequest} />
          ))
        )}

        {busy ? (
          <div className="turn turn-assistant thinking" aria-live="polite">
            {/* The same assembly as the home screen, small and quickened. A
                reply from a local model can take a while, and a spinner says
                only "wait"; this says the machine is working. */}
            <Core state="thinking" size={44} />
            <span className="label">Working…</span>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      <footer className="composer">
        <textarea
          className="field composer-field"
          value={draft}
          rows={1}
          placeholder={restored ? "Ask anything, or describe something to build…" : "Loading conversation…"}
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line. A multi-line message is
            // rare enough that requiring a modifier to send would cost more.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="btn btn-primary composer-send"
          onClick={submit} disabled={busy || !draft.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </footer>
    </section>
  );
}
