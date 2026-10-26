"use client";

import { useEffect, useState } from "react";
import { readSetup, setupReason } from "../lib/setup";
import { SetupPanel } from "./SetupPanel";
import "./paywall.css";
import "./setup.css";

// The first thing a new PC sees once the app is open: TRH AI cannot answer
// until it has its engine and a model, so it says so and offers to fetch them,
// with the voice, listening and video tools ticked beside them.
//
// A PC that can already answer sees it once more, with only the tools, when it
// has not been offered them: a copy installed before they existed never was.
//
// "Not now" hides it for this session; Settings > Engine and models is always
// there. It also stays up after setup finishes, until "Start using TRH AI", so
// the last step's result is seen rather than vanishing mid-read.

const dismissedKey = "trhai.setup.dismissed.v1";
const toolsOfferedKey = "trhai.setup.tools-offered.v1";

function dismissedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(dismissedKey) === "1";
  } catch {
    return false;
  }
}

function toolsOffered(): boolean {
  try {
    return window.localStorage.getItem(toolsOfferedKey) === "1";
  } catch {
    return false;
  }
}

/** Remembered as soon as the screen opens, so that it is offered once however it is closed. */
function rememberToolsOffered(): void {
  try {
    window.localStorage.setItem(toolsOfferedKey, "1");
  } catch { /* the offer then repeats, which is better than never being made */ }
}

export function SetupScreen() {
  const [reason, setReason] = useState<"first-run" | "tools" | null>(null);

  useEffect(() => {
    let alive = true;
    if (dismissedThisSession()) return;
    void readSetup().then((status) => {
      const why = status ? setupReason(status, toolsOffered()) : null;
      if (!alive || !why) return;
      rememberToolsOffered();
      setReason(why);
    });
    return () => { alive = false; };
  }, []);

  if (!reason) return null;

  const close = () => {
    try { window.sessionStorage.setItem(dismissedKey, "1"); } catch { /* this session only, and optional */ }
    setReason(null);
  };

  return (
    <div className="paywall-scrim setup-scrim">
      <section className="paywall setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        {reason === "first-run" ? (
          <>
            <span className="os-label">First run</span>
            <h2 id="setup-title">Set up TRH AI on this PC</h2>
            <p>
              TRH AI runs entirely on this PC, so it needs two things here before it can answer: the engine that runs AI models,
              and at least one model. The two recommended below suit this PC: one to talk with and one that reads pictures, both
              answering what they are asked. The voice, listening and video tools are ticked too, so that everything works from
              the first minute; untick any you do not want.
            </p>
          </>
        ) : (
          <>
            <span className="os-label">New in this version</span>
            <h2 id="setup-title">Add voice, listening and video</h2>
            <p>
              TRH AI can now install three optional tools for you: a natural voice that reads its answers aloud, listening so that you
              can talk to it, and video so that it can make short narrated videos. All of it runs on this PC. They are ticked below;
              untick any you do not want, or just start using TRH AI. They stay in Settings, Engine and models, for whenever you do.
            </p>
          </>
        )}
        <SetupPanel mode="first-run" focus={reason === "tools" ? "tools" : "everything"} onDone={() => setReason(null)} />
        {/* The panel has its own way out once this PC can answer ("Start using TRH AI"), which is the case for the tools offer. */}
        {reason === "first-run" ? (
          <div className="os-view-actions">
            <button type="button" className="os-btn os-btn-ghost" onClick={close}>Not now</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
