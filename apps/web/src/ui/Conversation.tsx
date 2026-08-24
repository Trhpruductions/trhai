import { useEffect, useRef, useState } from "react";
import { useAssistant, type ChatMessage } from "../state/useAssistant";
import { personalityById, resolvePersonality, type PersonalityId } from "../personalities";
import { formatRelative, readEvents, upcomingEvents } from "../localCalendar";
import { readFlow } from "../automation";
import { activeAgent, allAgents, isInstalled, readMarketplaceState, type Agent } from "../marketplace";
import { webEnv } from "../env";
import { Core } from "./Core";
import { greetingFor } from "../greeting";
import { Boot } from "./Boot";
import { bootChecksFor } from "../bootChecks";
import { Pulse } from "./Pulse";
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
 * A memory audit entry, as /v1/assist/memory already returns it.
 *
 * Not new tracking — this log has existed since memory controls shipped, it
 * was just never shown anywhere. It is the one real "what did this actually
 * do recently" record in the app.
 */
type AuditEntry = {
  id: string;
  action: "recorded" | "pinned" | "unpinned" | "relabeled" | "forgotten" | "cleared";
  detail: string;
  createdAt: string;
};

/** Always a past moment, unlike localCalendar's formatRelative which is future-only. */
function timeAgo(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const minutes = Math.round((now.getTime() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const auditActionLabel: Record<AuditEntry["action"], string> = {
  recorded: "Remembered",
  pinned: "Pinned",
  unpinned: "Unpinned",
  relabeled: "Renamed",
  forgotten: "Forgot",
  cleared: "Cleared"
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
    case "update_document": return "updated a document";
    case "delete_document": return "deleted a document";
    case "pin_memory": return "marked as important";
    case "search_conversation": return "searched this conversation";
    case "days_between": return "counted days";
    case "shift_date": return "worked out a date";
    case "build_app": return "built and verified an app";
    case "list_files": return "listed files";
    case "read_file": return "read a file";
    case "write_file": return "wrote a file";
    default: return tool.replace(/_/g, " ");
  }
}

/** The same tools, in progress rather than reported after the fact. */
function liveToolLabel(tool: string): string {
  switch (tool) {
    case "search_memory": return "Searching memory";
    case "search_documents": return "Searching your documents";
    case "remember": return "Saving to memory";
    case "current_datetime": return "Checking the time";
    case "list_memories": return "Reading memory";
    case "forget": return "Removing from memory";
    case "list_documents": return "Listing documents";
    case "read_document": return "Reading a document";
    case "write_document": return "Writing a document";
    case "calculate": return "Calculating";
    case "plan_app": return "Planning the app";
    case "update_document": return "Updating a document";
    case "delete_document": return "Deleting a document";
    case "pin_memory": return "Marking as important";
    case "search_conversation": return "Searching this conversation";
    case "days_between": return "Counting days";
    case "shift_date": return "Working out a date";
    case "build_app": return "Building and verifying the app";
    case "list_files": return "Listing files";
    case "read_file": return "Reading a file";
    case "write_file": return "Writing a file";
    default: return tool.replace(/_/g, " ");
  }
}

function Turn({ message, onBuildRequest }: { message: ChatMessage; onBuildRequest: (r: string) => void }) {
  const provenance = message.role === "assistant" ? provenanceOf(message) : null;

  return (
    <article className={`turn turn-${message.role}`}>
      <header className="turn-head">
        <span className="label">{message.role === "user" ? "You" : "Vexora"}</span>
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
  const profile = personalityById(resolvePersonality(personality));
  const {
    messages, status, restored, send, clear, sessionId,
    pendingConfirmation, declineConfirmation
  } = useAssistant(profile.id);
  const [draft, setDraft] = useState("");
  const [stats, setStats] = useState<Array<{ label: string; value: string; title?: string }>>([]);
  const [recentActivity, setRecentActivity] = useState<AuditEntry[]>([]);
  // The installed agent currently shaping suggestions and focus — a lens on
  // top of the personality, the same way the personality is a lens on the
  // assistant. Null when none is installed or none is active.
  const [agent, setAgent] = useState<Agent | null>(null);
  // Bumped on every completed stats refresh, same trick as pollCount for the
  // link reading: a React key that changes is what makes a CSS entrance
  // animation replay on a value that was already there.
  const [statsPollCount, setStatsPollCount] = useState(0);
  const [online, setOnline] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [linkMs, setLinkMs] = useState<number | null>(null);
  // Bumped on every completed poll. Used as a React key so the reading
  // remounts and replays its animation — the flicker marks a real refresh
  // rather than running on a timer of its own.
  const [pollCount, setPollCount] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  // Reported once per mount. Whether the store has answered yet is tracked
  // separately from its contents, because "no memories" and "not asked yet"
  // are different states and only one of them is a finished check.
  const [booted, setBooted] = useState(false);
  const [storeChecked, setStoreChecked] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

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
        // Counted as a completed check too. A poll that failed is an event that
        // happened, and without this the trace could never show a miss — it
        // would simply stop advancing, which looks the same as the app being
        // idle rather than the service being unreachable.
        if (!cancelled) {
          setOnline(false);
          setModel(null);
          setLinkMs(null);
          setPollCount((count) => count + 1);
        }
      }
    }

    void probe();
    const poll = window.setInterval(probe, 5000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [messages.length]);

  // What the app is actually holding, read while there is nothing else to
  // show. Polled rather than fetched once, on the same reasoning as the
  // reachability check above: a front page that only ever shows the moment
  // you opened it is not a live one, it is a screenshot of one.
  useEffect(() => {
    if (messages.length > 0) return;
    let cancelled = false;

    async function sample() {
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

      // Fetched directly rather than through ask(): the audit trail it also
      // carries is the only real "what did this actually do recently" record
      // in the app, and ask() only ever kept the count.
      const memoryPayload = await fetch(
        `${webEnv.apiBaseUrl}/v1/assist/memory?sessionId=${encodeURIComponent(sessionId)}`
      ).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      const memories = (memoryPayload?.data?.memories ?? []).length as number;
      const audit = (memoryPayload?.data?.audit ?? []) as AuditEntry[];

      const documents = await ask("/v1/knowledge", "documents");

      const events = readEvents(window.localStorage, "ascend.calendar.events.v1");
      const next = upcomingEvents(events, new Date(), 1)[0] ?? null;

      const flow = readFlow(window.localStorage, "ascend.automation.flow.v1");
      const marketplace = readMarketplaceState(window.localStorage, "ascend.marketplace.v1");
      const installedAgents = allAgents().filter((entry) => isInstalled(marketplace, entry.id)).length;

      if (cancelled) return;

      setAgent(activeAgent(marketplace));

      // Singular when there is one of something: "1 documents" is the kind of
      // detail that makes an interface feel unattended.
      const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

      setStats([
        { label: plural(memories, "remembered", "remembered"), value: String(memories) },
        { label: plural(documents, "document", "documents"), value: String(documents) },
        {
          label: plural(events.length, "event", "events"),
          value: String(events.length),
          title: next ? `Next: ${next.title} (${formatRelative(next.startsAt, new Date())})` : undefined
        },
        {
          label: "automation",
          value: flow ? String(flow.nodes.length) : "0",
          title: flow ? `${flow.name}: ${flow.nodes.length} step${flow.nodes.length === 1 ? "" : "s"}` : "No flow built yet"
        },
        { label: plural(installedAgents, "agent", "agents"), value: String(installedAgents) }
      ]);
      setRecentActivity(audit.slice(0, 5));
      setStoreChecked(true);
      setStatsPollCount((count) => count + 1);
    }

    void sample();
    const poll = window.setInterval(sample, 12_000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [messages.length, sessionId]);

  // Follow the conversation as it grows, including while a reply streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, status.state]);

  // Which tool the agent is running right now, polled only while a reply is
  // in flight — "Searching your documents" beats a generic spinner, and once
  // the turn ends there is nothing left to poll for. Short interval and a
  // small payload: this is a status light, not a data fetch.
  const [liveTool, setLiveTool] = useState<string | null>(null);

  useEffect(() => {
    if (status.state !== "thinking") { setLiveTool(null); return; }
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/activity?sessionId=${encodeURIComponent(sessionId)}`);
        if (!response.ok || cancelled) return;
        const payload = await response.json();
        if (!cancelled) setLiveTool(payload?.data?.tool ?? null);
      } catch {
        // A missed poll just leaves the last known tool showing a little longer.
      }
    }

    void poll();
    const interval = window.setInterval(poll, 600);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [status.state, sessionId]);

  // Derived in bootChecks.ts so the one rule that matters — a line may only
  // claim a check passed when it actually ran — is stated once and tested.
  const bootChecks = bootChecksFor({ online, model, linkMs, storeChecked, stats });

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
          {/* Present for the life of the conversation, not just while a reply
              is in flight — the ambient idle turn is what makes the header
              read as a running machine rather than a label that goes quiet
              the moment the home screen scrolls away. Driven by state this
              component already tracks, not a new poll: "thinking" mirrors the
              same busy flag the composer disables on, and "offline" only
              lights up after a real request has actually failed. */}
          <Core state={busy ? "thinking" : status.state === "error" ? "offline" : "idle"} size={36} />
          <h2 className="label">Conversation</h2>
          <span className="chip">{profile.label}</span>
        </div>
        {messages.length > 0 ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
            // No undo once this fires — the whole transcript goes with it.
            if (window.confirm("Clear this conversation? This cannot be undone.")) void clear();
          }}>
            Clear
          </button>
        ) : null}
      </header>

      <div className="conversation-scroll scroll-y">
        {messages.length === 0 ? (
          <div className="home">
            {/* The app reporting its own systems as they come up. Shown only
                on an empty conversation: a start-up report in the middle of a
                conversation is noise. */}
            {!booted ? <Boot checks={bootChecks} onDone={() => setBooted(true)} /> : null}

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
                  {/* The last twenty round trips, one bar each. The only thing
                      on this screen that accumulates rather than loops. */}
                  <Pulse latest={linkMs} sampleId={pollCount} online={online} />
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
                  <div key={stat.label} className="home-readout" title={stat.title}>
                    <dt className="label">{stat.label}</dt>
                    <dd key={statsPollCount} className="mono home-readout-count home-readout-count-live">
                      {stat.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="home-greeting">
              <h3 className="home-hello">{greetingFor(clock)}</h3>
              <span className="home-rule" aria-hidden="true" />
              {/* The mark under the rule, not shouted over the greeting: the
                  greeting is addressed to the reader, this only says whose
                  machine they are on. */}
              <span className="home-wordmark">Vexora <b>AI</b></span>
              {/* Three words, not a paragraph. A tagline that has to be read
                  is an advert; one that is taken in at a glance is a mark. */}
              <span className="home-tagline">Adapt · Evolve · Empower</span>
              {/* An installed agent is a lens on top of the personality: it
                  narrows what the assistant pays attention to, same as the
                  personality does, just one step more specific. Shown here
                  so installing one visibly does something, rather than only
                  moving a count on the right rail. */}
              {agent ? (
                <p className="home-sub home-agent-focus">
                  <span aria-hidden="true">{agent.avatar}</span> <b>{agent.name}</b> — {agent.focus}
                </p>
              ) : null}
              <p className="home-sub muted">
                {online === false
                  ? "The local service is not responding. Nothing can be answered until it is back."
                  : model
                    ? "Answers come from the local model, from what you have asked me to remember, and from your documents."
                    : "No local model is running — answers come from your notes and documents only."}
              </p>
            </div>

            <div className="row wrap conversation-suggestions">
              {(agent?.suggestions ?? profile.suggestions).map((suggestion) => (
                <button key={suggestion} type="button" className="btn btn-sm"
                  onClick={() => { setDraft(suggestion); }}>
                  {suggestion}
                </button>
              ))}
            </div>

            {/* Absent rather than empty when there is nothing yet — a fresh
                session has no history to show, and saying so here would just
                be noise under a screen that already says as much. */}
            {recentActivity.length > 0 ? (
              <div className="home-activity">
                <h3 className="label home-activity-head">Recent activity</h3>
                <ul className="home-activity-list">
                  {recentActivity.map((entry) => (
                    <li key={entry.id} className="home-activity-row">
                      <span className="chip chip-tool">{auditActionLabel[entry.action]}</span>
                      <span className="home-activity-detail">{entry.detail}</span>
                      <span className="home-activity-time mono">{timeAgo(entry.createdAt, clock)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
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
            <span className="label">
              {liveTool ? liveToolLabel(liveTool) : "Working"}
              <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
            </span>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      {/* The permission gate refused something and is waiting to be allowed.
          Shown above the composer rather than as a modal: the reply that
          explains what it wants to do stays readable behind it, which is the
          context someone needs in order to answer. */}
      {pendingConfirmation ? (
        <div className="panel confirm-action" role="alertdialog" aria-label="Confirm action">
          <strong className="confirm-title">Confirm action</strong>
          <p className="confirm-verb">{pendingConfirmation.verb}</p>
          {pendingConfirmation.target ? (
            <p className="confirm-target mono">{pendingConfirmation.target}</p>
          ) : null}
          <p className="faint confirm-warning">
            This cannot be undone from here.
          </p>
          <div className="row confirm-actions">
            <button type="button" className="btn" disabled={busy}
              onClick={() => void declineConfirmation()}>
              Cancel
            </button>
            {/* Sends the same word a person would type, so the button and the
                typed reply run the identical server path rather than a second
                one that could drift from it. */}
            <button type="button" className="btn btn-primary" disabled={busy}
              onClick={() => void send("yes")}>
              Confirm
            </button>
          </div>
        </div>
      ) : null}

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
