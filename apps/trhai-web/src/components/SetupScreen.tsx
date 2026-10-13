"use client";

import { useEffect, useState } from "react";
import { readSetup } from "../lib/setup";
import { SetupPanel } from "./SetupPanel";
import "./paywall.css";
import "./setup.css";

// The first thing a new PC sees once the app is open: TRH AI cannot answer
// until it has its engine and a model, so it says so and offers to fetch them.
//
// "Not now" hides it for this session; Settings > Engine and models is always
// there. It also stays up after setup finishes, until "Start using TRH AI", so
// the last step's result is seen rather than vanishing mid-read.

const dismissedKey = "trhai.setup.dismissed.v1";

function dismissedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(dismissedKey) === "1";
  } catch {
    return false;
  }
}

export function SetupScreen() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (dismissedThisSession()) return;
    void readSetup().then((status) => {
      if (alive && status?.needsSetup) setOpen(true);
    });
    return () => { alive = false; };
  }, []);

  if (!open) return null;

  const close = () => {
    try { window.sessionStorage.setItem(dismissedKey, "1"); } catch { /* this session only, and optional */ }
    setOpen(false);
  };

  return (
    <div className="paywall-scrim setup-scrim">
      <section className="paywall setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <span className="os-label">First run</span>
        <h2 id="setup-title">Set up TRH AI on this PC</h2>
        <p>
          TRH AI runs entirely on this PC, so it needs two things here before it can answer: the engine that runs AI models,
          and at least one model. The one recommended below suits this PC.
        </p>
        <SetupPanel mode="first-run" onDone={() => setOpen(false)} />
        <div className="os-view-actions">
          <button type="button" className="os-btn os-btn-ghost" onClick={close}>Not now</button>
        </div>
      </section>
    </div>
  );
}
