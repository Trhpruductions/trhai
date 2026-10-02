"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { asksAboutTheScreen, speakableText } from "@ascend/shared";
import { useAssistant, type AssistantStatus, type ChatMessage } from "../../hooks/useAssistant";
import { useMicrophone } from "../../hooks/useMicrophone";
import { useSpeech } from "../../hooks/useSpeech";
import { useCues } from "../../hooks/useCues";
import { useReminders } from "../../hooks/useReminders";
import { useExecutionEvents, type ExecutionEvent } from "../../hooks/useExecutionEvents";
import { presence } from "../../components/corePresence";
import type { CoreState } from "../../components/Core";
import { initialVoiceActivity, stepVoiceActivity, type VoiceActivityState } from "../../lib/voiceActivity";
import {
  acceptedImageTypes, defaultImageQuestion, maxAttachments, prepareImage, refuseImage, type Attachment
} from "../../lib/imageAttach";
import { canShareScreen, shareScreen } from "../../lib/screenShare";
import { apiPost } from "../../lib/api";
import { readActiveAgent } from "../../lib/agents";
import type { Agent } from "@ascend/shared";
import { useNotify } from "./notify";
import { useNav } from "./nav";
import { useSystem } from "./system";

// The conversation, the composer and the voice - everything that was the old
// page's own state, moved here so every workspace shares one of each.
//
// Split into contexts by how often they change. The microphone's level moves
// every animation frame; only the core and the waveforms read it (LevelContext).
// Everything else would re-render the whole app sixty times a second if it
// lived in the same value.

export type ActivityEntry = {
  id: string;
  at: number;
  source: string;
  text: string;
  tone: "info" | "ok" | "warn" | "danger" | "accent";
};

type AssistantApi = {
  messages: ChatMessage[];
  status: AssistantStatus;
  restored: boolean;
  busy: boolean;
  /** The core's state and its words, from real state alone - see corePresence. */
  core: CoreState;
  label: string;
  send: (text: string, images?: Array<{ name: string; data: string }>) => Promise<void>;
  stop: () => void;
  clear: () => Promise<void>;
  // The composer, shared: the command bar on every workspace is the same one.
  draft: string;
  setDraft: (next: string | ((prior: string) => string)) => void;
  attachments: Attachment[];
  attachNote: string | null;
  sharing: boolean;
  screenShareable: boolean;
  /** Send the draft (or the given words) with any attachments. */
  ask: (text: string) => void;
  addImages: (files: File[]) => Promise<void>;
  /** Share the screen into the next message's attachments. */
  attachScreen: () => void;
  removeAttachment: (id: string) => void;
  openImagePicker: () => void;
  /** The command field has focus - the core leans in. */
  attentive: boolean;
  setAttentive: (attentive: boolean) => void;
  /** The newest exchange, for the stage. */
  lastAsked: ChatMessage | null;
  lastReply: ChatMessage | null;
  /** True when the newest reply was produced in this run, not restored from disk. */
  replyFromThisRun: boolean;
  dismissedReplyId: string | null;
  dismissReply: (id: string) => void;
  agent: Agent | null;
  setAgent: (agent: Agent | null) => void;
  executionEvents: ExecutionEvent[];
};

type VoiceApi = {
  mic: {
    supported: boolean;
    listening: boolean;
    transcribing: boolean;
    error: string | null;
    transcriptionAvailable: boolean | null;
    transcriptionReason: string | null;
  };
  speech: Omit<ReturnType<typeof useSpeech>, "amplitude">;
  /** Tap: start listening, or stop and send what was said. */
  toggleMic: () => Promise<void>;
  handsFree: boolean;
  setHandsFree: (on: boolean) => void;
};

type Levels = {
  micAmplitude: number;
  speechAmplitude: number | undefined;
  /** The room while listening, the voice while speaking, the work otherwise. */
  level: number;
};

const AssistantContext = createContext<AssistantApi | null>(null);
const VoiceContext = createContext<VoiceApi | null>(null);
const LevelContext = createContext<Levels>({ micAmplitude: 0, speechAmplitude: undefined, level: 0 });
const ActivityContext = createContext<ActivityEntry[]>([]);

const activityLimit = 80;

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { messages, status, restored, send, stop, clear } = useAssistant();
  const mic = useMicrophone();
  const speech = useSpeech();
  const cues = useCues();
  const { notify } = useNotify();
  const { view, go } = useNav();
  const { online } = useSystem();

  const busy = status.state === "thinking" || status.state === "executing";
  const { core, label } = presence(status, mic.listening, speech.speaking, online);
  const executionEvents = useExecutionEvents(busy);

  // ---------------------------------------------------------------- activity
  const [log, setLog] = useState<ActivityEntry[]>([]);
  const record = useCallback((source: string, text: string, tone: ActivityEntry["tone"] = "info") => {
    setLog((prior) => [{ id: crypto.randomUUID(), at: Date.now(), source, text, tone }, ...prior].slice(0, activityLimit));
  }, []);

  // ---------------------------------------------------------------- reminders
  useReminders((reminder) => {
    cues.play(reminder.failed ? "warn" : "done");
    if (speech.enabled && !reminder.failed) speech.speak(`${reminder.title}. ${reminder.body}`);
    notify({
      level: reminder.failed ? "warning" : "info",
      title: reminder.failed ? `Schedule failed: ${reminder.title}` : reminder.title === reminder.body ? "Reminder" : reminder.title,
      body: reminder.body,
      source: "SCHEDULER",
      sticky: true
    });
    record("SCHEDULER", reminder.failed ? `${reminder.title} failed` : `Reminder: ${reminder.body}`, reminder.failed ? "warn" : "accent");
  });

  // ---------------------------------------------------------------- composer
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [screenShareable, setScreenShareable] = useState(false);
  const [attentive, setAttentive] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const imagePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser capabilities and stored choices, unknowable on the server
    setScreenShareable(canShareScreen());
    setAgent(readActiveAgent(window.localStorage));
  }, []);

  const addImages = useCallback(async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    const room = maxAttachments - attachments.length;
    const refused = images.map(refuseImage).find(Boolean) ?? null;
    const usable = images.filter((file) => !refuseImage(file)).slice(0, Math.max(0, room));
    try {
      const prepared = await Promise.all(usable.map(prepareImage));
      setAttachments((prior) => [...prior, ...prepared].slice(0, maxAttachments));
      setAttachNote(refused ?? (images.length > room ? `Up to ${maxAttachments} images can go with one message.` : null));
      // The vision model loads while the question is typed rather than after Send.
      if (prepared.length > 0) void apiPost("/v1/vision/warm", {});
    } catch {
      setAttachNote("That image could not be read.");
    }
  }, [attachments.length]);

  /** The screen, for the next message; null when it was not shared, with the reason shown. */
  const captureScreen = useCallback(async (): Promise<Attachment[] | null> => {
    setSharing(true);
    try {
      const shared = await shareScreen();
      if (!shared.ok) {
        setAttachNote(shared.reason);
        return null;
      }
      const room = Math.max(0, maxAttachments - attachments.length);
      for (const extra of shared.shots.slice(room)) URL.revokeObjectURL(extra.previewUrl);
      const shots = shared.shots.slice(0, room);
      setAttachNote(shots.length < shared.shots.length ? `Up to ${maxAttachments} images can go with one message.` : null);
      if (shots.length === 0) return null;
      void apiPost("/v1/vision/warm", {});
      return shots;
    } finally {
      setSharing(false);
    }
  }, [attachments.length]);

  const attachScreen = useCallback(() => {
    void captureScreen().then((shots) => {
      if (shots) setAttachments((prior) => [...prior, ...shots].slice(0, maxAttachments));
    });
  }, [captureScreen]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prior) => {
      const gone = prior.find((attachment) => attachment.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prior.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const ask = useCallback((text: string) => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || busy || sharing) return;
    // A question about the screen with no picture of it: share the screen,
    // then send the two together. The words stay in the box until then.
    if (attachments.length === 0 && asksAboutTheScreen(trimmed)) {
      void captureScreen().then((shots) => {
        if (!shots) {
          setDraft((existing) => (existing.trim() ? existing : trimmed));
          return;
        }
        setDraft("");
        cues.play("send");
        for (const shot of shots) URL.revokeObjectURL(shot.previewUrl);
        void send(trimmed, shots.map(({ name, data }) => ({ name, data })));
      });
      return;
    }
    setDraft("");
    cues.play("send");
    const images = attachments.map(({ name, data }) => ({ name, data }));
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments([]);
    setAttachNote(null);
    void send(trimmed || defaultImageQuestion, images);
  }, [attachments, busy, sharing, captureScreen, cues, send]);

  const openImagePicker = useCallback(() => imagePicker.current?.click(), []);

  // ---------------------------------------------------------------- voice
  const [handsFree, setHandsFree] = useState(false);
  const vad = useRef<VoiceActivityState>(initialVoiceActivity(0));

  // Read through refs: the microphone's state object changes every frame
  // while it is open, and a toggle rebuilt that often would change the voice
  // context - and re-render everything reading it - sixty times a second.
  const live = useRef({ mic, speech, cues, busy, ask });
  useEffect(() => { live.current = { mic, speech, cues, busy, ask }; });
  const askRef = useRef(ask);
  useEffect(() => { askRef.current = ask; }, [ask]);

  const toggleMic = useCallback(async () => {
    const current = live.current;
    if (!current.mic.listening) {
      // Stop any reply being read, or the microphone transcribes TRH AI's own voice.
      current.speech.stop();
      current.cues.play("listen");
      await current.mic.start();
      return;
    }
    const said = await current.mic.stop();
    if (!said) return;
    // Spoken requests run straight through; during a long answer the words
    // wait in the box rather than being dropped.
    if (live.current.busy) {
      setDraft((existing) => (existing.trim() ? `${existing.trim()} ${said}` : said));
      return;
    }
    live.current.ask(said);
  }, []);

  // The hands-free loop: decides where each utterance ends from the
  // microphone's own level, and never listens while TRH AI talks or works.
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
        if (said) askRef.current(said);
      });
    }
  }, [handsFree, mic, speech.speaking, busy]);

  // Turning hands-free on opens the microphone; off closes it.
  useEffect(() => {
    if (handsFree && !mic.listening) {
      speech.stop();
      cues.play("listen");
      vad.current = initialVoiceActivity(performance.now());
      void mic.start();
    }
    if (!handsFree && mic.listening) void mic.stop();
    // Only on the toggle itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [handsFree]);

  // ---------------------------------------------------------------- replies
  // A reply restored from disk is history, not news: useAssistant gives every
  // restored turn a "restored-" id, which is what keeps a days-old answer off
  // the stage the moment the app opens.
  const [dismissedReplyId, setDismissedReplyId] = useState<string | null>(null);
  const lastReply = useMemo(() => [...messages].reverse().find((message) => message.role === "assistant") ?? null, [messages]);
  const lastAsked = useMemo(() => [...messages].reverse().find((message) => message.role === "user") ?? null, [messages]);
  const replyFromThisRun = lastReply !== null && !lastReply.id.startsWith("restored-");

  // Read the newest reply aloud when voice is on - never restored history,
  // never mid-stream, never twice, never into an open microphone.
  const lastSpokenId = useRef<string | null>(null);
  useEffect(() => {
    if (!speech.enabled) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.role !== "assistant" || newest.id.startsWith("restored-") || newest.streaming) return;
    if (lastSpokenId.current === newest.id) return;
    lastSpokenId.current = newest.id;
    if (mic.listening && !handsFree) return;
    speech.speak(speakableText(newest.text));
  }, [messages, speech, mic.listening, handsFree]);

  // Cues, notices and activity on the transitions themselves, not the states.
  const previous = useRef<AssistantStatus>(status);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was.state === status.state && (status.state !== "executing" || (was.state === "executing" && was.tool === status.tool))) return;
    // The status arrives from useAssistant's own polling of the API; logging
    // each change as it lands is copying that stream into the activity log.
    if (status.state === "thinking" && was.state !== "executing") record("AI CORE", "Processing request", "accent");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (status.state === "executing") record("TOOL EXECUTOR", `Running ${status.tool.replace(/_/g, " ")}`, "accent");
    if (status.state === "success") {
      cues.play("done");
      record("TRH AI", "Response generated", "ok");
      if (viewRef.current !== "chat" && viewRef.current !== "home") {
        const newest = messages[messages.length - 1];
        notify({
          level: "success", title: "TRH AI replied", source: "TRH AI",
          body: newest?.role === "assistant" ? speakableText(newest.text).slice(0, 140) : undefined,
          action: { label: "Open chat", run: () => go("chat") }
        });
      }
    }
    if (status.state === "error") {
      cues.play("error");
      record("AI CORE", status.detail, "danger");
      notify({ level: "error", title: "TRH AI could not answer", body: status.detail, source: "AI CORE" });
    }
  }, [status, cues, record, notify, go, messages]);

  const wasListening = useRef(false);
  useEffect(() => {
    if (mic.listening && !wasListening.current) record("VOICE ENGINE", handsFree ? "Listening (hands-free)" : "Listening", "accent");
    if (!mic.listening && wasListening.current) record("VOICE ENGINE", "Microphone closed");
    wasListening.current = mic.listening;
  }, [mic.listening, handsFree, record]);
  const wasTranscribing = useRef(false);
  useEffect(() => {
    if (mic.transcribing && !wasTranscribing.current) record("VOICE ENGINE", "Transcribing on this PC", "accent");
    wasTranscribing.current = mic.transcribing;
  }, [mic.transcribing, record]);
  const wasSpeaking = useRef(false);
  useEffect(() => {
    if (speech.speaking && !wasSpeaking.current) record("VOICE OUTPUT", "Speaking", "accent");
    wasSpeaking.current = speech.speaking;
  }, [speech.speaking, record]);
  const wasOnline = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasOnline.current !== null && online !== null && wasOnline.current !== online) {
      record("SYSTEM", online ? "Local API online" : "Local API not responding", online ? "ok" : "danger");
    }
    if (online !== null) wasOnline.current = online;
  }, [online, record]);

  // The tool steps the API logged, merged into the same stream.
  const activity = useMemo<ActivityEntry[]>(() => {
    const steps: ActivityEntry[] = executionEvents.map((event) => ({
      id: `step-${event.id}`,
      at: Date.parse(event.startedAt) || 0,
      source: "TOOL EXECUTOR",
      text: event.label,
      tone: event.status === "failed" ? "danger" : event.status === "running" ? "warn" : "ok"
    }));
    return [...log, ...steps].sort((a, b) => b.at - a.at).slice(0, activityLimit);
  }, [log, executionEvents]);

  // ---------------------------------------------------------------- values
  const level = mic.listening
    ? mic.amplitude
    : speech.speaking && speech.amplitude !== undefined
      ? speech.amplitude
      : status.state === "executing" ? 1 : status.state === "thinking" ? 0.6 : 0;

  const assistant = useMemo<AssistantApi>(() => ({
    messages, status, restored, busy, core, label, send, stop, clear,
    draft, setDraft, attachments, attachNote, sharing, screenShareable, ask, addImages, attachScreen,
    removeAttachment, openImagePicker, attentive, setAttentive, lastAsked, lastReply, replyFromThisRun,
    dismissedReplyId, dismissReply: setDismissedReplyId, agent, setAgent, executionEvents
  }), [messages, status, restored, busy, core, label, send, stop, clear, draft, attachments, attachNote, sharing,
    screenShareable, ask, addImages, attachScreen, removeAttachment, openImagePicker, attentive, lastAsked, lastReply,
    replyFromThisRun, dismissedReplyId, agent, executionEvents]);

  const voice = useMemo<VoiceApi>(() => ({
    mic: {
      supported: mic.supported,
      listening: mic.listening,
      transcribing: mic.transcribing,
      error: mic.error,
      transcriptionAvailable: mic.transcriptionAvailable,
      transcriptionReason: mic.transcriptionReason
    },
    speech: {
      enabled: speech.enabled, setEnabled: speech.setEnabled, engine: speech.engine, neural: speech.neural,
      speaking: speech.speaking, preparing: speech.preparing, error: speech.error, speak: speech.speak, stop: speech.stop,
      voice: speech.voice, setVoice: speech.setVoice, installedVoices: speech.installedVoices
    },
    toggleMic,
    handsFree,
    setHandsFree
  }), [mic.supported, mic.listening, mic.transcribing, mic.error, mic.transcriptionAvailable, mic.transcriptionReason,
    speech.enabled, speech.setEnabled, speech.engine, speech.neural, speech.speaking, speech.preparing, speech.error,
    speech.speak, speech.stop, speech.voice, speech.setVoice, speech.installedVoices, toggleMic, handsFree]);

  const levels = useMemo<Levels>(() => ({ micAmplitude: mic.amplitude, speechAmplitude: speech.amplitude, level }),
    [mic.amplitude, speech.amplitude, level]);

  return (
    <AssistantContext.Provider value={assistant}>
      <VoiceContext.Provider value={voice}>
        <LevelContext.Provider value={levels}>
          <ActivityContext.Provider value={activity}>
            {children}
            <input
              ref={imagePicker}
              type="file"
              accept={acceptedImageTypes}
              multiple
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                void addImages(files);
              }}
            />
          </ActivityContext.Provider>
        </LevelContext.Provider>
      </VoiceContext.Provider>
    </AssistantContext.Provider>
  );
}

export function useAssistantState(): AssistantApi {
  const assistant = useContext(AssistantContext);
  if (!assistant) throw new Error("useAssistantState needs AssistantProvider");
  return assistant;
}

export function useVoice(): VoiceApi {
  const voice = useContext(VoiceContext);
  if (!voice) throw new Error("useVoice needs AssistantProvider");
  return voice;
}

/** The live levels. Read only where something draws them - they change every frame. */
export function useLevels(): Levels {
  return useContext(LevelContext);
}

export function useActivity(): ActivityEntry[] {
  return useContext(ActivityContext);
}
