"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { legalVersions } from "@ascend/shared";
import { Icon } from "../os/ui/Icon";
import { useNotify } from "../os/state/notify";
import { radioTabIndex } from "../lib/focus";
import { moveRadio } from "../lib/radio";
import {
  acceptTexts, describeErasure, eraseWord, fetchPrivacySummary, requestErase, requestExport, saveTextFile,
  type EraseReport, type EraseScope, type PrivacySummary
} from "../lib/privacy";
import {
  browserStorage, readStorageConsent, storageConsentEvent, writeStorageConsent, type StorageConsent, type StorageDecision
} from "../lib/storageConsent";
import { useAccount } from "./AppGate";
import { LegalLink } from "./LegalDialog";
import "./legal.css";

// Settings > Privacy and consent: what you agreed to, whether the app may remember your
// choices, a copy of everything it holds for you, and erasing it.
//
// Every fact on this screen is read from the service, which is the one that holds the data
// and decides what may be erased by whom. The screen adds nothing to that: it asks, shows
// the answer in words, and does what was asked. An erasure is described in full - with the
// real numbers - before the word that confirms it is typed.

const dateOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");

function ConsentsSection({ summary, signedIn, onChanged }: { summary: PrivacySummary | null; signedIn: boolean; onChanged: () => void }) {
  const { notify } = useNotify();
  const [busy, setBusy] = useState(false);
  const stale = summary?.consents.filter((line) => !line.upToDate) ?? [];

  const agree = async () => {
    setBusy(true);
    const result = await acceptTexts();
    setBusy(false);
    if (!result.ok) {
      notify({ level: "error", title: "Not recorded", body: result.reason, source: "SETTINGS" });
      return;
    }
    notify({ level: "success", title: "Recorded", body: "Your agreement to the current texts is kept with your account.", source: "SETTINGS" });
    onChanged();
  };

  return (
    <section className="os-panel">
      <header className="os-panel-head">
        <h3 className="os-panel-title">What you agreed to</h3>
        {summary && signedIn ? <span className={`os-chip ${stale.length ? "warn" : "ok"}`}>{stale.length ? "Needs your agreement" : "Up to date"}</span> : null}
      </header>
      <div className="os-panel-body os-stack">
        {!signedIn ? (
          <p className="os-small os-dim">
            You are using TRH AI without an account, so no agreement is recorded on your behalf, and nothing about you is kept
            beyond this browser&rsquo;s own random id. The <LegalLink id="terms" /> still apply to using the software, and the{" "}
            <LegalLink id="privacy" /> says what is stored on this PC.
          </p>
        ) : !summary ? <p className="os-faint">Reading…</p> : (
          <>
            <ul className="privacy-lines">
              {summary.consents.map((line) => (
                <li key={line.kind}>
                  <span>
                    {line.kind === "age" ? <strong>{line.label}</strong> : <LegalLink id={line.kind}><strong>{line.label}</strong></LegalLink>}
                    <span className="os-faint os-small">
                      {" "}{line.kind === "age" ? `(at least ${line.current} years old)` : `(version ${line.current})`}
                    </span>
                  </span>
                  <span className="os-small os-dim">
                    {line.acceptedAt
                      ? `${line.upToDate ? "Agreed" : `Agreed to version ${line.acceptedVersion}`} on ${dateOf(line.acceptedAt)}${line.via === "registration" ? ", when the account was made" : ""}`
                      : "No agreement recorded"}
                  </span>
                </li>
              ))}
            </ul>
            {stale.length ? (
              <>
                <p className="os-small os-dim">
                  {stale.some((line) => !line.acceptedAt)
                    ? "Your account was made before agreements were recorded, or a text has changed since you agreed. "
                    : "A text has changed since you agreed. "}
                  Read {stale.length === 1 ? "it" : "them"} (the links above), then record your agreement. Nothing is agreed to until you press the button.
                </p>
                <div>
                  <button type="button" className="os-btn os-btn-sm os-btn-primary" disabled={busy} onClick={() => void agree()}>
                    <Icon name="check" size={14} />{busy ? "Recording…" : "I have read them and agree"}
                  </button>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function StorageSection() {
  const { notify } = useNotify();
  const [consent, setConsent] = useState<StorageConsent | null | undefined>(undefined);

  useEffect(() => {
    const read = () => setConsent(readStorageConsent(browserStorage().local));
    read();
    window.addEventListener(storageConsentEvent, read);
    return () => window.removeEventListener(storageConsentEvent, read);
  }, []);

  const choose = (decision: StorageDecision) => {
    const { local, session } = browserStorage();
    setConsent(writeStorageConsent(local, session, decision, legalVersions.storage));
    notify({
      level: "success", title: decision === "all" ? "Choices will be remembered" : "Only what is needed",
      body: decision === "all" ? "Your accent, voice and other choices are kept in this window's storage." : "Remembered choices were removed; the app keeps only what it needs to work.",
      source: "SETTINGS"
    });
  };

  const current = consent === undefined ? null : consent?.decision ?? null;
  const storageChoices: Array<{ id: StorageDecision; label: string }> = [{ id: "all", label: "Remember my choices" }, { id: "essential", label: "Only what the app needs" }];
  return (
    <section className="os-panel">
      <header className="os-panel-head">
        <h3 className="os-panel-title">Browser storage</h3>
        {consent !== undefined ? <span className={`os-chip ${current ? "ok" : "warn"}`}>{current === "all" ? "Choices remembered" : current === "essential" ? "Only what is needed" : "Not answered"}</span> : null}
      </header>
      <div className="os-panel-body os-stack">
        <p className="os-small os-dim">
          TRH AI sets no cookies. It can keep a few of your choices in this window&rsquo;s storage, such as the accent colour and the
          voice; the <LegalLink id="storage" /> lists every one. Nothing in it is sent anywhere.
        </p>
        <div className="os-choice" role="radiogroup" aria-label="Browser storage">
          {storageChoices.map((choice, index) => (
            <button key={choice.id} type="button" role="radio" aria-checked={current === choice.id} className={current === choice.id ? "on" : ""}
              tabIndex={radioTabIndex(storageChoices.findIndex((other) => other.id === current), index)}
              onClick={() => choose(choice.id)} onKeyDown={(event) => moveRadio(event, storageChoices.length, index, (next) => choose(storageChoices[next].id))}>
              {choice.label}
            </button>
          ))}
        </div>
        {consent ? <p className="os-faint os-small">Answered {dateOf(consent.at)}, for version {consent.version} of the text.</p>
          : consent === null ? <p className="os-faint os-small">Until you answer, choices are kept for this session only.</p> : null}
      </div>
    </section>
  );
}

function ExportSection({ signedIn }: { signedIn: boolean }) {
  const { notify } = useNotify();
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    setBusy(true);
    const result = await requestExport();
    setBusy(false);
    if (!result.ok) {
      notify({ level: "error", title: "No copy made", body: result.reason, source: "SETTINGS" });
      return;
    }
    saveTextFile(result.filename, result.text);
    notify({ level: "success", title: "Your copy is ready", body: `Saved as ${result.filename}. Open it to read it; nothing was sent anywhere.`, source: "SETTINGS" });
  };

  return (
    <section className="os-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">A copy of your data</h3></header>
      <div className="os-panel-body os-stack">
        <p className="os-small os-dim">
          One file, in plain words, with everything TRH AI holds for {signedIn ? "your account" : "this browser"}: conversations, memories,
          documents, to-dos and finished work{signedIn ? ", your account details and what you agreed to" : ""}. It is written on this PC and
          sent nowhere. The file itself lists what it leaves out, and why.
        </p>
        <div>
          <button type="button" className="os-btn os-btn-sm" disabled={busy} onClick={() => void copy()}><Icon name="archive" size={14} />{busy ? "Writing…" : "Copy my data"}</button>
        </div>
      </div>
    </section>
  );
}

function EraseSection({ summary, signedIn, onErased }: { summary: PrivacySummary | null; signedIn: boolean; onErased: () => void }) {
  const { signOut } = useAccount();
  const [scope, setScope] = useState<EraseScope>({ ownData: true, wholeCopy: false, license: false, account: false });
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [report, setReport] = useState<EraseReport | null>(null);

  const held = summary?.held ?? null;
  const wholeCopyAllowed = summary?.wholeCopyAllowed === true;
  const anything = scope.ownData || scope.wholeCopy || scope.license || scope.account;
  const ready = anything && confirm.trim() === eraseWord && (!signedIn || password.length > 0) && !busy;
  const lines = describeErasure(held, scope);

  const toggle = (key: keyof EraseScope) => setScope((prior) => ({ ...prior, [key]: !prior[key] }));

  const erase = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    const result = await requestErase({ password, confirm: confirm.trim(), scope });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    setReport(result.data);
    setConfirm("");
    setPassword("");
    onErased();
  };

  if (report) {
    return (
      <section className="os-panel">
        <header className="os-panel-head">
          <h3 className="os-panel-title">{report.complete ? "Erased" : "Partly erased"}</h3>
          <span className={`os-chip ${report.complete ? "ok" : "warn"}`}>{report.complete ? "Everything asked for" : "Something was left"}</span>
        </header>
        <div className="os-panel-body os-stack">
          <ol className="privacy-steps">
            {report.steps.map((step) => <li key={step.step} className={step.ok ? "" : "failed"}>{step.step}: {step.detail}</li>)}
          </ol>
          <p className="os-small os-dim">What is left, and why:</p>
          <ul className="privacy-kept">{report.kept.map((line) => <li key={line}>{line}</li>)}</ul>
          {report.signedOut ? (
            <>
              <p className="os-small"><Icon name="alert" size={14} /> Your account is gone, so this sign-in has ended. Sign out to finish.</p>
              <div><button type="button" className="os-btn os-btn-sm os-btn-primary" onClick={() => void signOut()}>Sign out now</button></div>
            </>
          ) : (
            <div><button type="button" className="os-btn os-btn-sm" onClick={() => setReport(null)}>Done</button></div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="os-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">Erase</h3></header>
      <form className="os-panel-body os-stack" onSubmit={(event) => void erase(event)}>
        <p className="os-small os-dim">
          Erasing removes what you choose from the files on this PC: not hidden, not marked, gone. It cannot be undone. Take a copy first
          if you want one.
        </p>
        <div>
          <label className="privacy-check">
            <input type="checkbox" checked={scope.ownData} disabled={busy} onChange={() => toggle("ownData")} />
            <span>My conversations, memories, documents, to-dos and finished work{held ? ` (${held.conversations} conversations, ${held.memories} memories, ${held.documents} documents, ${held.todos} to-dos, ${held.finishedWork} finished)` : ""}</span>
          </label>
          {wholeCopyAllowed ? (
            <label className="privacy-check">
              <input type="checkbox" checked={scope.wholeCopy} disabled={busy} onChange={() => toggle("wholeCopy")} />
              <span>This copy&rsquo;s schedules, automation flow, preferences and saved email account{held?.thisCopy ? ` (${held.thisCopy.schedules} schedules${held.thisCopy.emailAccount ? ", an email account" : ""})` : ""}</span>
            </label>
          ) : null}
          {wholeCopyAllowed && held?.thisCopy?.license ? (
            <label className="privacy-check">
              <input type="checkbox" checked={scope.license} disabled={busy} onChange={() => toggle("license")} />
              <span>The license key on this PC (it carries the email address it was bought with)</span>
            </label>
          ) : null}
          {signedIn ? (
            <label className="privacy-check">
              <input type="checkbox" checked={scope.account} disabled={busy} onChange={() => toggle("account")} />
              <span>My account: email address, name, password, recovery codes and every sign-in. You will be signed out.</span>
            </label>
          ) : null}
        </div>
        {lines.length ? (
          <p className="os-small">This will remove: {lines.join("; ")}.</p>
        ) : <p className="os-faint os-small">Choose what to erase.</p>}
        {summary && !summary.wholeCopyAllowed ? (
          <p className="os-faint os-small">Schedules, the automation flow and the email account are shared by everyone who uses this copy, so only its owner can erase them.</p>
        ) : null}
        <label className="privacy-field">
          <span>Type {eraseWord} to confirm</span>
          <input value={confirm} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => setConfirm(event.target.value)} />
        </label>
        {signedIn ? (
          <label className="privacy-field">
            <span>Your password</span>
            <input type="password" value={password} disabled={busy} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
          </label>
        ) : null}
        {problem ? <p className="os-task-alert" role="alert"><Icon name="alert" size={14} />{problem}</p> : null}
        <div>
          <button type="submit" className="os-btn os-btn-sm os-btn-danger" disabled={!ready}>{busy ? "Erasing…" : "Erase"}</button>
        </div>
        {summary ? (
          <p className="os-faint os-small">
            A short record that an erasure was asked for and done - its date, what it covered and a random number, with no name or
            email - is kept for {summary.requestRecordMonths} months.
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function PrivacyPanel() {
  const { account } = useAccount();
  const [summary, setSummary] = useState<PrivacySummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetchPrivacySummary().then((result) => {
      if (result.ok) setSummary(result.data);
      else setProblem(result.reason);
    });
  }, []);

  useEffect(() => { load(); }, [load, account?.id]);

  const signedIn = Boolean(account);
  return (
    <>
      {problem ? <p className="os-task-alert" role="alert"><Icon name="alert" size={14} />{problem}</p> : null}
      <ConsentsSection summary={summary} signedIn={signedIn} onChanged={load} />
      <StorageSection />
      <ExportSection signedIn={signedIn} />
      <EraseSection summary={summary} signedIn={signedIn} onErased={load} />
    </>
  );
}
