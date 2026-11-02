"use client";

import { useEffect, useState } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { acceptTexts, fetchPrivacySummary, type ConsentLine } from "../lib/privacy";
import { useAccount } from "./AppGate";
import { LegalLink } from "./LegalDialog";
import "./paywall.css";

// Shown to a signed-in person when a text they must agree to has changed since they did,
// or when their account was made before agreements were recorded. It says which texts,
// opens each, and records the agreement only when the button is pressed. "Not now" puts it
// away for this session: nothing is agreed to by closing it.

export function ConsentPrompt() {
  const { account } = useAccount();
  const [lines, setLines] = useState<ConsentLine[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const open = Boolean(account) && !hidden && (lines?.some((line) => !line.upToDate) ?? false);
  const ref = useDialogFocus<HTMLElement>(open, () => setHidden(true));

  useEffect(() => {
    if (!account) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to agree to without an account
      setLines(null);
      return;
    }
    let alive = true;
    void fetchPrivacySummary().then((result) => {
      if (alive && result.ok) setLines(result.data.consents);
    });
    return () => { alive = false; };
  }, [account]);

  if (!open || !lines) return null;
  const stale = lines.filter((line) => !line.upToDate);

  const agree = async () => {
    setBusy(true);
    setProblem(null);
    const result = await acceptTexts();
    setBusy(false);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    setLines(result.data.consents);
  };

  return (
    <div className="paywall-scrim" role="presentation">
      <section ref={ref} className="paywall" role="dialog" aria-modal="true" aria-labelledby="consent-prompt-title" tabIndex={-1}>
        <span className="os-label">Please read and agree</span>
        <h2 id="consent-prompt-title">{stale.length === 1 ? `The ${stale[0].label} has changed` : "Some texts have changed"}</h2>
        <p>
          To keep using TRH AI with your account, please read {stale.length === 1 ? "it" : "them"} and agree. Nothing is agreed to by closing this.
        </p>
        <ul className="paywall-points">
          {stale.map((line) => (
            <li key={line.kind}>
              <span aria-hidden="true" />
              <span>
                <LegalLink id={line.kind === "age" ? "terms" : line.kind}>{line.label}</LegalLink>
                {line.kind === "age"
                  ? ` - confirm that you are at least ${line.current} years old.`
                  : line.acceptedAt
                    ? ` - version ${line.current}; you agreed to version ${line.acceptedVersion} on ${new Date(line.acceptedAt).toLocaleDateString()}.`
                    : ` - version ${line.current}; no agreement is recorded for your account.`}
              </span>
            </li>
          ))}
        </ul>
        {problem ? <p className="paywall-note bad" role="alert">{problem}</p> : null}
        <div className="os-view-actions">
          <button type="button" className="os-btn os-btn-primary" disabled={busy} onClick={() => void agree()}>
            {busy ? "Recording…" : stale.some((line) => line.kind === "age") ? "I have read them, and I am old enough" : "I have read them and agree"}
          </button>
          <button type="button" className="os-btn os-btn-ghost" disabled={busy} onClick={() => setHidden(true)}>Not now</button>
        </div>
      </section>
    </div>
  );
}
