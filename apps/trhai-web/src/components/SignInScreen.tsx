"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { CoreGL } from "./CoreGL";
import { ParticleField } from "./ParticleField";
import type { CoreState } from "./Core";
import { apiBaseUrl } from "../lib/api";
import {
  authRequest, looksLikeEmail, minPasswordLength, passwordStrength, type AuthFailure, type StoredAuth
} from "../lib/auth";

// Signing in, for real, against the accounts the API already keeps.
//
// Four steps share one card: sign in, make an account, get back in with a
// recovery code, and - once, straight after making an account - the recovery
// codes themselves. Those codes exist in plaintext for exactly that moment;
// the server keeps only their hashes, so this screen does not let them go by
// unseen. Signing in is a choice, not a wall: "Continue without an account"
// is always there, and the app works the same way either way.

type Mode = "signin" | "register" | "recover" | "codes";
type Field = "name" | "email" | "password" | "confirm" | "code";

const exitMs = 460;

const icons: Record<string, ReactNode> = {
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l3 3" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.5" /></>,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  screen: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  brain: <><path d="M12 3a6 6 0 0 0-6 6c0 3.5 3 5 3 8h6c0-3 3-4.5 3-8a6 6 0 0 0-6-6z" /><path d="M10 21h4" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  download: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  back: <path d="M15 6l-6 6 6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />
};

function Icon({ name }: { name: keyof typeof icons }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{icons[name]}</svg>;
}

function Spinner() {
  return <span className="gate-spinner" aria-hidden="true" />;
}

export function SignInScreen({ onSignedIn, onGuest, initialMode = "signin" }: {
  onSignedIn: (auth: StoredAuth) => void;
  onGuest: () => void;
  initialMode?: "signin" | "register";
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Partial<Record<Field, string>>>({});
  const [codes, setCodes] = useState<string[]>([]);
  const [madeAccount, setMadeAccount] = useState<StoredAuth | null>(null);
  const [savedCodes, setSavedCodes] = useState(false);
  const [copied, setCopied] = useState(false);
  const [coreState, setCoreState] = useState<CoreState>("idle");
  const [leaving, setLeaving] = useState(false);
  const ids = useId();
  const firstField = useRef<HTMLInputElement>(null);

  // The cursor goes where the typing starts, each time the card changes.
  useEffect(() => {
    if (mode !== "codes") firstField.current?.focus();
  }, [mode]);

  // An error lights the core red for a moment, then it settles again.
  useEffect(() => {
    if (coreState !== "error") return;
    const timer = window.setTimeout(() => setCoreState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [coreState]);

  const strength = passwordStrength(password);

  const switchTo = (next: Mode) => {
    setMode(next);
    setProblem(null);
    setInvalid({});
    setPassword("");
    setConfirm("");
    setReveal(false);
  };

  const finish = (auth: StoredAuth) => {
    setCoreState("success");
    setLeaving(true);
    window.setTimeout(() => onSignedIn(auth), exitMs);
  };

  const fail = (failure: AuthFailure) => {
    setProblem(failure.message);
    setCoreState("error");
  };

  const checkCaps = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState?.("CapsLock") ?? false);
  };

  // A field's complaint goes the moment it is being fixed, not on the next
  // submit: a stale "enter your email" under a typed address reads as the
  // address being wrong.
  const edited = (key: Field) => {
    setInvalid((prior) => {
      if (!prior[key]) return prior;
      const next = { ...prior };
      delete next[key];
      return next;
    });
  };

  const validate = (): boolean => {
    const found: Partial<Record<Field, string>> = {};
    if (!looksLikeEmail(email)) found.email = "Enter the email address for the account.";
    if (mode === "signin" && !password) found.password = "Enter your password.";
    if (mode === "register" || mode === "recover") {
      if (!strength.meetsMinimum) found.password = `Use at least ${minPasswordLength} characters.`;
      if (confirm !== password) found.confirm = "The two passwords do not match.";
    }
    if (mode === "recover" && code.replace(/[^0-9a-z]/gi, "").length < 12) found.code = "A recovery code has 12 letters and numbers.";
    setInvalid(found);
    if (Object.keys(found).length > 0) {
      setProblem(null);
      setCoreState("error");
      return false;
    }
    return true;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !validate()) return;
    setBusy(true);
    setProblem(null);
    setCoreState("thinking");

    const result = mode === "signin"
      ? await authRequest(apiBaseUrl, "login", { email, password })
      : mode === "register"
        ? await authRequest(apiBaseUrl, "register", { email, password, displayName: name.trim() || undefined })
        : await authRequest(apiBaseUrl, "recover", { email, code, newPassword: password });

    setBusy(false);
    if (!result.ok) {
      fail(result);
      return;
    }

    const auth: StoredAuth = { token: result.token, account: result.account, expiresAt: result.expiresAt, remember };
    if (mode === "register" && result.recoveryCodes && result.recoveryCodes.length > 0) {
      // Signed in already; the codes come first, because this is the only
      // time they can be shown.
      setMadeAccount(auth);
      setCodes(result.recoveryCodes);
      setCoreState("success");
      setMode("codes");
      return;
    }
    finish(auth);
  };

  const codesText = () => [
    "TRH AI - recovery codes",
    `Account: ${madeAccount?.account.email ?? email}`,
    `Created: ${new Date().toLocaleString()}`,
    "",
    "Each code works once. Use one with your email to set a new password",
    "if you forget it. Keep these somewhere safe and private.",
    "",
    ...codes
  ].join("\r\n");

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codesText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setProblem("Copying was blocked here - use Download instead, or write them down.");
    }
  };

  const downloadCodes = () => {
    const url = URL.createObjectURL(new Blob([codesText()], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "trh-ai-recovery-codes.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const field = (
    key: Field,
    label: string,
    icon: keyof typeof icons,
    input: ReactNode,
    extra?: { aside?: ReactNode; after?: ReactNode; trailing?: ReactNode; optional?: boolean }
  ) => (
    <div className="gate-field">
      <div className="gate-field-head">
        <label className="gate-label" htmlFor={`${ids}-${key}`}>
          {label}{extra?.optional ? <span className="gate-optional">optional</span> : null}
        </label>
        {extra?.aside}
      </div>
      <div className={`gate-control${invalid[key] ? " invalid" : ""}`}>
        <Icon name={icon} />
        {input}
        {extra?.trailing}
      </div>
      {invalid[key] ? <p className="gate-field-error" id={`${ids}-${key}-error`}>{invalid[key]}</p> : extra?.after}
    </div>
  );

  const passwordInput = (key: "password" | "confirm", value: string, setValue: (next: string) => void, placeholder: string, autoComplete: string) => (
    <input
      id={`${ids}-${key}`}
      type={reveal ? "text" : "password"}
      value={value}
      placeholder={placeholder}
      autoComplete={autoComplete}
      aria-invalid={Boolean(invalid[key])}
      aria-describedby={invalid[key] ? `${ids}-${key}-error` : undefined}
      disabled={busy}
      onChange={(event) => { setValue(event.target.value); edited(key); }}
      onKeyUp={checkCaps}
      onKeyDown={checkCaps}
    />
  );

  const revealButton = (
    <button type="button" className="gate-reveal" onClick={() => setReveal((shown) => !shown)}
      aria-label={reveal ? "Hide password" : "Show password"} aria-pressed={reveal}>
      <Icon name={reveal ? "eyeOff" : "eye"} />
    </button>
  );

  const capsNote = capsLock ? <span className="gate-caps" role="status"><Icon name="alert" />Caps Lock is on</span> : null;

  const heading = {
    signin: { eyebrow: "SECURE SIGN IN", title: "Welcome back", sub: "Sign in and your memory, documents and conversations come with you." },
    register: { eyebrow: "NEW ACCOUNT", title: "Create your account", sub: "Kept on this machine and encrypted. No email is ever sent, and nothing leaves it." },
    recover: { eyebrow: "ACCOUNT RECOVERY", title: "Use a recovery code", sub: "Each code works once. Using one sets a new password and signs out everywhere else." },
    codes: { eyebrow: "SAVE THESE NOW", title: "Your recovery codes", sub: "If you forget your password, one of these gets you back in. They will not be shown again." }
  }[mode];

  return (
    <div className={`gate${leaving ? " leaving" : ""}`}>
      <ParticleField state={coreState} className="gate-particles" />

      <main className="gate-signin">
        <section className="gate-hero" aria-label="TRH AI">
          <div className="gate-core" style={{ width: 260, height: 260 }}>
            <svg className="gate-rings" viewBox="0 0 100 100" aria-hidden="true">
              <circle className="gate-ring-1" cx="50" cy="50" r="49" />
              <circle className="gate-ring-2" cx="50" cy="50" r="45" />
            </svg>
            <CoreGL state={coreState} size={260} />
            <div className="gate-core-mark" aria-hidden="true">
              <span style={{ fontSize: 24 }}>TRH</span>
              <em style={{ fontSize: 13 }}>AI</em>
            </div>
          </div>
          <p className="gate-wordmark">TRH AI</p>
          <p className="gate-tagline">LIVING INTELLIGENCE SYSTEM</p>
          <p className="gate-hero-lead">
            Your own assistant, running on your own machine. It builds apps, reads your files, remembers what
            matters, and answers from what you have told it.
          </p>
          <ul className="gate-points">
            <li><Icon name="screen" />Runs entirely on this PC - nothing leaves it</li>
            <li><Icon name="brain" />Your memory follows your account between browsers</li>
            <li><Icon name="shield" />No API keys, no subscription, no cloud account</li>
          </ul>
        </section>

        <div className="gate-card-slot">
        <section className="gate-card" aria-labelledby={`${ids}-title`}>
          <span className="gate-cut tr" aria-hidden="true" />
          <span className="gate-cut bl" aria-hidden="true" />

          {mode === "signin" || mode === "register" ? (
            <div className="gate-tabs" role="tablist" aria-label="Sign in or create an account" data-mode={mode}>
              <span className="gate-tab-glider" aria-hidden="true" />
              <button type="button" role="tab" className="gate-tab" aria-selected={mode === "signin"} disabled={busy}
                onClick={() => mode !== "signin" && switchTo("signin")}>SIGN IN</button>
              <button type="button" role="tab" className="gate-tab" aria-selected={mode === "register"} disabled={busy}
                onClick={() => mode !== "register" && switchTo("register")}>CREATE ACCOUNT</button>
            </div>
          ) : mode === "recover" ? (
            <button type="button" className="gate-back" onClick={() => switchTo("signin")} disabled={busy}>
              <Icon name="back" />Back to sign in
            </button>
          ) : null}

          <span className="gate-eyebrow"><span className="gate-dot" aria-hidden="true" />{heading.eyebrow}</span>
          <h1 className="gate-title" id={`${ids}-title`}>{heading.title}</h1>
          <p className="gate-sub">{heading.sub}</p>

          {mode === "codes" ? (
            <div className="gate-form">
              <ul className="gate-codes" aria-label="Recovery codes">
                {codes.map((value) => <li key={value}>{value}</li>)}
              </ul>
              <div className="gate-code-actions">
                <button type="button" className="gate-ghost" onClick={() => void copyCodes()}>
                  <Icon name={copied ? "check" : "copy"} />{copied ? "Copied" : "Copy all"}
                </button>
                <button type="button" className="gate-ghost" onClick={downloadCodes}>
                  <Icon name="download" />Download .txt
                </button>
              </div>
              {problem ? <div className="gate-alert" role="alert"><Icon name="alert" />{problem}</div> : null}
              <label className="gate-check">
                <input type="checkbox" checked={savedCodes} onChange={(event) => setSavedCodes(event.target.checked)} />
                I have saved these somewhere safe
              </label>
              <button type="button" className="gate-primary" disabled={!savedCodes || !madeAccount}
                onClick={() => madeAccount && finish(madeAccount)}>
                ENTER TRH AI <Icon name="arrow" />
              </button>
            </div>
          ) : (
            <form className="gate-form" onSubmit={(event) => void submit(event)} noValidate>
              {mode === "register" ? field("name", "Name", "user",
                <input
                  ref={firstField}
                  id={`${ids}-name`}
                  type="text"
                  value={name}
                  placeholder="What should TRH AI call you?"
                  autoComplete="name"
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />, { optional: true }) : null}

              {field("email", "Email", "mail",
                <input
                  ref={mode === "register" ? undefined : firstField}
                  id={`${ids}-email`}
                  type="email"
                  value={email}
                  placeholder="you@example.com"
                  autoComplete={mode === "register" ? "email" : "username"}
                  aria-invalid={Boolean(invalid.email)}
                  aria-describedby={invalid.email ? `${ids}-email-error` : undefined}
                  disabled={busy}
                  onChange={(event) => { setEmail(event.target.value); edited("email"); }}
                />)}

              {mode === "recover" ? field("code", "Recovery code", "key",
                <input
                  id={`${ids}-code`}
                  className="mono"
                  type="text"
                  value={code}
                  placeholder="XXXX-XXXX-XXXX"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  aria-invalid={Boolean(invalid.code)}
                  aria-describedby={invalid.code ? `${ids}-code-error` : undefined}
                  disabled={busy}
                  onChange={(event) => { setCode(event.target.value); edited("code"); }}
                />) : null}

              {field("password", mode === "signin" ? "Password" : "New password", "lock",
                passwordInput("password", password, setPassword, mode === "signin" ? "Your password" : `At least ${minPasswordLength} characters`,
                  mode === "signin" ? "current-password" : "new-password"),
                {
                  trailing: revealButton,
                  aside: mode === "signin"
                    ? <button type="button" className="gate-link" onClick={() => switchTo("recover")} disabled={busy}>Forgot it? Use a recovery code</button>
                    : capsNote,
                  after: mode === "signin"
                    ? capsNote
                    : (
                      <>
                        <div className="gate-meter" data-score={strength.score} aria-hidden="true"><span /><span /><span /><span /></div>
                        <div className="gate-meter-label">
                          <span>{password ? strength.label : `At least ${minPasswordLength} characters`}</span>
                          <span>{password.length > 0 ? `${password.length} chars` : ""}</span>
                        </div>
                      </>
                    )
                })}

              {mode !== "signin" ? field("confirm", "Confirm password", "lock",
                passwordInput("confirm", confirm, setConfirm, "Type it again", "new-password")) : null}

              <div className="gate-row">
                <label className="gate-check">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />
                  Keep me signed in
                </label>
              </div>

              {problem ? <div className="gate-alert" role="alert"><Icon name="alert" />{problem}</div> : null}

              <button type="submit" className="gate-primary" disabled={busy}>
                {busy ? <Spinner /> : null}
                {busy
                  ? (mode === "signin" ? "SIGNING IN" : mode === "register" ? "CREATING" : "RESETTING")
                  : (mode === "signin" ? "SIGN IN" : mode === "register" ? "CREATE ACCOUNT" : "SET NEW PASSWORD")}
                {busy ? null : <Icon name="arrow" />}
              </button>

              <div className="gate-divider" aria-hidden="true">OR</div>
              <button type="button" className="gate-ghost" onClick={() => { setLeaving(true); window.setTimeout(onGuest, exitMs); }} disabled={busy}>
                Continue without an account
              </button>
              <p className="gate-ghost-note">Everything works the same; your memory just stays in this browser.</p>
            </form>
          )}

          <div className="gate-fine"><Icon name="lock" />Stored encrypted on this machine · Nothing leaves it</div>
        </section>
        </div>
      </main>
    </div>
  );
}
