"use client";

import { useEffect, useState } from "react";
import { SystemRings } from "../../components/SystemRings";
import { apiGet } from "../../lib/api";
import "./system.css";

// System: what is actually running, and what this build actually is.
//
// The point of this page is that a bug report against "TRHAI" is meaningless
// without it. Three copies of this app existed on one machine at once during
// development, at different ages, and nothing on screen could tell them
// apart — buildInfo.ts exists because of that, and this is where it surfaces.
//
// Every row is a live reading from a real endpoint. Nothing here is a
// configured value echoed back: the model name comes from asking Ollama, the
// voice from whether the Piper binary is actually on disk, transcription from
// whether a whisper model file is really there. A service that is missing
// says why, because "not installed" is the useful half of that answer.

type BuildInfo = {
  apiVersion: string;
  webVersion: string;
  desktopVersion: string;
  environment: string;
  gitCommit: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
  gitCommitDate: string | null;
  gitDirty: boolean | null;
  serverStartedAt: string;
};

type ModelInfo = { available: boolean; model?: string; reason?: string };
type SpeechInfo = { available: boolean; voice?: string; reason?: string; voices?: Array<{ id: string }> };
type TranscribeInfo = { available: boolean; model?: string; reason?: string; sampleRate?: number };
type Schedule = { id: string; enabled: boolean; lastStatus: string | null };

/** A service row: what it is, whether it is really there, and what it is. */
function Service({
  name, what, available, detail, reason
}: {
  name: string;
  what: string;
  available: boolean | null;
  detail: string | null;
  reason: string | null;
}) {
  return (
    <div className="svc">
      <div className="svc-head">
        <span className={`svc-dot${available === true ? " on" : available === false ? " off" : ""}`} aria-hidden="true" />
        <b>{name}</b>
        <span className={`svc-state${available ? " ok" : ""}`}>
          {available === null ? "checking…" : available ? "running" : "not available"}
        </span>
      </div>
      <p className="faint svc-what">{what}</p>
      {/* The reason a thing is missing is the useful half of the answer.
          "not available" alone leaves you with nowhere to go next. */}
      {available === false && reason ? <p className="svc-reason">{reason}</p> : null}
      {available && detail ? <p className="svc-detail mono">{detail}</p> : null}
    </div>
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export default function SystemPage() {
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [speech, setSpeech] = useState<SpeechInfo | null>(null);
  const [transcribe, setTranscribe] = useState<TranscribeInfo | null>(null);
  const [tools, setTools] = useState<number | null>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  // Null until mounted: "5m ago" computed during render disagrees with the
  // client a moment later, which is a hydration mismatch on every load.
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    let cancelled = false;

    async function read() {
      const [buildResult, modelResult, speechResult, transcribeResult, capabilities, scheduled] =
        await Promise.all([
          apiGet<BuildInfo>("/v1/build-info"),
          apiGet<ModelInfo>("/v1/assist/model"),
          apiGet<SpeechInfo>("/v1/speech"),
          apiGet<TranscribeInfo>("/v1/transcribe"),
          apiGet<{ tools: unknown[] }>("/v1/capabilities"),
          apiGet<{ schedules: Schedule[] }>("/v1/schedules")
        ]);

      if (cancelled) return;
      // One reachability answer for the page, from the request that would
      // fail first. Showing each row as separately unreachable would be six
      // ways of saying the API is down.
      setReachable(buildResult.ok);
      if (buildResult.ok) setBuild(buildResult.data);
      if (modelResult.ok) setModel(modelResult.data);
      if (speechResult.ok) setSpeech(speechResult.data);
      if (transcribeResult.ok) setTranscribe(transcribeResult.data);
      if (capabilities.ok) setTools(capabilities.data.tools.length);
      if (scheduled.ok) setSchedules(scheduled.data.schedules);
    }

    void read();
    const poller = window.setInterval(() => void read(), 10_000);
    return () => { cancelled = true; window.clearInterval(poller); };
  }, []);

  const enabledSchedules = schedules?.filter((schedule) => schedule.enabled).length ?? null;

  return (
    <div className="system">
      <header className="system-head">
        <h1>System</h1>
        <p className="muted">
          What is running on this machine, and exactly which build you are looking at. Every value
          here is read live — nothing is a setting echoed back at you.
        </p>
      </header>

      {reachable === false ? (
        <p className="panel system-down">
          The local API is not responding, so none of this can be read. Start it and this page
          fills in on its own.
        </p>
      ) : null}

      <div className="system-grid">
        {/* The same live rings as the dashboard, deliberately reused rather
            than reimplemented — two versions of a hardware readout would be
            two things to keep honest. */}
        <SystemRings />

        <section className="hud-panel">
          <span className="hud-label">This build</span>
          {!build ? (
            <p className="faint">Reading…</p>
          ) : (
            <dl className="hud-readouts">
              <div><dt>API</dt><dd className="mono">{build.apiVersion}</dd></div>
              <div><dt>Web</dt><dd className="mono">{build.webVersion}</dd></div>
              <div><dt>Desktop</dt><dd className="mono">{build.desktopVersion}</dd></div>
              <div><dt>Environment</dt><dd>{build.environment}</dd></div>
              <div>
                <dt>Branch</dt>
                <dd className="mono">{build.gitBranch ?? "not a git checkout"}</dd>
              </div>
              <div>
                <dt>Commit</dt>
                <dd className="mono" title={build.gitCommit ?? ""}>
                  {build.gitCommitShort ?? "—"}
                  {/* Uncommitted changes mean the running code is not the
                      commit named above it. Worth saying outright on a page
                      whose job is telling builds apart. */}
                  {build.gitDirty ? <span className="system-dirty"> · uncommitted changes</span> : null}
                </dd>
              </div>
              {build.gitCommitDate ? (
                <div>
                  <dt>Committed</dt>
                  <dd>{new Date(build.gitCommitDate).toLocaleString(undefined, {
                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                  })}</dd>
                </div>
              ) : null}
              <div>
                <dt>API started</dt>
                <dd>{mounted ? relativeTime(build.serverStartedAt) : "—"}</dd>
              </div>
            </dl>
          )}
        </section>

        <section className="hud-panel system-services">
          <span className="hud-label">Local services</span>

          <Service
            name="Language model"
            what="Answers everything. Runs on this machine through Ollama."
            available={model === null ? null : model.available}
            detail={model?.model ?? null}
            reason={model?.reason ?? "No local model is running."}
          />

          <Service
            name="Voice"
            what="Reads replies aloud with a neural voice, generated locally."
            available={speech === null ? null : speech.available}
            detail={speech?.voice ? `${speech.voice}${speech.voices ? ` · ${speech.voices.length} installed` : ""}` : null}
            reason={speech?.reason ?? "Piper is not installed."}
          />

          <Service
            name="Transcription"
            what="Turns speech into text with whisper.cpp. Audio never leaves this machine."
            available={transcribe === null ? null : transcribe.available}
            detail={transcribe?.model ? `${transcribe.model} · ${(transcribe.sampleRate ?? 16000) / 1000}kHz mono` : null}
            reason={transcribe?.reason ?? "No whisper model is installed."}
          />

          <Service
            name="Scheduler"
            what="Runs schedules on a timer, whether or not a browser is open."
            available={schedules === null ? null : true}
            detail={enabledSchedules === null
              ? null
              : `${enabledSchedules} active of ${schedules?.length ?? 0}`}
            reason={null}
          />
        </section>

        <section className="hud-panel">
          <span className="hud-label">Reach</span>
          <dl className="hud-readouts">
            <div><dt>Tools registered</dt><dd>{tools === null ? "—" : tools}</dd></div>
            <div><dt>Schedules</dt><dd>{schedules === null ? "—" : schedules.length}</dd></div>
            {/* Stated plainly rather than left to be inferred from an absence.
                An empty integrations list is a fact about this build, and it
                is the fact most people would want confirmed. */}
            <div><dt>Third-party services</dt><dd className="ok">none</dd></div>
            <div><dt>API keys required</dt><dd className="ok">none</dd></div>
          </dl>
          <p className="faint system-note">
            Everything above runs against this machine&rsquo;s own storage and a local model. There is
            no account to sign into and no key to paste in.
          </p>
        </section>
      </div>
    </div>
  );
}
