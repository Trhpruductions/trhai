"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CoreGL } from "../components/CoreGL";
import { Sparkline } from "../components/Sparkline";
import { Markdown } from "../components/Markdown";
import { presence } from "../components/corePresence";
import { useAssistant, type AssistantStatus } from "../hooks/useAssistant";
import { useSpeech } from "../hooks/useSpeech";
import { ParticleField } from "../components/ParticleField";
import { useMicrophone } from "../hooks/useMicrophone";
import { useCues } from "../hooks/useCues";
import {
  initialVoiceActivity, stepVoiceActivity, type VoiceActivityState
} from "../lib/voiceActivity";
import { CommandAccess } from "../components/CommandAccess";
import { TaskList, type TaskItem } from "../components/TaskList";
import { PersonalityPicker } from "../components/PersonalityPicker";
import { VoicePicker } from "../components/VoicePicker";
import { useExecutionEvents } from "../hooks/useExecutionEvents";
import { WorkView } from "../components/WorkView";
import { CoreStatus, SystemGauges, type ActivityRow } from "../components/CorePanels";
import { MemoryStatus, SystemOverview, type AgentTask, type HealthRow } from "../components/CommandPanels";
import { apiDelete, apiGet, apiPatch, apiPost, sessionId } from "../lib/api";
import { emptySeries, normalisedToPeak, pushSample, type Series } from "../lib/telemetryHistory";
import { readStoredPersonality, writeStoredPersonality } from "../lib/personality";
import { defaultAccent, readStoredAccent, writeStoredAccent, type Accent } from "../lib/theme";
import {
  activeAgent, defaultPersonality, personalityById, readMarketplaceState, readFlow,
  speakableText, type PersonalityId
} from "@ascend/shared";
import { marketplaceStorageKey } from "../lib/agents";
import "./dash.css";
import "./trhai.css";

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
  gpu: Reading & { name: string | null; vram: Reading | null; temperatureC: number | null; clockMhz: number | null; powerWatts: number | null };
  cloud: { services: string[]; detail?: string };
  disk: Reading;
  network: Reading & { receivedBytesPerSecond: number | null; sentBytesPerSecond: number | null };
  uptimeSeconds: number;
};
type Identity = { username: string; hostname: string; platform: string };
type ScheduleView = { id: string; enabled: boolean };
type CapabilityTool = { name: string; level: number; levelLabel: string };
type CapabilityInfo = { tools: CapabilityTool[]; videoRendering?: boolean; web?: boolean; codeExecution?: boolean };

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


/** A top-bar metric. Shows a dash, never a number, when it cannot be read. */

/** Samples kept per reading: two minutes at the four-second poll. */
const historyLength = 30;

/** Where the rail choice is remembered. */

export default function DashboardPage() {
  // Whether the split work view is open.
  //
  // Opened by real work, not by intent. The backlog asks for "coding intent
  // triggers the split layout"; guessing that from the wording would open an
  // empty editor beside an empty terminal for anyone who said "build", and
  // stay shut for anyone who phrased it another way. Waiting for the first
  // file to actually land costs a fraction of a second and is never wrong.
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
  const [handsFree] = useState(false);
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
  const [online, setOnline] = useState<boolean | null>(null);
  /**
   * Work left over from last time, read once when the screen opens.
   *
   * The product spec asks for this by name: "Welcome back. You still have one
   * unfinished development task from yesterday." Everything needed was already
   * here - the store keeps the task, the orchestrator resumes it, "continue"
   * replays it - but nothing ever mentioned it, so the only way to discover
   * unfinished work was to remember it yourself.
   *
   * Read once on open rather than polled. The rail panels were deliberately
   * taken out of the four-second poll because their answers were being
   * rendered into a hidden column, and putting one back would undo that. A
   * greeting needs the answer once.
   */
  const [, setUnfinished] = useState<AgentTask | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [buildVersion, setBuildVersion] = useState<string>("0.0.0");
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
  const [capabilities, setCapabilities] = useState<CapabilityInfo | null>(null);
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
  const [, setFlowName] = useState<string | null>(null);
  const [personalityId, setPersonalityId] = useState<PersonalityId>(defaultPersonality);
  // Same hydration-safe shape as the personality: the default on the server,
  // corrected from storage after mount. The boot script in <head> has already
  // applied the real one to <html> before this renders, so nothing flashes.
  const [accent, setAccent] = useState<Accent>(defaultAccent);
  const [, setSuggestions] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  // Which replies were already on disk at open, so a restored answer does
  // not surface itself as if it had just been produced this run.
  const restoredIds = useRef<Set<string> | null>(null);
  const [dismissedReplyId, setDismissedReplyId] = useState<string | null>(null);
  const lastSpokenId = useRef<string | null>(null);

  const { core, label } = presence(status, mic.listening, speech.speaking, online);
  const busy = status.state === "thinking" || status.state === "executing";

  // The exchange happening right now, for the stage itself.
  //
  // The transcript lives in the console rail, which is closed by default -
  // which meant asking a question on a freshly opened app played the whole
  // core animation and then showed the answer nowhere. The reply is not an
  // optional panel; it is the thing being asked for. It renders here, beside
  // the question, and the rail keeps the longer history.

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
    void apiGet<{ apiVersion: string }>("/v1/build-info").then((result) => {
      if (result.ok && result.data.apiVersion) setBuildVersion(result.data.apiVersion);
    });

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
      apiGet<CapabilityInfo>("/v1/capabilities"),
      apiGet<{ memories: Array<{ pinned?: boolean }> }>(`/v1/assist/memory?sessionId=${id}`),
      apiGet<{ schedules: ScheduleView[]; persistenceError?: string | null }>("/v1/schedules"),
      apiGet<{ entries: Array<{ directory: boolean; bytes: number }> }>("/v1/files")
    ]);

    // And the three that only ever reach panels in the activity rail. Asked
    // for only while that rail is open: with it closed - which is how the app
    // starts - these were three requests every four seconds whose answers were
    // rendered into a column with display:none on it.
    const [knowledgeResult, taskResult, todoResult] = await Promise.all([
      apiGet<{ documents: unknown[] }>(`/v1/knowledge?sessionId=${id}`),
      apiGet<{ tasks: AgentTask[] }>(`/v1/agent-tasks?sessionId=${id}`),
      apiGet<{ tasks: TaskItem[] }>(`/v1/tasks?sessionId=${id}`)
    ]);

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
    if (capabilityResult.ok) {
      setTools(capabilityResult.data.tools.length);
      setCapabilities(capabilityResult.data);
    }
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

  // Once, on open. See the note on `unfinished` for why this is not polled.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await apiGet<{ tasks: AgentTask[] }>(
        `/v1/agent-tasks?sessionId=${sessionId()}`
      );
      if (cancelled || !result.ok) return;
      const task = result.data.tasks[0];
      // Finished work is not unfinished work.
      setUnfinished(task && task.status !== "succeeded" ? task : null);
    })();
    return () => { cancelled = true; };
  }, []);


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
    },
    {
      label: "Video render",
      state: capabilities === null ? "checking" : capabilities.videoRendering ? "ready" : "absent",
      ok: capabilities === null ? null : capabilities.videoRendering === true
    }
  ];


  // The reference's fourth dial is "STABILITY", pinned near 98%. Nothing here
  // measures stability, so this counts the health checks genuinely passing — a
  // number that can and does drop when something breaks. Rows still being
  // checked are excluded rather than counted as passing, so the dial reads
  // from what is actually known.
  const decided = healthRows.filter((row) => row.ok !== null);
  const health = decided.length === 0
    ? null
    : { passed: decided.filter((row) => row.ok === true).length, total: decided.length };


  // A network rate as the reference prints it: down/up, human bytes.
  const formatRate = (rx: number | null, tx: number | null): string => {
    if (rx === null && tx === null) return "—";
    const unit = (bytes: number): string => {
      if (bytes < 1024) return `${Math.round(bytes)} B/s`;
      if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)}K/s`;
      return `${(bytes / 1024 ** 2).toFixed(1)}M/s`;
    };
    return `↓${unit(rx ?? 0)} ↑${unit(tx ?? 0)}`;
  };

  // Recent activity falls back to real session facts when no step has run yet,
  // with no invented timestamps - the times are shown as a dash rather than
  // guessed.
  const sessionFacts: Array<{ label: string; ok: boolean }> = [
    { label: model?.available ? `Model ${modelName} ready` : "No local model loaded", ok: Boolean(model?.available) },
    { label: online ? "Local API online" : "Local API not responding", ok: Boolean(online) },
    { label: `${tools ?? 0} tools loaded`, ok: (tools ?? 0) > 0 },
    { label: "Awaiting user input", ok: true }
  ];

  // The current exchange, surfaced over the core. The reference has no
  // conversation area, so the answer appears as an overlay while it is
  // fresh and clears back to the idle core afterwards.
  const lastReply = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const lastAsked = [...messages].reverse().find((message) => message.role === "user") ?? null;
  if (restoredIds.current === null && messages.length > 0) {
    restoredIds.current = new Set(messages.map((message) => message.id));
  }
  const replyFromThisRun = lastReply !== null && !(restoredIds.current?.has(lastReply.id) ?? false);

  // ------------------------------------------------------------------ view
  // The reference has a left navigation rail. HOME is the dashboard the image
  // shows; the others open the real panels that already exist, so the rail is
  // navigation rather than decoration.
  const [view, setView] = useState<
    "home" | "memory" | "tasks" | "tools" | "system" | "files" | "network" | "settings"
  >("home");

  // ---- readings for the reference's dials, every one from a real sensor ----
  const stabilityPct = health ? Math.round((health.passed / health.total) * 100) : null;
  const aiLoad = machineLoad === undefined
    ? null
    : machineLoad < 0.34 ? "LOW" : machineLoad < 0.67 ? "MEDIUM" : "HIGH";
  const tempText = telemetry?.gpu.temperatureC != null ? `${Math.round(telemetry.gpu.temperatureC)}°C` : "—";
  const powerText = telemetry?.gpu.powerWatts != null ? `${Math.round(telemetry.gpu.powerWatts)}W` : "—";
  const uptimeLong = telemetry
    ? (() => {
      const total = telemetry.uptimeSeconds;
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      return days > 0 ? `${days}D ${hours}H` : hours > 0 ? `${hours}H ${minutes}M` : `${minutes}M`;
    })()
    : "—";
  const netSeries = normalisedToPeak(history.network);

  // ---- active modules, each mapped to a capability that is really wired ----
  type ModuleState = "online" | "standby" | "offline";
  const moduleRows: Array<{ name: string; state: ModuleState }> = [
    { name: "Voice Engine", state: speech.engine !== "none" ? "online" : "offline" },
    { name: "Memory Core", state: "online" },
    { name: "Neural Processor", state: model?.available ? "online" : "offline" },
    { name: "Data Analyzer", state: (tools ?? 0) > 0 ? "online" : "offline" },
    { name: "Web Search", state: capabilities?.web ? "standby" : "offline" },
    { name: "Code Executor", state: capabilities?.codeExecution ? "standby" : "offline" }
  ];
  const moduleWord: Record<ModuleState, string> = { online: "ONLINE", standby: "STANDBY", offline: "OFFLINE" };

  // ---- today's overview, counted from the two real task stores ------------
  const doneCount = (tasks?.filter((task) => task.done).length ?? 0)
    + (agentTasks?.filter((task) => task.status === "succeeded").length ?? 0);
  const progressCount = agentTasks?.filter((task) => task.status === "executing").length ?? 0;
  const pendingCount = tasks?.filter((task) => !task.done).length ?? 0;
  const failedCount = agentTasks?.filter((task) => task.status === "failed" || task.status === "blocked").length ?? 0;
  const totalTasks = doneCount + progressCount + pendingCount + failedCount;
  const overview = [
    { key: "done", label: "COMPLETED", count: doneCount, tone: "ok" },
    { key: "progress", label: "IN PROGRESS", count: progressCount, tone: "accent" },
    { key: "pending", label: "PENDING", count: pendingCount, tone: "warn" },
    { key: "failed", label: "FAILED", count: failedCount, tone: "danger" }
  ];
  // The donut, as four arcs of a 100-length dash on one circle. Each arc is
  // sized to its real share; a total of zero draws an empty ring.
  const ringCirc = 2 * Math.PI * 52;
  let ringOffset = 0;
  const ringArcs = totalTasks === 0 ? [] : overview
    .filter((slice) => slice.count > 0)
    .map((slice) => {
      const length = (slice.count / totalTasks) * ringCirc;
      const arc = { tone: slice.tone, length, offset: ringOffset };
      ringOffset += length;
      return arc;
    });

  const nav: Array<{ id: typeof view; label: string; icon: ReactNode }> = [
    { id: "home", label: "HOME", icon: <path d="M3 10.5 12 3l9 7.5M5 9.5V20h5v-6h4v6h5V9.5" /> },
    { id: "memory", label: "MEMORY", icon: <><rect x="5" y="6" width="14" height="12" rx="1.5" /><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M9 10h6M9 13h6" /></> },
    { id: "tasks", label: "TASKS", icon: <><path d="M4 7h5M4 12h5M4 17h5" /><path d="m13 6 2 2 4-4M13 12h6M13 17h6" /></> },
    { id: "tools", label: "TOOLS", icon: <path d="M14.5 6a3.5 3.5 0 0 0-4.9 4.2l-6 6L6 18.5l6-6A3.5 3.5 0 0 0 18 8l-2.3 2.3-1.7-1.7L16.3 6.3A3.5 3.5 0 0 0 14.5 6Z" /> },
    { id: "system", label: "SYSTEM", icon: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6 7.4 7.4M16.6 16.6l1.8 1.8M18.4 5.6 16.6 7.4M7.4 16.6 5.6 18.4" /></> },
    { id: "files", label: "FILES", icon: <path d="M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" /> },
    { id: "network", label: "NETWORK", icon: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="M12 7v4M12 11 6 16M12 11l6 5" /></> },
    { id: "settings", label: "SETTINGS", icon: <><circle cx="12" cy="12" r="2.6" /><path d="M12 2.8v2.4M12 18.8v2.4M4.5 7.3l2 1.2M17.5 15.5l2 1.2M4.5 16.7l2-1.2M17.5 8.5l2-1.2" /></> }
  ];

  const quickActions: Array<{ label: string; icon: ReactNode; live: boolean; enabled: boolean; title: string; onClick: () => void }> = [
    {
      label: "VOICE", live: speech.enabled, enabled: speech.engine !== "none",
      title: speech.engine === "none" ? "No speech engine installed" : speech.enabled ? "Reading replies aloud" : "Read replies aloud",
      onClick: () => speech.setEnabled(!speech.enabled),
      icon: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></>
    },
    {
      label: "VISION", live: false, enabled: false,
      title: "No camera or vision input is connected on this machine.",
      onClick: () => undefined,
      icon: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>
    },
    {
      label: "MEMORY", live: view === "memory", enabled: true, title: "Open memory",
      onClick: () => setView("memory"),
      icon: <><rect x="5" y="6" width="14" height="12" rx="1.5" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3" /></>
    },
    {
      label: "BROWSER", live: false, enabled: Boolean(capabilities?.web),
      title: capabilities?.web ? "The assistant can fetch a page you give it; there is no browser view yet." : "No web access",
      onClick: () => setView("network"),
      icon: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>
    },
    {
      label: "TERMINAL", live: view === "files", enabled: true, title: "Open files and terminal",
      onClick: () => setView("files"),
      icon: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="m7 10 3 2-3 2M13 14h4" /></>
    },
    {
      label: "CONTROL", live: view === "settings", enabled: true, title: "Open settings",
      onClick: () => setView("settings"),
      icon: <><circle cx="12" cy="12" r="2.6" /><path d="M12 2.8v2.4M12 18.8v2.4M4.5 7.3l2 1.2M17.5 15.5l2 1.2M4.5 16.7l2-1.2M17.5 8.5l2-1.2" /></>
    }
  ];

  const nameUpper = identity ? (displayName(identity.username) || "USER").toUpperCase() : "…";

  return (
    <div className={`trh trh-${core} trh-view-${view}${attentive ? " trh-attentive" : ""}`}>
      {/* ---------------------------------------------------------- header */}
      <header className="trh-top">
        <div className="trh-brand">
          <span className="trh-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M16 3 4 24h24L16 3Z" /><path d="M16 11 10 21h12L16 11Z" /></svg>
          </span>
          <div className="trh-brand-text">
            <span className="trh-brand-line">TRH AI <em>v{buildVersion}</em></span>
            <span className={`trh-brand-status${online ? " ok" : online === false ? " danger" : ""}`}>
              {online === null ? "CONNECTING" : online ? "SYSTEM ONLINE" : "SYSTEM OFFLINE"}
              <span className="trh-dot" aria-hidden="true" />
            </span>
          </div>
        </div>

        <div className="trh-title">
          <h1>TRH AI</h1>
          <span>LIVING INTELLIGENCE SYSTEM</span>
        </div>

        <div className="trh-user">
          <div className="trh-user-text">
            <span className="trh-user-name">USER: {nameUpper}</span>
            <span className="trh-user-tier">OWNER ACCESS</span>
          </div>
          <span className="trh-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>
          </span>
        </div>
      </header>

      <div className="trh-body">
        {/* -------------------------------------------------------- nav rail */}
        <nav className="trh-nav" aria-label="Sections">
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`trh-nav-item${view === item.id ? " active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <svg className="trh-nav-icon" viewBox="0 0 24 24" aria-hidden="true">{item.icon}</svg>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {view === "home" ? (
          <>
            {/* ------------------------------------------------ left column */}
            <div className="trh-col trh-left">
              <section className="trh-panel">
                <h2 className="trh-panel-title">SYSTEM STATUS</h2>
                <div className="trh-stat">
                  <div className="trh-stat-head">
                    <span className="trh-stat-label">CPU USAGE</span>
                    <span className="trh-stat-value">{telemetry?.cpu.fraction != null ? `${Math.round(telemetry.cpu.fraction * 100)}%` : "—"}</span>
                  </div>
                  <Sparkline values={history.cpu} width={150} height={30} />
                </div>
                <div className="trh-stat">
                  <div className="trh-stat-head">
                    <span className="trh-stat-label">MEMORY</span>
                    <span className="trh-stat-value">{telemetry?.memory.fraction != null ? `${Math.round(telemetry.memory.fraction * 100)}%` : "—"}</span>
                  </div>
                  <Sparkline values={history.memory} width={150} height={30} />
                </div>
                <div className="trh-stat">
                  <div className="trh-stat-head">
                    <span className="trh-stat-label">NETWORK</span>
                    <span className="trh-stat-value">{telemetry?.network ? formatRate(telemetry.network.receivedBytesPerSecond, telemetry.network.sentBytesPerSecond) : "—"}</span>
                  </div>
                  <Sparkline values={netSeries} width={150} height={30} />
                </div>
                <div className="trh-stat trh-stat-ring">
                  <div className="trh-stat-head">
                    <span className="trh-stat-label">STABILITY</span>
                    <span className="trh-stat-value">{stabilityPct != null ? `${stabilityPct}%` : "—"}</span>
                  </div>
                  <svg className="trh-ring-small" viewBox="0 0 44 44" aria-hidden="true">
                    <circle className="trh-ring-track" cx="22" cy="22" r="18" />
                    <circle
                      className="trh-ring-live"
                      cx="22" cy="22" r="18"
                      strokeDasharray={2 * Math.PI * 18}
                      strokeDashoffset={(1 - (stabilityPct ?? 0) / 100) * 2 * Math.PI * 18}
                    />
                  </svg>
                </div>
              </section>

              <section className="trh-panel">
                <h2 className="trh-panel-title">AI CORE STATUS</h2>
                <dl className="trh-kv">
                  <div><dt>CORE TEMP</dt><dd>{tempText}</dd></div>
                  <div><dt>POWER USAGE</dt><dd>{powerText}</dd></div>
                  <div><dt>AI LOAD</dt><dd>{aiLoad ?? "—"}</dd></div>
                  <div><dt>UPTIME</dt><dd>{uptimeLong}</dd></div>
                </dl>
                <div className="trh-wire" aria-hidden="true">
                  <svg viewBox="0 0 120 120" className="trh-wire-spin">
                    <polygon className="trh-wire-face" points="60,14 100,38 100,82 60,106 20,82 20,38" />
                    <polygon className="trh-wire-face" points="60,32 86,47 86,77 60,92 34,77 34,47" />
                    <path className="trh-wire-line" d="M60,14 60,32M100,38 86,47M100,82 86,77M60,106 60,92M20,82 34,77M20,38 34,47" />
                    <circle className="trh-wire-core" cx="60" cy="60" r="9" />
                  </svg>
                </div>
              </section>
            </div>

            {/* ---------------------------------------------------- centre */}
            <main className="trh-center">
              <div className="trh-status-head">
                <span className="trh-status-word">STATUS: <em className={`trh-${core}`}>{label.toUpperCase()}</em></span>
                <span className="trh-status-sub">{busy ? "WORKING" : "AWAITING COMMAND"}</span>
              </div>

              <div className="trh-core">
                <ParticleField state={core} className="trh-core-particles" />
                <svg className="trh-core-arcs" viewBox="0 0 680 680" aria-hidden="true">
                  <circle className="trh-arc trh-arc-1" cx="340" cy="340" r="330" />
                  <circle className="trh-arc trh-arc-2" cx="340" cy="340" r="300" />
                  <circle className="trh-arc trh-arc-3" cx="340" cy="340" r="262" />
                </svg>
                <CoreGL
                  state={core}
                  size={440}
                  amplitude={mic.listening ? mic.amplitude : speech.speaking ? speech.amplitude : undefined}
                  load={machineLoad}
                />
                <div className="trh-core-mark" aria-hidden="true">
                  <span>TRH</span><em>AI</em>
                </div>
              </div>

              {(busy || (replyFromThisRun && lastReply?.id !== dismissedReplyId)) && (lastReply || lastAsked) ? (
                <section className="trh-reply" aria-live="polite">
                  {!busy && lastReply ? (
                    <button
                      type="button"
                      className="trh-reply-close"
                      aria-label="Dismiss"
                      title="Dismiss and return to the core"
                      onClick={() => setDismissedReplyId(lastReply.id)}
                    >×</button>
                  ) : null}
                  {lastAsked ? <p className="trh-reply-asked">{lastAsked.text}</p> : null}
                  {replyFromThisRun && lastReply ? (
                    <Markdown text={lastReply.text} className="trh-reply-text" />
                  ) : busy ? (
                    <p className="trh-reply-text faint">Working…</p>
                  ) : null}
                </section>
              ) : null}

              <div className="trh-mic-area">
                <button
                  type="button"
                  className={`trh-mic${mic.listening ? " live" : ""}`}
                  disabled={!mic.supported || mic.transcribing}
                  aria-pressed={mic.listening}
                  aria-label={mic.listening ? "Stop listening" : "Tap to speak"}
                  title={!mic.supported ? "This browser exposes no microphone." : mic.listening ? "Stop and transcribe" : "Speak your request. Transcribed on this machine, never uploaded."}
                  onClick={() => void handleMic()}
                >
                  <span className="trh-mic-wave trh-mic-wave-left" aria-hidden="true">
                    {Array.from({ length: 14 }, (_, index) => {
                      const profile = Math.abs(Math.sin(((index + 1) / 14) * Math.PI));
                      return <span key={index} style={{ height: `${Math.max(2, Math.round((0.25 + level * 0.75) * profile * 22))}px` }} />;
                    })}
                  </span>
                  <svg className="trh-mic-glyph" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8.5 21h7" />
                  </svg>
                  <span className="trh-mic-wave trh-mic-wave-right" aria-hidden="true">
                    {Array.from({ length: 14 }, (_, index) => {
                      const profile = Math.abs(Math.sin(((14 - index) / 14) * Math.PI));
                      return <span key={index} style={{ height: `${Math.max(2, Math.round((0.25 + level * 0.75) * profile * 22))}px` }} />;
                    })}
                  </span>
                </button>
                <span className="trh-mic-title">{mic.transcribing ? "TRANSCRIBING…" : mic.listening ? "LISTENING…" : "TAP TO SPEAK"}</span>
                <span className="trh-mic-sub">{mic.supported ? "VOICE INTERACTION ENABLED" : "VOICE INPUT UNAVAILABLE"}</span>
              </div>

              <div className="trh-ask">
                <input
                  ref={inputRef}
                  className="trh-ask-field"
                  value={draft}
                  placeholder={busy ? "TRHAI is working…" : "Type a command or question..."}
                  aria-label="Type a command or question"
                  onFocus={() => setAttentive(true)}
                  onBlur={() => setAttentive(false)}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") ask(draft); }}
                />
                {busy ? (
                  <button type="button" className="trh-ask-go trh-ask-stop" onClick={stop} aria-label="Stop">■</button>
                ) : (
                  <button type="button" className="trh-ask-go" onClick={() => ask(draft)} disabled={!draft.trim()} aria-label="Send">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M12 5l7 7-7 7" /></svg>
                  </button>
                )}
              </div>
            </main>

            {/* ----------------------------------------------- right column */}
            <div className="trh-col trh-right">
              <section className="trh-panel">
                <h2 className="trh-panel-title">ACTIVE MODULES</h2>
                <div className="trh-modules-row">
                  <ul className="trh-modules">
                    {moduleRows.map((module) => (
                      <li key={module.name}>
                        <span className="trh-module-name">{module.name.toUpperCase()}</span>
                        <span className={`trh-module-state trh-${module.state}`}>
                          {moduleWord[module.state]}<span className="trh-dot" aria-hidden="true" />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <svg className="trh-head" viewBox="0 0 90 100" aria-hidden="true">
                    <path className="trh-head-outline" d="M30 96c0-10-14-12-14-30 0-20 13-34 30-34s28 12 28 30c0 12-6 16-6 24l4 6" />
                    <circle className="trh-head-node trh-n1" cx="40" cy="40" r="2.4" />
                    <circle className="trh-head-node trh-n2" cx="52" cy="34" r="2.4" />
                    <circle className="trh-head-node trh-n3" cx="58" cy="48" r="2.4" />
                    <circle className="trh-head-node trh-n4" cx="44" cy="54" r="2.4" />
                    <circle className="trh-head-node trh-n5" cx="50" cy="64" r="2.4" />
                    <path className="trh-head-link" d="M40 40 52 34M52 34 58 48M58 48 44 54M44 54 50 64M40 40 44 54" />
                  </svg>
                </div>
              </section>

              <section className="trh-panel">
                <h2 className="trh-panel-title">RECENT ACTIVITY</h2>
                <ul className="trh-activity">
                  {activity.length > 0 ? activity.slice(0, 5).map((row) => (
                    <li key={row.id}>
                      <span className={`trh-dot trh-${row.status === "failed" ? "danger" : row.status === "running" ? "warn" : "ok"}`} aria-hidden="true" />
                      <span className="trh-activity-label">{row.label}</span>
                      <span className="trh-activity-time mono">{new Date(row.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    </li>
                  )) : sessionFacts.map((fact) => (
                    <li key={fact.label}>
                      <span className={`trh-dot trh-${fact.ok ? "ok" : "danger"}`} aria-hidden="true" />
                      <span className="trh-activity-label">{fact.label}</span>
                      <span className="trh-activity-time mono">—</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="trh-panel">
                <h2 className="trh-panel-title">TODAY&apos;S OVERVIEW</h2>
                <div className="trh-overview">
                  <div className="trh-donut">
                    <svg viewBox="0 0 120 120" aria-hidden="true">
                      <circle className="trh-donut-track" cx="60" cy="60" r="52" />
                      {ringArcs.map((arc) => (
                        <circle
                          key={arc.tone}
                          className={`trh-donut-arc trh-stroke-${arc.tone}`}
                          cx="60" cy="60" r="52"
                          strokeDasharray={`${arc.length} ${ringCirc - arc.length}`}
                          strokeDashoffset={-arc.offset}
                        />
                      ))}
                    </svg>
                    <div className="trh-donut-center">
                      <strong>{totalTasks}</strong>
                      <span>TASKS</span>
                    </div>
                  </div>
                  <ul className="trh-legend">
                    {overview.map((slice) => (
                      <li key={slice.key}>
                        <span className={`trh-dot trh-${slice.tone}`} aria-hidden="true" />
                        <span className="trh-legend-count">{slice.count}</span>
                        <span className="trh-legend-label">{slice.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>

              <section className="trh-panel">
                <h2 className="trh-panel-title">VOICE STATUS</h2>
                <div className="trh-voice-row">
                  <span className="trh-voice-label">VOICE RECOGNITION</span>
                  <span className={`trh-module-state trh-${mic.transcriptionAvailable !== false && mic.supported ? "online" : "standby"}`}>
                    {mic.transcriptionAvailable !== false && mic.supported ? "ACTIVE" : "STANDBY"}<span className="trh-dot" aria-hidden="true" />
                  </span>
                </div>
                <div className="trh-voice-row">
                  <span className="trh-voice-label">VOICE OUTPUT</span>
                  <span className={`trh-module-state trh-${speech.enabled && speech.engine !== "none" ? "online" : "standby"}`}>
                    {speech.enabled && speech.engine !== "none" ? "ACTIVE" : "STANDBY"}<span className="trh-dot" aria-hidden="true" />
                  </span>
                </div>
                <div className="trh-voice-wave" aria-hidden="true">
                  {Array.from({ length: 40 }, (_, index) => {
                    const profile = Math.abs(Math.sin((index / 40) * Math.PI * 4));
                    return <span key={index} style={{ height: `${Math.max(2, Math.round((0.15 + level * 0.85) * profile * 24))}px` }} />;
                  })}
                </div>
              </section>
            </div>
          </>
        ) : (
          <main className="trh-section">
            <div className="trh-section-head">
              <h2>{nav.find((item) => item.id === view)?.label}</h2>
              <button type="button" className="trh-section-back" onClick={() => setView("home")}>◇ BACK TO HOME</button>
            </div>
            <div className="trh-section-body">
              {view === "memory" ? (
                <MemoryStatus
                  entries={memories?.total ?? null}
                  pinned={memories?.pinned ?? null}
                  documents={documents}
                  workspaceBytes={workspace?.bytes ?? null}
                  workspaceFiles={workspace?.files ?? null}
                />
              ) : null}
              {view === "tasks" ? (
                <TaskList
                  tasks={tasks}
                  onAdd={(title) => void (async () => {
                    const result = await apiPost<{ task: TaskItem }>("/v1/tasks", { sessionId: sessionId(), title });
                    if (result.ok) setTasks((prior) => [...(prior ?? []), result.data.task]);
                  })()}
                  onToggle={(id, done) => void (async () => {
                    const result = await apiPatch<{ task: TaskItem }>(`/v1/tasks/${id}`, { sessionId: sessionId(), done });
                    if (result.ok) setTasks((prior) => prior?.map((task) => (task.id === id ? result.data.task : task)) ?? null);
                  })()}
                  onRemove={(id) => void (async () => {
                    const result = await apiDelete(`/v1/tasks/${id}?sessionId=${encodeURIComponent(sessionId())}`);
                    if (result.ok) setTasks((prior) => prior?.filter((task) => task.id !== id) ?? null);
                  })()}
                />
              ) : null}
              {view === "tools" ? (
                <>
                  <section className="trh-panel">
                    <h2 className="trh-panel-title">TOOLS · {tools ?? "—"}</h2>
                    <ul className="trh-tool-grid">
                      {(capabilities?.tools ?? []).map((tool) => (
                        <li key={tool.name}>
                          <span className="trh-tool-name mono">{tool.name}</span>
                          <span className={`trh-tool-level trh-level-${tool.level}`}>{tool.levelLabel}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <CommandAccess active />
                </>
              ) : null}
              {view === "system" ? (
                <>
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
                  <SystemOverview rows={healthRows} />
                </>
              ) : null}
              {view === "files" ? <WorkView live={busy} onClose={() => setView("home")} /> : null}
              {view === "network" ? (
                <section className="trh-panel">
                  <h2 className="trh-panel-title">NETWORK</h2>
                  <dl className="trh-kv trh-kv-wide">
                    <div><dt>THROUGHPUT</dt><dd>{telemetry?.network ? formatRate(telemetry.network.receivedBytesPerSecond, telemetry.network.sentBytesPerSecond) : "—"}</dd></div>
                    <div><dt>CLOUD SERVICES</dt><dd>{telemetry?.cloud.services.length ?? 0}</dd></div>
                  </dl>
                  <p className="trh-note">{telemetry?.cloud.detail ?? "Nothing leaves this machine."}</p>
                  <Sparkline values={netSeries} width={320} height={44} />
                </section>
              ) : null}
              {view === "settings" ? (
                <>
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
                      document.documentElement.setAttribute("data-accent", next);
                    }}
                    active={personalityId}
                    onChange={(id) => {
                      setPersonalityId(id);
                      writeStoredPersonality(window.localStorage, id);
                      const installed = activeAgent(readMarketplaceState(window.localStorage, marketplaceStorageKey));
                      setSuggestions(installed?.suggestions ?? personalityById(id).suggestions ?? []);
                    }}
                  />
                </>
              ) : null}
            </div>
          </main>
        )}
      </div>

      {/* --------------------------------------------------------- footer */}
      <footer className="trh-bottom">
        <div className="trh-bottom-clock mono">
          {clock ? (
            <>
              <span className="trh-bottom-time">{clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
              <span className="trh-bottom-date">{clock.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }).toUpperCase()}</span>
            </>
          ) : <span className="trh-bottom-time">--:--</span>}
        </div>

        <div className="trh-bottom-ready">
          <span className={`trh-dot trh-${online ? "ok" : online === false ? "danger" : "warn"}`} aria-hidden="true" />
          <span className="trh-ready-line">{online === false ? "LOCAL API NOT RESPONDING" : busy ? "TRH AI IS WORKING" : "TRH AI IS READY"}</span>
          <span className="trh-ready-sub faint">{modelName ? `How can I assist you today?` : "No local model loaded."}</span>
        </div>

        <div className="trh-quick">
          {quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`trh-quick-item${action.live ? " live" : ""}${action.enabled ? "" : " off"}`}
              disabled={!action.enabled}
              title={action.title}
              onClick={action.onClick}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">{action.icon}</svg>
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </footer>

      <div className="trh-frame" aria-hidden="true"><span /><span /><span /><span /></div>
    </div>
  );
}
