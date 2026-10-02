"use client";

import { useEffect, useRef, useState } from "react";
import { CoreGL } from "./CoreGL";
import { ParticleField } from "./ParticleField";
import type { CoreState } from "./Core";
import { useElementWidth } from "../hooks/useElementWidth";
import { apiBaseUrl } from "../lib/api";
import { browserStores, readStoredAuth, type SignedInAccount } from "../lib/auth";
import { bootProgress, checkService, checkTheRest, initialSteps, type BootState, type BootStep } from "../lib/boot";

// The first thing the app shows: the core, coming up, and what it is checking.
//
// Each line is a real request to the local service, and the screen leaves when
// the answers are in. The only time spent for its own sake is the intro - a
// fast machine would otherwise flash this for a frame and look broken.

const introMs = 1500;
const serviceRetryMs = 1000;
/** After this long without the service, say what is going on. */
const slowServiceMs = 10000;
const exitMs = 480;

export type BootResult = { account: SignedInAccount | null; sessionExpired: boolean };

function StepIcon({ state }: { state: BootState }) {
  if (state === "running") return <span className="gate-icon" aria-hidden="true"><span className="gate-spinner" /></span>;
  if (state === "ok") {
    return <span className="gate-icon ok" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>;
  }
  if (state === "warn") {
    return <span className="gate-icon warn" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.5v.5" /></svg></span>;
  }
  if (state === "fail") {
    return <span className="gate-icon fail" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></span>;
  }
  return <span className="gate-icon pending" aria-hidden="true" />;
}

export function BootScreen({ onReady }: { onReady: (result: BootResult) => void }) {
  const [steps, setSteps] = useState<BootStep[]>(initialSteps);
  const [serviceUp, setServiceUp] = useState(false);
  const [slow, setSlow] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const finished = useRef(false);
  const coreBox = useRef<HTMLDivElement>(null);
  const coreWidth = useElementWidth(coreBox);
  // Read through a ref so a parent re-render cannot restart the checks.
  const ready = useRef(onReady);
  useEffect(() => { ready.current = onReady; }, [onReady]);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    const update = (patch: Omit<BootStep, "label">) => {
      if (cancelled) return;
      setSteps((prior) => prior.map((step) => (step.id === patch.id ? { ...step, ...patch } : step)));
    };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    void (async () => {
      update({ id: "service", state: "running", detail: "Connecting" });
      const slowTimer = setTimeout(() => { if (!cancelled) setSlow(true); }, slowServiceMs);

      // The desktop app starts the service alongside this window, so it may
      // well not be up yet. Asked again every second, for as long as it takes.
      while (!cancelled && !(await checkService(apiBaseUrl, fetch))) {
        await pause(serviceRetryMs);
      }
      clearTimeout(slowTimer);
      if (cancelled) return;
      setSlow(false);
      setServiceUp(true);
      update({ id: "service", state: "ok", detail: "Connected" });

      const { local, session } = browserStores();
      const stored = readStoredAuth(local, session);
      const findings = await checkTheRest(apiBaseUrl, fetch, stored?.token ?? null, update);
      if (cancelled) return;
      setVersion(findings.version);

      // Let the last answer register on screen before leaving.
      await pause(Math.max(380, introMs - (Date.now() - started)));
      if (cancelled || finished.current) return;
      finished.current = true;
      setLeaving(true);
      await pause(exitMs);
      if (!cancelled) ready.current({ account: findings.account, sessionExpired: findings.sessionExpired });
    })();

    return () => { cancelled = true; };
  }, []);

  const progress = bootProgress(steps, serviceUp);
  const done = steps.every((step) => step.state === "ok" || step.state === "warn" || step.state === "fail");
  const core: CoreState = !serviceUp ? (slow ? "offline" : "thinking") : done ? "success" : "thinking";
  const current = steps.find((step) => step.state === "running");

  return (
    <div className={`gate gate-booting${leaving ? " leaving" : ""}`} role="status" aria-live="polite" aria-label="TRH AI is starting">
      <ParticleField state={core} className="gate-particles" />
      {/* Standing exactly on the key art's own globe (gate.css), at its size,
          so the start-up screen shows one globe rather than two. */}
      <div className="gate-core" ref={coreBox}>
        <CoreGL state={core} size={coreWidth ?? 420} />
        <div className="gate-core-mark" aria-hidden="true">
          <span>TRH</span>
          <em>AI</em>
        </div>
      </div>
      <div className="gate-boot">
        <h1 className="gate-wordmark">TRH AI</h1>
        <p className="gate-tagline">LIVING INTELLIGENCE SYSTEM</p>

        <div className={`gate-progress${done ? " done" : ""}`}>
          <div
            className="gate-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label="Start-up checks"
          >
            <div className="gate-progress-fill" style={{ width: `${Math.max(4, progress * 100)}%` }} />
          </div>
          <div className="gate-progress-meta">
            <span>{done ? "READY" : current ? `CHECKING ${current.label.toUpperCase()}` : "STARTING"}</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        </div>

        <ul className="gate-steps">
          {steps.map((step) => (
            <li key={step.id} className={`gate-step ${step.state}`}>
              <StepIcon state={step.state} />
              <span className="gate-step-label">{step.label}</span>
              <span className="gate-step-detail" title={step.detail}>{step.detail}</span>
            </li>
          ))}
        </ul>

        {slow ? (
          <p className="gate-slow" role="alert">
            <strong>The local service has not answered yet.</strong> It starts with the app, and the first launch
            after an update can take up to a minute. This keeps checking on its own - if it never comes up, close
            TRH AI and open it again.
          </p>
        ) : null}

        <p className="gate-foot">
          <span className="gate-dot" aria-hidden="true" />
          Runs entirely on this machine{version ? ` · v${version}` : ""}
        </p>
      </div>
    </div>
  );
}
