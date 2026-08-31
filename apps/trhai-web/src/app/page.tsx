"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CoreGL } from "../components/CoreGL";
import { CoreHud, type HudReading } from "../components/CoreHud";
import { Sparkline, type SparklinePoint } from "../components/Sparkline";
import { answerCredit, answeredFromModelAlone, sourceLabels, sourcesFor } from "../components/provenance";
import { activeStage, presence, stageReplyVisible, stages } from "../components/corePresence";
import { useAssistant, type AssistantStatus } from "../hooks/useAssistant";
import { useSpeech } from "../hooks/useSpeech";
import { ParticleField } from "../components/ParticleField";
import { useMicrophone } from "../hooks/useMicrophone";
import { useCues } from "../hooks/useCues";
import {
  initialVoiceActivity, stepVoiceActivity, type VoiceActivityState
} from "../lib/voiceActivity";
import { Markdown } from "../components/Markdown";
import { Subsystems, type Subsystem } from "../components/Subsystems";
import { CommandAccess } from "../components/CommandAccess";
import { TaskList, type TaskItem } from "../components/TaskList";
import { PersonalityPicker } from "../components/PersonalityPicker";
import { VoicePicker } from "../components/VoicePicker";
import { ExecutionTrace } from "../components/ExecutionTrace";
import { LiveOperations } from "../components/LiveOperations";
import { useExecutionEvents } from "../hooks/useExecutionEvents";
import { WorkView } from "../components/WorkView";
import {
  CoreStatus, RecentActivity, SystemGauges, type ActivityRow
} from "../components/CorePanels";
import {
  ActiveTasks, MemoryStatus, SystemOverview, type AgentTask, type HealthRow
} from "../components/CommandPanels";
import { apiDelete, apiGet, apiPatch, apiPost, sessionId } from "../lib/api";
import { emptySeries, pushSample, type Series } from "../lib/telemetryHistory";
import { readStoredPersonality, writeStoredPersonality } from "../lib/personality";
import { defaultAccent, readStoredAccent, writeStoredAccent, type Accent } from "../lib/theme";
import {
  activeAgent, defaultPersonality, personalityById, readMarketplaceState, readFlow,
  speakableText, type PersonalityId
} from "@ascend/shared";
import { marketplaceStorageKey } from "../lib/agents";
import "./dash.css";

// The command centre.
//
// Built to the reference design: a core at the middle, subsystems flanking
// it, a console down the left, instruments down the right, and a state rail
// across the bottom. The layout is followed closely because it is a good
// layout — a machine you can read at a glance.
//
// What is not followed is any number the reference invents. It shows a health
// dial pinned at 100%, task bars at 72% and 45%, "13.2 GB / 15.0 GB" of
// memory, five connected services, and subsystems at v4.2.1 and v3.8.7 all
// lit green. None of those are things this build can measure, and a dial that
// always reads 100% is not an instrument — it is a picture of one. So every
// panel keeps its place in the design and is filled from something real:
// health is the fraction of checks that actually passed, tasks show the tools
// that genuinely ran instead of a bar nothing measures, and a subsystem that
// is not installed says so rather than showing ACTIVE.
//
// That is the difference between a screen that looks alive and one that is.

type ModelInfo = { available: boolean; model?: string; reason?: string };
type TranscribeInfo = { available: boolean; model?: string; reason?: string };
type Reading = { fraction: number | null; detail: string; unavailable: string | null };
type Telemetry = {
  cpu: Reading & { cores: number; model: string; speedMhz: number };
  memory: Reading;
  gpu: Reading & { name: string | null; vram: Reading | null; temperatureC: number | null; clockMhz: number | null };
  cloud: { services: string[] };
  disk: Reading;
  network: Reading & { receivedBytesPerSecond: number | null; sentBytesPerSecond: number | null };
  uptimeSeconds: number;
};
type Identity = { username: string; hostname: string; platform: string };
type ScheduleView = { id: string; enabled: boolean };

/**
 * An account name as a person would be addressed.
 *
 * "hankh" is a login, not a name, so it is capitalised and any trailing
 * initial or digits are left alone rather than guessed at — turning "hankh"
 * into "Hank" would be inventing the very thing this reads from the OS to
 * avoid inventing. It is shown as the account it is, just not shouted.
 */
function displayName(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A top-bar metric. Shows a dash, never a number, when it cannot be read. */
function Metric({ label, reading, history }: {
  label: string;
  reading: Reading | null | undefined;
  history?: SparklinePoint[];
}) {
  const fraction = reading?.fraction;
  const known = fraction !== null && fraction !== undefined;
  const percent = known ? Math.round(fraction * 100) : null;
  const tone = !known ? "" : fraction >= 0.9 ? " danger" : fraction >= 0.7 ? " warn" : "";

  return (
    <div className="metric" title={reading?.unavailable ?? reading?.detail ?? ""}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value${tone}`}>{percent === null ? "—" : `${percent}%`}</span>
      {history ? <Sparkline values={history} /> : null}
    </div>
  );
}

/** Samples kept per reading: two minutes at the four-second poll. */
const historyLength = 30;

/** Where the rail choice is remembered. */
const railsKey = "trhai.rails.v1";

export default function DashboardPage() {
  // Whether the split work view is open.
  //
  // Opened by real work, not by intent. The backlog asks for "coding intent
  // triggers the split layout"; guessing that from the wording would open an
  // empty editor beside an empty terminal for anyone who said "build", and
  // stay shut for anyone who phrased it another way. Waiting for the first
  // file to actually land costs a fraction of a second and is never wrong.
  const [dismissedWork, setDismissedWork] = useState(false);
  const { messages, status, send, stop } = useAssistant();
  const mic = useMicrophone();
  const speech = useSpeech();
  const cues = useCues();

  const [clock, setClock] = useState<Date | null>(null);
  const [draft, setDraft] = useState("");
  // Whether the command field genuinely has focus.
  //
  // The one piece of interface state here that is about the user rather than
  // the machine, and it is still a real event rather than a guess: the core
  // leans in when you click into the box and settles when you leave. It is
  // deliberately not a hover, which fires when a mouse crosses the screen on
  // its way somewhere else and would have the app reacting to nothing.
  const [attentive, setAttentive] = useState(false);

  // Hands-free listening: the mic stays open and you just talk.
  //
  // Pressing a button before every sentence is what stops a voice assistant
  // feeling like one — you are operating a dictaphone rather than talking to
  // something. With this on, the voice-activity machine decides where each
  // utterance starts and ends, transcribes it, and sends it.
  //
  // Off by default and never enabled on its own. An always-open microphone is
  // a thing a person opts into, not something an app decides for them.
  const [handsFree, setHandsFree] = useState(false);
  const vad = useRef<VoiceActivityState>(initialVoiceActivity(performance.now()));

  // Parallax, from where the pointer actually is.
  //
  // The layers of this screen are drawn at different depths but sit at the
  // same one, which is what makes a HUD read as a picture of a HUD. Shifting
  // them by different amounts as the pointer moves is the cue that tells the
  // eye there is space between them.
  //
  // Written straight to CSS custom properties rather than through React state:
  // a pointermove that re-rendered the whole screen would be the most
  // expensive thing in the app, and this only needs to move two numbers.
  useEffect(() => {
    const shell = document.querySelector(".cc") as HTMLElement | null;
    if (!shell) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame: number | null = null;
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;

    const onMove = (event: PointerEvent) => {
      // -1..1 from the centre of the window.
      targetX = (event.clientX / window.innerWidth) * 2 - 1;
      targetY = (event.clientY / window.innerHeight) * 2 - 1;
      if (frame === null) frame = requestAnimationFrame(settle);
    };

    // Eased rather than followed exactly: a HUD that snaps to the cursor
    // reads as attached to it, and the point is depth, not attachment.
    const settle = () => {
      x += (targetX - x) * 0.08;
      y += (targetY - y) * 0.08;
      shell.style.setProperty("--px", x.toFixed(4));
      shell.style.setProperty("--py", y.toFixed(4));

      if (Math.abs(targetX - x) > 0.001 || Math.abs(targetY - y) > 0.001) {
        frame = requestAnimationFrame(settle);
      } else {
        frame = null;
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  // Whether the instrument rails are showing.
  //
  // Off by default, because the thing this app is for is the core, what you
  // type into it, and the microphone — everything else is reference material
  // you look at when you want it. Remembered, so the choice survives a
  // restart rather than being made again every launch.
  const [rails, setRails] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  // Read inside readAll rather than captured by it, so toggling a rail does
  // not tear down and rebuild the polling interval.
  const railRightOpen = useRef(rails.right);
  railRightOpen.current = rails.right;

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(railsKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only value; the server has no localStorage and no clock the client will agree with
      if (stored) setRails(JSON.parse(stored) as { left: boolean; right: boolean });
    } catch {
      // A blocked or corrupt store just means the default, which is the one
      // the screen is designed around anyway.
    }
  }, []);

  const toggleRail = useCallback((side: "left" | "right") => {
    setRails((prior) => {
      const next = { ...prior, [side]: !prior[side] };
      try {
        window.localStorage.setItem(railsKey, JSON.stringify(next));
      } catch {
        // Not being able to remember it is no reason to ignore it now.
      }
      return next;
    });
  }, []);
  const [online, setOnline] = useState<boolean | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [stt, setStt] = useState<TranscribeInfo | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  // Two minutes of readings at the four-second poll.
  //
  // The screen was throwing its own history away: 47%, then 51%, then 44%,
  // with no way to tell a spike from a climb. This keeps exactly the samples
  // that were taken — nulls included, so a reading that could not be taken
  // stays a hole rather than being interpolated over.
  const [history, setHistory] = useState<Series>(emptySeries);
  const [tools, setTools] = useState<number | null>(null);
  const [memories, setMemories] = useState<{ total: number; pinned: number } | null>(null);
  const [documents, setDocuments] = useState<number | null>(null);
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  // Whether the API could actually write its schedules to disk. The store has
  // recorded this since it was written and nothing read it, so a scheduler that
  // had quietly stopped saving still reported itself running - right up to the
  // restart that lost everything in it.
  const [schedulePersistError, setSchedulePersistError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<{ files: number; bytes: number } | null>(null);
  const [agentTasks, setAgentTasks] = useState<AgentTask[] | null>(null);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [flowName, setFlowName] = useState<string | null>(null);
  const [personalityId, setPersonalityId] = useState<PersonalityId>(defaultPersonality);
  // Same hydration-safe shape as the personality: the default on the server,
  // corrected from storage after mount. The boot script in <head> has already
  // applied the real one to <html> before this renders, so nothing flashes.
  const [accent, setAccent] = useState<Accent>(defaultAccent);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const lastSpokenId = useRef<string | null>(null);

  const { core, label } = presence(status, mic.listening, speech.speaking, online);
  const busy = status.state === "thinking" || status.state === "executing";
  const lastReply = [...messages].reverse().find((message) => message.role === "assistant") ?? null;

  // The exchange happening right now, for the stage itself.
  //
  // The transcript lives in the console rail, which is closed by default -
  // which meant asking a question on a freshly opened app played the whole
  // core animation and then showed the answer nowhere. The reply is not an
  // optional panel; it is the thing being asked for. It renders here, beside
  // the question, and the rail keeps the longer history.
  const lastAsked = [...messages].reverse().find((message) => message.role === "user") ?? null;

  // Read once here and handed to both views of it: the stage readout and the
  // rail's full trace. Two pollers would ask for the same log twice as often
  // and could disagree between their ticks.
  const executionEvents = useExecutionEvents(busy);

  // The split view opens on evidence, not on a guess. A write, an install, a
  // test or a command having genuinely happened is what makes a files-and-
  // terminal layout the right thing to be looking at.
  //
  // Both of these used to come from a second read of /v1/execution inside the
  // 4s poll, so the app fetched the same log twice on two different clocks and
  // could show an activity row the operations readout had not caught up to.
  const didWork = executionEvents.some((event) =>
    ["write", "install", "test", "command", "launch"].includes(event.kind));

  // The activity list is the execution log, newest first - the same events the
  // readout and the trace show, with the times they actually occurred. Nothing
  // is generated to fill the panel; an empty log renders empty.
  const activity: ActivityRow[] = executionEvents.slice(-8).reverse().map((event) => ({
    id: event.id,
    label: event.label,
    at: event.startedAt,
    status: event.status
  }));


  // Which turns were already on disk when the app opened.
  //
  // Conversations are restored on load, so without this the newest stored
  // reply - possibly days old - would be sitting on the stage the instant the
  // window appeared, in the place that means "here is your answer". Snapshot
  // the ids the first time messages arrive; anything not in that set happened
  // in this run and is genuinely current.
  const restoredIds = useRef<Set<string> | null>(null);
  if (restoredIds.current === null && messages.length > 0) {
    restoredIds.current = new Set(messages.map((message) => message.id));
  }
  const replyIsFromThisRun = lastReply !== null && !(restoredIds.current?.has(lastReply.id) ?? false);

  // Clock fills in on the client. Rendering a time on the server guarantees
  // it disagrees with the client a second later.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only value; the server has no localStorage and no clock the client will agree with
    setClock(new Date());
    const ticker = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    const storedId = readStoredPersonality(window.localStorage);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only value; the server has no localStorage and no clock the client will agree with
    setPersonalityId(storedId);
    setAccent(readStoredAccent(window.localStorage));
    const chosen = personalityById(storedId);
    const installed = activeAgent(readMarketplaceState(window.localStorage, marketplaceStorageKey));
    // The agent and personality are no longer displayed here - the card that
    // showed them went with the surfaces. Both still take effect: the prompts
    // below come from whichever is active, and useAssistant reads the stored
    // personality itself, which is what appends its mandatory disclaimer.
    setSuggestions(installed?.suggestions ?? chosen.suggestions ?? []);
    setFlowName(readFlow(window.localStorage, "trhai.automation.flow.v1")?.name ?? null);
  }, []);

  // Who is at the machine. Asked once rather than on the 4s poll: the account
  // running the process cannot change without the process restarting, so
  // re-asking would be four requests a minute for a constant.
  useEffect(() => {
    void apiGet<Identity>("/v1/identity").then((result) => {
      if (result.ok) setIdentity(result.data);
    });
  }, []);

  // Which voices and transcription models are installed. Asked once, for the
  // same reason as identity above: these are properties of the machine, set
  // before the process started, and they were being re-read on the 4s poll -
  // thirty requests a minute between them, every one returning the identical
  // list. Installing a voice while the app is open needs a reload, which is a
  // fair price for not asking a constant question forever.
  useEffect(() => {
    // No /v1/speech here any more: useSpeech already asks, and the screen now
    // reads the answer from there so the chip and the VOICE button cannot
    // disagree. Fetching it twice was two answers to one question.
    void apiGet<TranscribeInfo>("/v1/transcribe").then((result) => {
      if (result.ok) setStt(result.data);
    });
  }, []);

  const readAll = useCallback(async () => {
    const id = sessionId();
    // Everything the stage itself shows: the status strip, the readings around
    // the core, and the subsystem chips flanking it.
    const [
      modelResult, telemetryResult,
      capabilityResult, memoryResult, scheduleResult, filesResult
    ] = await Promise.all([
      apiGet<ModelInfo>("/v1/assist/model"),
      apiGet<Telemetry>("/v1/system-telemetry"),
      apiGet<{ tools: unknown[] }>("/v1/capabilities"),
      apiGet<{ memories: Array<{ pinned?: boolean }> }>(`/v1/assist/memory?sessionId=${id}`),
      apiGet<{ schedules: ScheduleView[]; persistenceError?: string | null }>("/v1/schedules"),
      apiGet<{ entries: Array<{ directory: boolean; bytes: number }> }>("/v1/files")
    ]);

    // And the three that only ever reach panels in the activity rail. Asked
    // for only while that rail is open: with it closed - which is how the app
    // starts - these were three requests every four seconds whose answers were
    // rendered into a column with display:none on it.
    const [knowledgeResult, taskResult, todoResult] = railRightOpen.current
      ? await Promise.all([
        apiGet<{ documents: unknown[] }>(`/v1/knowledge?sessionId=${id}`),
        apiGet<{ tasks: AgentTask[] }>(`/v1/agent-tasks?sessionId=${id}`),
        apiGet<{ tasks: TaskItem[] }>(`/v1/tasks?sessionId=${id}`)
      ])
      : [null, null, null];

    // One reachability answer for the screen, from the request that would
    // fail first. Marking each panel separately unreachable would be ten ways
    // of saying the same thing.
    setOnline(modelResult.ok);
    if (modelResult.ok) setModel(modelResult.data);
    // A reading that could not be taken is recorded as a hole, and the last
    // one is dropped rather than left on screen.
    //
    // Failing this read used to do nothing at all: the strip kept displaying
    // whatever the numbers were when the API stopped answering, in the same
    // type and colour as live ones, so a machine that had been at 71% an hour
    // ago still read 71% now. The core went grey and said NO CONNECTION while
    // three numbers beside it claimed to be current - the screen contradicting
    // itself about the one thing it is for.
    //
    // The trace gets a null for the same reason it always has: a straight line
    // across a period where nothing was measured would be the one invented
    // thing on an otherwise measured screen.
    const reading = telemetryResult.ok ? telemetryResult.data : null;
    setTelemetry(reading);
    setHistory((prior) => pushSample(prior, reading, historyLength));
    if (capabilityResult.ok) setTools(capabilityResult.data.tools.length);
    if (memoryResult.ok) {
      setMemories({
        total: memoryResult.data.memories.length,
        pinned: memoryResult.data.memories.filter((entry) => entry.pinned).length
      });
    }
    if (knowledgeResult?.ok) setDocuments(knowledgeResult.data.documents.length);
    if (scheduleResult.ok) {
      setSchedules(scheduleResult.data.schedules);
      setSchedulePersistError(scheduleResult.data.persistenceError ?? null);
    }
    if (filesResult.ok) {
      const files = filesResult.data.entries.filter((entry) => !entry.directory);
      setWorkspace({ files: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0) });
    }
    if (taskResult?.ok) setAgentTasks(taskResult.data.tasks);
    if (todoResult?.ok) setTasks(todoResult.data.tasks);

  }, []);

  // Polling stops while the window is hidden and resumes with a fresh read.
  //
  // Minimised, the app was still making twelve requests a second-and-a-bit
  // forever, one of which spends 250ms sampling CPU and shells out to
  // nvidia-smi. Nobody was looking at the result. Reading immediately on the
  // way back matters as much as stopping: without it the first thing a
  // returning user sees is telemetry from whenever they left, which is the
  // stale-number problem this whole screen exists to avoid.
  useEffect(() => {
    let poller: number | null = null;

    const start = () => {
      if (poller !== null) return;
      void readAll();
      poller = window.setInterval(() => void readAll(), 4000);
    };

    const stop = () => {
      if (poller === null) return;
      window.clearInterval(poller);
      poller = null;
    };

    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [readAll]);

  // Opening the activity rail fills it now rather than on the next tick.
  //
  // Its three panels are only fetched while it is open, so without this they
  // would show dashes for up to four seconds after the click - which reads as
  // the panel being broken rather than as data on its way.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only value; the server has no localStorage and no clock the client will agree with
    if (rails.right) void readAll();
  }, [rails.right, readAll]);

  // A cue when a turn genuinely finishes or genuinely fails.
  //
  // Keyed on the transition, not on the state: firing whenever state ===
  // "success" would sound on every re-render while the result sat on screen.
  // The previous state is what makes this an event rather than a condition.
  const previousState = useRef<AssistantStatus["state"]>(status.state);
  useEffect(() => {
    const was = previousState.current;
    previousState.current = status.state;
    if (was === status.state) return;
    if (status.state === "success") cues.play("done");
    if (status.state === "error") cues.play("error");
  }, [status.state, cues]);

  // Read the newest reply aloud when voice is on. Restored history is never
  // spoken, and each reply is spoken at most once.
  useEffect(() => {
    if (!speech.enabled) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.role !== "assistant") return;
    if (newest.id.startsWith("restored-")) return;
    // Never mid-stream. Speaking the first token would read one word aloud
    // and stop, and marking it spoken would mean the finished reply is never
    // read at all.
    if (newest.streaming) return;
    if (lastSpokenId.current === newest.id) return;

    lastSpokenId.current = newest.id;
    if (mic.listening) return;
    // Spoken as prose, not as markup: the reply renders as formatted text, so
    // reading "asterisk asterisk" aloud would say something different from
    // what is on screen.
    speech.speak(speakableText(newest.text));
  }, [messages, speech, mic.listening]);

  // The hands-free loop.
  //
  // Runs off the microphone's own level, which already updates every animation
  // frame, so this adds no audio processing — only the judgement about where
  // one utterance ends and the next begins.
  //
  // It deliberately does nothing while TRHAI is speaking or already working.
  // An open microphone during playback transcribes the assistant's own voice
  // and answers it, which is a loop that does not stop on its own.
  useEffect(() => {
    if (!handsFree || !mic.listening) return;
    if (speech.speaking || busy || mic.transcribing) return;

    const { state, event } = stepVoiceActivity(vad.current, mic.amplitude, performance.now());
    vad.current = state;

    if (event.type === "started") {
      mic.markUtteranceStart();
      return;
    }

    if (event.type === "ended") {
      void mic.takeUtterance().then((said) => {
        // Null is ordinary: a door, a chair, a cough that got past the length
        // check. Nothing is sent, and nothing is said about it.
        if (said) ask(said);
      });
    }
    // `ask` is rebuilt every render, so listing it would re-run this on every
    // frame of microphone level. What `ask` actually closes over that matters
    // here is `busy`, and that is listed - so the version captured is refreshed
    // exactly when it could otherwise go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [handsFree, mic, speech.speaking, busy]);

  // Turning hands-free on opens the microphone; turning it off closes it.
  useEffect(() => {
    if (handsFree && !mic.listening) {
      speech.stop();
      cues.play("listen");
      void mic.start();
    }
    if (!handsFree && mic.listening) void mic.stop();
    // Only on the toggle itself: listing the microphone here would re-run this
    // on every level change and fight the loop above.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [handsFree]);

  async function handleMic() {
    if (!mic.listening) {
      // Stop any reply already being read, or the microphone opens into
      // TRHAI's own voice and transcribes it back.
      speech.stop();
      cues.play("listen");
      await mic.start();
      return;
    }

    const said = await mic.stop();
    if (!said) return;

    // Speaking runs the whole way through: listen, transcribe, then send,
    // without a second click. Waiting for the user to press send after they
    // have already asked out loud breaks the one thing voice is for. The
    // draft is still filled in when a turn is already running, so a spoken
    // request during a long answer is kept rather than dropped.
    if (busy) {
      setDraft((existing) => (existing.trim() ? `${existing.trim()} ${said}` : said));
      return;
    }
    ask(said);
  }

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft("");
    // Closing the work view applies to the build you closed it on, not to
    // every build afterwards. Cleared here, where the new turn actually
    // begins, rather than in an effect watching didWork go false - starting a
    // turn is the event, and reacting to the state it produces is a longer way
    // round to the same place that costs an extra render.
    setDismissedWork(false);
    cues.play("send");
    void send(trimmed);
  }

  const modelName = model?.available && model.model
    ? model.model.replace(/^ollama\//, "").replace(/:latest$/, "")
    : null;

  // While the microphone is open this shows the room's real loudness; while
  // speaking, the voice's own amplitude; otherwise how hard the core is
  // working. All three are real, and it is flat when there is genuinely
  // nothing to measure.
  const level = mic.listening
    ? mic.amplitude
    : speech.speaking && speech.amplitude !== undefined
      ? speech.amplitude
      : status.state === "executing" ? 1 : status.state === "thinking" ? 0.6 : 0;

  // How hard this machine is working, from the readings already on screen.
  //
  // The heavier of processor and graphics rather than an average: a GPU pinned
  // at 100% while the CPU idles is a working machine, and averaging the two
  // would report it as half asleep.
  const machineLoad = telemetry
    ? Math.max(telemetry.cpu.fraction ?? 0, telemetry.gpu.fraction ?? 0)
    : undefined;

  // The annotations shown around the core once the rails are down.
  //
  // The same measurements the gauges carry, so hiding the panels costs
  // attention rather than information. Each one prints a dash when its sensor
  // cannot be read — a floating HUD figure is the element that looks most
  // convincing when it is invented, so none of these are.
  const bare = !rails.left && !rails.right;
  const uptimeText = telemetry
    ? (() => {
      const hours = Math.floor(telemetry.uptimeSeconds / 3600);
      const minutes = Math.floor((telemetry.uptimeSeconds % 3600) / 60);
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    })()
    : null;

  const hudReadings: HudReading[] = [
    {
      label: "Core temp",
      at: "top-left",
      known: telemetry?.gpu.temperatureC != null,
      value: telemetry?.gpu.temperatureC != null ? `${Math.round(telemetry.gpu.temperatureC)}°C` : "not reported"
    },
    {
      label: "Video memory",
      at: "top-right",
      known: telemetry?.gpu.vram?.fraction != null,
      value: telemetry?.gpu.vram?.fraction != null
        ? `${Math.round(telemetry.gpu.vram.fraction * 100)}%`
        : "—"
    },
    {
      label: "Uptime",
      at: "bottom-left",
      known: uptimeText !== null,
      value: uptimeText ?? "—"
    },
    {
      label: "Network",
      at: "bottom-right",
      known: !telemetry?.network.unavailable,
      value: telemetry?.network.unavailable ? "no reading" : (telemetry?.network.detail || "—")
    }
  ];

  const enabledSchedules = schedules?.filter((schedule) => schedule.enabled).length ?? null;

  const leftSubsystems: Subsystem[] = [
    {
      name: "Language model",
      detail: modelName,
      online: model === null ? null : model.available,
      reason: model?.reason ?? "No local model is running."
    },
    {
      name: "Transcription",
      detail: stt?.model ?? null,
      online: stt === null ? null : stt.available,
      reason: stt?.reason ?? "No whisper model installed."
    },
    {
      name: "Memory core",
      detail: memories === null ? null : `${memories.total} kept · ${memories.pinned} pinned`,
      online: memories === null ? null : true
    },
    {
      name: "Tool registry",
      detail: tools === null ? null : `${tools} registered`,
      online: tools === null ? null : tools > 0
    }
  ];

  const rightSubsystems: Subsystem[] = [
    {
      name: "Speech synthesis",
      // Read from the same place the VOICE button reads, so the chip and the
      // button can never name two different voices on one screen. This used to
      // show the service's default while the button showed the one that had
      // actually spoken.
      detail: speech.neural?.available === true ? speech.neural.voice : null,
      online: speech.neural === null ? null : speech.neural.available,
      reason: speech.neural?.available === false
        ? speech.neural.reason
        : "Piper is not installed.",
      // The one subsystem with a genuine live signal: the neural voice
      // exposes its audio, so this bar is the real amplitude.
      level: speech.speaking ? speech.amplitude ?? 0 : 0
    },
    {
      name: "Scheduler",
      detail: enabledSchedules === null ? null : `${enabledSchedules} active of ${schedules?.length ?? 0}`,
      online: schedules === null ? null : schedulePersistError === null,
      reason: schedulePersistError
        ? `Schedules are not being saved: ${schedulePersistError}. Anything added will be lost on restart.`
        : undefined
    },
    {
      name: "Workspace",
      detail: workspace === null ? null : `${workspace.files} files`,
      online: workspace === null ? null : true
    },
    {
      name: "Automation",
      detail: flowName,
      online: flowName === null ? false : true,
      reason: "No flow saved yet."
    }
  ];

  const healthRows: HealthRow[] = [
    {
      label: "Local API",
      state: online === null ? "checking" : online ? "connected" : "unreachable",
      ok: online
    },
    {
      label: "Model",
      state: model === null ? "checking" : model.available ? "loaded" : "none",
      ok: model === null ? null : model.available
    },
    {
      label: "Voice",
      state: speech.neural === null ? "checking" : speech.neural.available ? "ready" : "absent",
      ok: speech.neural === null ? null : speech.neural.available
    },
    {
      label: "Transcription",
      state: stt === null ? "checking" : stt.available ? "ready" : "absent",
      ok: stt === null ? null : stt.available
    },
    {
      label: "Scheduler",
      state: schedules === null ? "checking" : schedulePersistError === null ? "running" : "not saving",
      ok: schedules === null ? null : schedulePersistError === null
    }
  ];

  const stage = activeStage(core, messages.length > 0);
  const failing = healthRows.filter((row) => row.ok === false).length;

  // The reference's fourth dial is "STABILITY", pinned near 98%. Nothing here
  // measures stability, so this counts the health checks genuinely passing — a
  // number that can and does drop when something breaks. Rows still being
  // checked are excluded rather than counted as passing, so the dial reads
  // from what is actually known.
  const decided = healthRows.filter((row) => row.ok !== null);
  const health = decided.length === 0
    ? null
    : { passed: decided.filter((row) => row.ok === true).length, total: decided.length };


  return (
    <div className={`cc cc-${core}${attentive ? " cc-attentive" : ""}`
      + `${rails.left ? "" : " cc-no-left"}${rails.right ? "" : " cc-no-right"}`}>
      <header className="cc-top">
        <div className="cc-brand">
          <span className="cc-mark" aria-hidden="true">▽</span>
          <div className="cc-brand-text">
            <span className="cc-wordmark">TRH AI</span>
            <span className="cc-sub">VEXORA</span>
          </div>
        </div>

        <div className="cc-top-status">
          <span className="hud-label">System status</span>
          <span className={`cc-status-word${online ? " ok" : online === false ? " danger" : ""}`}>
            {online === null ? "CONNECTING" : online ? "ONLINE" : "OFFLINE"}
          </span>
          <span className={`cc-dot${online ? " live" : ""}`} aria-hidden="true" />
          {/* Not "all systems operational" as a fixed caption. It counts the
              checks that actually failed, so it can say something different
              when something is wrong. */}
          <span className="faint cc-status-note">
            {online === false
              ? "The local API is not responding"
              : failing === 0
                ? "All checks passing"
                : `${failing} not available`}
          </span>
        </div>

        {/* The three that change second to second. Video memory, storage and
            health live in the gauge stack instead — this strip and that panel
            used to carry the same five readings under different words
            ("RAM"/"Memory", "DISK"/"Storage"), which is duplication however
            you label it. */}
        <div className="cc-metrics">
          <Metric label="CPU" reading={telemetry?.cpu} history={history.cpu} />
          <Metric label="RAM" reading={telemetry?.memory} history={history.memory} />
          <Metric label="GPU" reading={telemetry?.gpu} history={history.gpu} />
        </div>

        {/* The reference prints "USER: HANK — OWNER ACCESS". The name here is
            the OS account this process runs under, so it is whoever opened the
            app rather than a caption that happens to be right on one machine.
            "Owner access" is not claimed: there is no account tier to be an
            owner of, so this says where the session actually is. */}
        <div className="cc-user">
          <span className="hud-label">User</span>
          <span className="cc-user-name">
            {identity ? displayName(identity.username) || "unknown" : "—"}
          </span>
          <span className="faint cc-user-host" title={identity?.platform ?? ""}>
            {identity ? `LOCAL · ${identity.hostname.toUpperCase()}` : "…"}
          </span>
        </div>

        <div className="cc-clock mono">
          {clock ? (
            <>
              <span className="cc-time">
                {clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className="cc-date">
                {clock.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }).toUpperCase()}
              </span>
            </>
          ) : <span className="cc-time">--:--:--</span>}
        </div>
      </header>

      {/* Edge handles for the two rails. Always present, so the panels are
          never more than one click away and it is always obvious they exist —
          a hidden panel with no visible way back is just a missing feature. */}
      <button
        type="button"
        className={`cc-rail-tab cc-rail-tab-left${rails.left ? " open" : ""}`}
        onClick={() => toggleRail("left")}
        aria-pressed={rails.left}
        title={rails.left ? "Hide the console and system panels" : "Show the console and system panels"}
      >
        <span aria-hidden="true">{rails.left ? "‹" : "›"}</span>
        <span className="cc-rail-tab-label">Console</span>
      </button>

      <button
        type="button"
        className={`cc-rail-tab cc-rail-tab-right${rails.right ? " open" : ""}`}
        onClick={() => toggleRail("right")}
        aria-pressed={rails.right}
        title={rails.right ? "Hide the activity panels" : "Show the activity panels"}
      >
        <span aria-hidden="true">{rails.right ? "›" : "‹"}</span>
        <span className="cc-rail-tab-label">Activity</span>
      </button>

      <div className="cc-body">
        <aside className="cc-left">
          <section className="hud-panel cc-console">
            <span className="hud-label">TRH AI console</span>
            <div className="console-feed">
              {messages.length === 0 ? (
                <p className="faint">
                  {modelName
                    ? `${greetingFor(clock ?? new Date())}${identity?.username ? `, ${displayName(identity.username)}` : ""}. Answering with ${modelName}.`
                    : "No local model is loaded yet."}
                </p>
              ) : (
                messages.slice(-6).map((message) => (
                  <article key={message.id} className={`console-turn console-${message.role}`}>
                    <span className="console-who">{message.role === "user" ? "YOU" : "TRH AI"}</span>
                    {message.role === "assistant"
                      ? <Markdown text={message.text} className="console-text" />
                      : <p className="console-text">{message.text}</p>}
                    {/* Where the answer came from, from the tools that really
                        ran. "From the model alone" is the important one: it
                        means nothing on this machine backs the answer up, and
                        an answer you can check should not look identical to
                        one you cannot. */}
                    {message.role === "assistant" ? (() => {
                      const sources = sourcesFor(message.toolsUsed);
                      if (sources.length > 0) {
                        return (
                          <div className="console-sources">
                            {sources.map((source) => (
                              <span key={source} className="console-source" title={sourceLabels[source].hint}>
                                {sourceLabels[source].label}
                              </span>
                            ))}
                          </div>
                        );
                      }
                      return answeredFromModelAlone(message.toolsUsed) ? (
                        <div className="console-sources">
                          <span className="console-source unsourced"
                            title="Nothing on this machine was consulted. This came from the model itself.">
                            from the model alone
                          </span>
                        </div>
                      ) : null;
                    })() : null}
                  </article>
                ))
              )}
            </div>

            {/* The room, or TRHAI's own voice — whichever is genuinely being
                measured. Flat when neither is, rather than idling for show. */}
            <div className="console-wave" aria-hidden="true">
              {Array.from({ length: 48 }, (_, index) => {
                const profile = Math.abs(Math.sin((index / 48) * Math.PI * 3));
                const height = Math.max(1, Math.round(level * profile * 26));
                return <span key={index} style={{ height: `${height}px` }} />;
              })}
            </div>

            <div className="console-voice">
              <span className="hud-label">Voice input</span>
              <span className={`console-voice-state${mic.listening ? " live" : ""}`}>
                {mic.transcribing ? "Transcribing…" : mic.listening ? "Listening…" : "Idle"}
              </span>
              {/* Sound is opt-in and stays off until asked for. Cues fire on
                  real events only, so with nothing happening this is silent
                  either way. */}
              <button
                type="button"
                className={`console-cue${cues.enabled ? " on" : ""}`}
                onClick={cues.toggle}
                aria-pressed={cues.enabled}
                title={cues.enabled ? "Sound cues are on" : "Sound cues are off"}
              >
                {cues.enabled ? "◉ SOUND" : "○ SOUND"}
              </button>
              {/* Voice output, moved here from Settings.
                  Removing the tabs left the Settings surface with no entry
                  point, and this is the control the voice loop depends on —
                  a spoken assistant you cannot switch on is not a setting
                  buried somewhere, it is a missing feature. */}
            </div>
            {mic.error ? <p className="cc-note">{mic.error}</p> : null}
          </section>

          <CoreStatus
            temperatureC={telemetry?.gpu.temperatureC ?? null}
            uptimeSeconds={telemetry?.uptimeSeconds ?? null}
            load={label}
            clockMhz={telemetry?.cpu.speedMhz ?? null}
            cpuModel={telemetry?.cpu.model ?? null}
          />

          <SystemGauges
            vram={telemetry?.gpu.vram ?? null}
            disk={telemetry?.disk ?? null}
            network={telemetry?.network ?? null}
            health={health}
          />

          {/* How TRHAI answers. Behind the handle rather than on the stage: it
              is a setting, and the main screen is the core, the box and the
              microphone. It had no home at all after the surfaces went, which
              left the three personalities that carry a mandatory disclaimer
              impossible to select. */}
          {/* Hearing it is the only way to choose it. The preview speaks
              regardless of whether replies are read aloud: someone deciding on
              a voice has not necessarily decided to switch speech on. */}
          <VoicePicker
            choice={speech.voice}
            voices={speech.installedVoices}
            speaking={speech.speaking || speech.preparing}
            onChange={speech.setVoice}
            onPreview={(line) => speech.speak(line)}
          />

          <PersonalityPicker
            accent={accent}
            onAccentChange={(next) => {
              setAccent(next);
              writeStoredAccent(window.localStorage, next);
              // Applied to <html> immediately; the boot script only covers the
              // next load, and waiting for one would make the click feel dead.
              document.documentElement.setAttribute("data-accent", next);
            }}
            active={personalityId}
            onChange={(id) => {
              setPersonalityId(id);
              writeStoredPersonality(window.localStorage, id);
              // The prompts offered belong to the personality, so they change
              // with it. An installed agent still overrides them.
              const installed = activeAgent(readMarketplaceState(window.localStorage, marketplaceStorageKey));
              setSuggestions(installed?.suggestions ?? personalityById(id).suggestions ?? []);
            }}
          />

        </aside>

        <main className="cc-stage">
          <ParticleField state={core} className="cc-particles" />

          {/* Files and terminal, once there is genuinely something in them.
              There is nowhere else to be now, so this no longer has to yield
              to a surface the user opened. */}
          {didWork && !dismissedWork ? (
            <WorkView live={busy} onClose={() => setDismissedWork(true)} />
          ) : null}

          <div className="cc-core-title">
            <h1>TRH AI CORE</h1>
            <span className="cc-core-state">{label}</span>
          </div>

          <div className="cc-core-row">
            <Subsystems items={leftSubsystems} side="left" />

            {/* The one place worth a GL context. The badge in the surface
                header stays on the SVG core: a whole WebGL context to fill 52
                pixels would cost more than it drew, and none of the shader's
                detail survives at that size anyway. */}
            {/* Structure that reaches past the core, so the stage reads as an
                instrument built around something rather than a glowing circle
                dropped on a page. Purely environmental — these describe no
                reading, which is why they turn slowly enough to never compete
                with the parts that do. */}
            {bare ? <CoreHud readings={hudReadings} /> : null}

            <svg className="cc-arcs" viewBox="0 0 680 680" aria-hidden="true">
              <circle className="cc-arc-outer" cx="340" cy="340" r="330" />
              <circle className="cc-arc-mid" cx="340" cy="340" r="286" />
              <circle className="cc-arc-inner" cx="340" cy="340" r="248" />
            </svg>

            <div className="cc-core-wrap">
              <CoreGL
                state={core}
                size={bare ? 500 : 380}
                amplitude={mic.listening ? mic.amplitude : speech.speaking ? speech.amplitude : undefined}
                load={machineLoad}
              />
            </div>

            <Subsystems items={rightSubsystems} side="right" />
          </div>

          <div className="cc-actions">
            {/* Hands-free, not push-to-talk.
                Once this is on the microphone stays open and you simply speak;
                the voice-activity machine finds each utterance. It is a toggle
                rather than a hold because a conversation is many sentences and
                holding a button through all of them is the thing that makes a
                voice assistant feel like equipment. */}
            <button
              type="button"
              className={`cc-action${handsFree ? " live" : ""}`}
              disabled={!mic.supported}
              aria-pressed={handsFree}
              onClick={() => setHandsFree((on) => !on)}
              title={!mic.supported
                ? "This browser exposes no microphone."
                : handsFree
                  ? "Listening. Click to stop."
                  : "Listen continuously. Transcribed on this machine, never uploaded."}
            >
              <span className="cc-action-glyph" aria-hidden="true">{handsFree ? "◉" : "○"}</span>
              <span>{handsFree ? "LISTENING" : "TALK"}</span>
            </button>
            <button
              type="button"
              className={`cc-action cc-action-main${busy ? " live" : ""}`}
              onClick={() => (draft.trim() ? ask(draft) : inputRef.current?.focus())}
              title="Ask TRHAI"
            >
              <span className="cc-action-glyph" aria-hidden="true">▽</span>
              <span>THINK</span>
            </button>
            {/* Speaking belongs beside listening.
                This was in the console rail, which is closed by default - so an
                assistant that reads its replies aloud had its only switch on a
                panel nothing on screen pointed at. TALK is how you speak to it;
                this is how it speaks back, and the pair reads as one idea. It
                lights while actually speaking, not merely while switched on. */}
            <button
              type="button"
              className={`cc-action${speech.enabled ? " live" : ""}${speech.speaking ? " cc-action-speaking" : ""}`}
              onClick={() => speech.setEnabled(!speech.enabled)}
              aria-pressed={speech.enabled}
              disabled={speech.engine === "none"}
              title={speech.engine === "none"
                ? "No speech engine is installed."
                : speech.enabled
                  ? `Replies are read aloud${speech.neural?.available ? ` (${speech.neural.voice})` : ""}. Click to silence.`
                  : "Read replies aloud, on this machine."}
            >
              <span className="cc-action-glyph" aria-hidden="true">{speech.enabled ? "◉" : "○"}</span>
              <span>{speech.speaking ? "SPEAKING" : "VOICE"}</span>
            </button>
          </div>

          {/* What it is doing, while it does it.
              Hidden when the activity rail is open, because the rail carries
              the full trace of the same events - the screen shows the work
              once, in one place, exactly as it does with the reply.
              `now` is read at render rather than from a timer: while work is
              in flight the events poll every 400ms and re-render this anyway,
              and when nothing is running every row has a real measured
              duration and there is nothing left to count. */}
          {!rails.right ? <LiveOperations events={executionEvents} now={Date.now()} /> : null}

          {/* The answer, on the screen that asked for it.
              Rendered only while the console rail is closed: the rail carries
              the same turns, and showing the newest one in both places is the
              duplication this screen is meant not to have. Capped in height
              and scrolled internally so a long answer never pushes the core
              or the input off the stage. */}
          {stageReplyVisible(rails.left, lastReply !== null, replyIsFromThisRun) && lastReply ? (
            <section className="cc-reply" aria-live="polite">
              {lastAsked ? <p className="cc-reply-asked">{lastAsked.text}</p> : null}
              <Markdown text={lastReply.text} className="cc-reply-text" />
              {(() => {
                const sources = sourcesFor(lastReply.toolsUsed);
                if (sources.length > 0) {
                  return (
                    <div className="console-sources">
                      {sources.map((source) => (
                        <span key={source} className="console-source" title={sourceLabels[source].hint}>
                          {sourceLabels[source].label}
                        </span>
                      ))}
                    </div>
                  );
                }
                return answeredFromModelAlone(lastReply.toolsUsed) ? (
                  <div className="console-sources">
                    <span className="console-source unsourced"
                      title="Nothing on this machine was consulted. This came from the model itself.">
                      from the model alone
                    </span>
                  </div>
                ) : null;
              })()}
            </section>
          ) : null}

          <div className="cc-ask">
            <input
              ref={inputRef}
              className="cc-ask-field"
              value={draft}
              placeholder={busy
                ? "TRHAI is working…"
                : identity?.username
                  ? `How can I help you, ${displayName(identity.username)}?`
                  : "How can I help you?"}
              aria-label="Ask TRHAI anything"
              onFocus={() => setAttentive(true)}
              onBlur={() => setAttentive(false)}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") ask(draft); }}
            />
            {/* The microphone belongs beside the thing you speak into, not in
                a row of buttons above it. The ring lights and breathes while
                listening, driven by mic.listening rather than by a timer. */}
            {mic.supported ? (
              <button
                type="button"
                className={`cc-mic${mic.listening ? " live" : ""}`}
                aria-pressed={mic.listening}
                aria-label={mic.listening ? "Stop listening" : "Speak your request"}
                disabled={mic.transcribing}
                title={mic.listening
                  ? "Stop and transcribe"
                  : mic.transcriptionAvailable === false
                    ? `${mic.transcriptionReason} The microphone still works as a level meter.`
                    : "Speak your request. Transcribed on this machine, never uploaded."}
                onClick={() => void handleMic()}
              >
                {mic.transcribing ? "…" : "◉"}
              </button>
            ) : null}
            {/* Send becomes Stop while a request is in flight. One control in
                one place beats a second button that is dead most of the time,
                and Stop is only offered when there is genuinely something to
                stop. */}
            {busy ? (
              <button type="button" className="cc-ask-go cc-ask-stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="button" className="cc-ask-go" onClick={() => ask(draft)} disabled={!draft.trim()}>
                Send
              </button>
            )}
          </div>

          {mic.listening ? (
            <p className="cc-note">
              {mic.transcriptionAvailable
                ? "Listening. Press TALK again to stop — transcribed on this machine, never uploaded."
                : `Listening as a level meter only: ${mic.transcriptionReason}`}
            </p>
          ) : null}

          <div className="cc-suggestions">
            {suggestions.slice(0, 4).map((suggestion) => (
              <button key={suggestion} type="button" className="hud-chip" onClick={() => ask(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </main>

        {/* The right rail carries what the reference carries, and stops there.
            It had grown to eleven panels in a column that fits four, so the
            last seven were only reachable by scrolling a rail that looks like
            a fixed instrument cluster — the app never fit on the one screen it
            is supposed to be. The rest moved into this rail, below - there is
            no System surface any more, and a comment promising one was the
            same broken signpost as the copy that used to point at Tasks. */}
        <aside className="cc-right">
          {/* No "Active modules" panel here. It listed the same eight
              subsystems, with the same detail and the same live state, as the
              chips already flanking the core — the screen was reporting every
              subsystem twice and disagreeing with itself for a few hundred
              milliseconds after each poll. The chips keep the job because the
              reference puts them there and they are next to the thing they
              describe. */}
          <RecentActivity rows={activity} />
          {/* The list, with the controls that make it one. TodaysOverview
              counted a list nothing could add to; the counts moved into this
              panel's header rather than sitting in a second panel beside it. */}
          <TaskList
            tasks={tasks}
            onAdd={(title) => void (async () => {
              const result = await apiPost<{ task: TaskItem }>("/v1/tasks", { sessionId: sessionId(), title });
              // Appended from the response rather than the local string, so the
              // row carries the id and createdAt the server actually assigned.
              if (result.ok) setTasks((prior) => [...(prior ?? []), result.data.task]);
            })()}
            onToggle={(id, done) => void (async () => {
              const result = await apiPatch<{ task: TaskItem }>(`/v1/tasks/${id}`, { sessionId: sessionId(), done });
              if (result.ok) {
                setTasks((prior) => prior?.map((task) => (task.id === id ? result.data.task : task)) ?? null);
              }
            })()}
            onRemove={(id) => void (async () => {
              const result = await apiDelete(`/v1/tasks/${id}?sessionId=${encodeURIComponent(sessionId())}`);
              // Dropped only once the server has confirmed it. Removing on the
              // click and restoring on failure would show the list briefly
              // telling the truth and then taking it back.
              if (result.ok) setTasks((prior) => prior?.filter((task) => task.id !== id) ?? null);
            })()}
          />
          <CommandAccess active={rails.right} />
          {/* These used to live behind the System tab. There are no tabs now,
              so they moved into the rail rather than out of the app — the rail
              is on the same screen and opens with one click, which is what
              "one screen" has to mean if the information still matters. */}
          <SystemOverview rows={healthRows} />
          <ActiveTasks tasks={agentTasks} />
          <ExecutionTrace events={executionEvents} />
          <MemoryStatus
            entries={memories?.total ?? null}
            pinned={memories?.pinned ?? null}
            documents={documents}
            workspaceBytes={workspace?.bytes ?? null}
            workspaceFiles={workspace?.files ?? null}
          />
        </aside>
      </div>

      {/* Corner marks on the window itself. */}
      <div className="cc-frame" aria-hidden="true">
        <span /><span /><span /><span />
      </div>

      <footer className="cc-states mono">

        <div className="cc-states-stages">
          {stages.map((name) => (
            <span key={name} className={`cc-stage-word${stage === name ? " on" : ""}`}>{name}</span>
          ))}
        </div>
        <span className="cc-states-note faint">
          {answerCredit(lastReply?.strategy, lastReply?.model)
            ?? "Everything on this screen is measured on this machine."}
        </span>
      </footer>
    </div>
  );
}
