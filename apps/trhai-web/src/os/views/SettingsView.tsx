"use client";

import { useEffect, useState } from "react";
import { defaultPersonality, type PersonalityId } from "@ascend/shared";
import { AccountPanel } from "../../components/AccountPanel";
import { MessagingPanel } from "../../components/MessagingPanel";
import { VoicePicker } from "../../components/VoicePicker";
import { PersonalityPicker } from "../../components/PersonalityPicker";
import { AgentPicker } from "../../components/AgentPicker";
import { useAccount } from "../../components/AppGate";
import { apiGet } from "../../lib/api";
import { formatBytes } from "../../lib/files";
import { readStoredPersonality, writeStoredPersonality } from "../../lib/personality";
import { filterSections, isSectionId, sections, type SectionId } from "../../lib/settings";
import {
  defaultAccent, defaultBackdrop, readStoredAccent, readStoredBackdrop, writeStoredAccent, writeStoredBackdrop,
  type Accent, type BackdropMode
} from "../../lib/theme";
import { chooseAgent } from "../../lib/agents";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState, useVoice } from "../state/assistant";
import { useNav } from "../state/nav";
import { useNotify } from "../state/notify";
import { useSystem } from "../state/system";
import { detailFromHash } from "../views";
import "./views.css";

// Settings as an app: the sections down the side, one open beside them, its
// place in the address (#settings/voice) so a link or the command palette can
// open it. Everything that was here stays; Notifications, Data and privacy,
// and About are new, and every one of their facts is read from where it is
// true - the browser's own permission, the files on disk, the build itself.

const backgrounds: Array<{ id: BackdropMode; label: string; detail: string }> = [
  { id: "living", label: "Living scene", detail: "The key art, with stars, light and the pedestal following what TRH AI is doing." },
  { id: "still", label: "Still scene", detail: "The key art with nothing moving over it." },
  { id: "plain", label: "Plain", detail: "A quiet dark field. Lightest on a slower machine." }
];

/** Settings > Appearance: what stands behind the whole shell. */
function BackgroundPanel() {
  const [mode, setMode] = useState<BackdropMode>(defaultBackdrop);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a stored preference, unknowable on the server
    setMode(readStoredBackdrop(window.localStorage));
  }, []);
  const current = backgrounds.find((option) => option.id === mode) ?? backgrounds[0];
  return (
    <section className="os-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">Background</h3></header>
      <div className="os-panel-body os-stack">
        <div className="os-choice" role="radiogroup" aria-label="Background">
          {backgrounds.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={mode === option.id} className={mode === option.id ? "on" : ""}
              onClick={() => {
                setMode(option.id);
                writeStoredBackdrop(window.localStorage, option.id);
                document.documentElement.setAttribute("data-backdrop", option.id);
              }}>
              {option.label}
            </button>
          ))}
        </div>
        <p className="os-faint os-small">{current.detail}</p>
      </div>
    </section>
  );
}

/** Settings > Notifications: the browser's own permission, as it stands. */
function NotificationsPanel() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported" | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's permission, unknowable on the server
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);
  const ask = async () => setPermission(await Notification.requestPermission());
  return (
    <section className="os-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">Desktop notifications</h3>
        {permission && permission !== "unsupported" ? <span className={`os-chip ${permission === "granted" ? "ok" : permission === "denied" ? "warn" : ""}`}>{permission === "granted" ? "On" : permission === "denied" ? "Blocked" : "Not asked yet"}</span> : null}
      </header>
      <div className="os-panel-body os-stack">
        <p className="os-small os-dim">Reminders, and the result of every scheduled run, show inside TRH AI either way. With this on they also reach the desktop, so you see them while TRH AI is in the background.</p>
        {permission === "default" ? <button type="button" className="os-btn os-btn-sm os-btn-primary" onClick={() => void ask()}><Icon name="bell" size={14} />Allow desktop notifications</button> : null}
        {permission === "denied" ? <p className="os-faint os-small">Blocked for this page. Allow notifications for it in the browser&rsquo;s site settings, then come back.</p> : null}
        {permission === "unsupported" ? <p className="os-faint os-small">This browser cannot show desktop notifications.</p> : null}
      </div>
    </section>
  );
}

type DataInventory = {
  directory: string; keyFile: string; workspace: string;
  files: Array<{ name: string; about: string; bytes: number; modifiedAt: number; encrypted: boolean }>;
};

/** Settings > Data and privacy: every store on disk, and whether it is really encrypted. */
function DataPanel() {
  const { notify } = useNotify();
  const { go } = useNav();
  const [inventory, setInventory] = useState<DataInventory | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void apiGet<DataInventory>("/v1/system/data").then((result) => {
      if (result.ok) setInventory(result.data);
      else setProblem(result.reason);
    });
  }, []);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ level: "success", title: "Copied", body: value, source: "SETTINGS" });
    } catch {
      notify({ level: "error", title: "Could not copy", body: "The clipboard is not available here.", source: "SETTINGS" });
    }
  };
  const plain = inventory?.files.filter((file) => !file.encrypted) ?? [];
  return (
    <>
      <section className="os-panel">
        <header className="os-panel-head"><h3 className="os-panel-title">Where it is kept</h3></header>
        <div className="os-panel-body os-stack">
          <p className="os-small os-dim">Everything TRH AI keeps is on this PC. Replies are written here, by the model here; nothing is kept anywhere else.</p>
          {problem ? <p className="os-task-alert"><Icon name="alert" size={14} />{problem}</p> : null}
          {inventory ? (
            <dl className="os-kv os-data-paths">
              {[["Your data", inventory.directory], ["The key that encrypts it", inventory.keyFile], ["The workspace", inventory.workspace]].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd><span className="os-mono">{value}</span>
                    <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Copy ${label}`} onClick={() => void copy(value)}><Icon name="copy" size={13} /></button>
                  </dd>
                </div>
              ))}
            </dl>
          ) : !problem ? <p className="os-faint">Reading…</p> : null}
        </div>
      </section>
      <section className="os-panel">
        <header className="os-panel-head">
          <h3 className="os-panel-title">What is stored</h3>
          {inventory ? <span className={`os-chip ${plain.length ? "warn" : "ok"}`}>{plain.length ? `${plain.length} not encrypted` : "All encrypted"}</span> : null}
        </header>
        <div className="os-panel-body os-stack">
          {inventory ? (
            <ul className="os-data-files">
              {inventory.files.map((file) => (
                <li key={file.name}>
                  <div className="os-data-file-text">
                    <strong>{file.about}</strong>
                    <span className="os-faint os-small"><span className="os-mono">{file.name}</span> · {formatBytes(file.bytes)} · changed {new Date(file.modifiedAt).toLocaleDateString()}</span>
                  </div>
                  <span className={`os-chip ${file.encrypted ? "ok" : "warn"}`}>{file.encrypted ? "Encrypted" : "Not encrypted"}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="os-faint os-small">Read from each file&rsquo;s own first bytes, not assumed. Encrypted files use AES-256-GCM with the key above; anyone with this PC&rsquo;s login can read that key, so it guards against a copied folder, not against someone at the keyboard.</p>
          <div className="os-data-links">
            <button type="button" className="os-btn os-btn-sm" onClick={() => go("memory")}><Icon name="pin" size={13} />Memories</button>
            <button type="button" className="os-btn os-btn-sm" onClick={() => go("chat")}><Icon name="message" size={13} />Conversations</button>
            <button type="button" className="os-btn os-btn-sm" onClick={() => go("tasks")}><Icon name="check" size={13} />Finished work</button>
          </div>
        </div>
      </section>
    </>
  );
}

type BuildInfo = {
  apiVersion: string; webVersion: string; desktopVersion: string; environment: string;
  gitCommitShort: string | null; gitBranch: string | null; gitCommitDate: string | null; gitDirty: boolean | null; serverStartedAt: string;
};

/** Settings > About: the build, from the build itself. */
function AboutPanel() {
  const { modelName } = useSystem();
  const [build, setBuild] = useState<BuildInfo | null>(null);
  useEffect(() => {
    void apiGet<BuildInfo>("/v1/build-info").then((result) => { if (result.ok) setBuild(result.data); });
  }, []);
  return (
    <section className="os-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">About TRH AI</h3></header>
      <div className="os-panel-body">
        {!build ? <p className="os-faint">Reading…</p> : (
          <dl className="os-kv">
            <div><dt>Service</dt><dd className="os-mono">v{build.apiVersion}</dd></div>
            <div><dt>Interface</dt><dd className="os-mono">v{build.webVersion}</dd></div>
            <div><dt>Desktop app</dt><dd className="os-mono">v{build.desktopVersion}</dd></div>
            <div><dt>Build</dt><dd className="os-mono">{build.gitCommitShort ?? "—"}{build.gitBranch ? ` on ${build.gitBranch}` : ""}{build.gitDirty ? " · with changes not yet committed" : ""}</dd></div>
            {build.gitCommitDate ? <div><dt>Built from a commit of</dt><dd className="os-mono">{new Date(build.gitCommitDate).toLocaleString()}</dd></div> : null}
            <div><dt>Running as</dt><dd className="os-mono">{build.environment}</dd></div>
            <div><dt>Service started</dt><dd className="os-mono">{new Date(build.serverStartedAt).toLocaleString()}</dd></div>
            <div><dt>Model</dt><dd className="os-mono">{modelName ?? "none answering"}</dd></div>
          </dl>
        )}
      </div>
    </section>
  );
}

export function SettingsView() {
  const account = useAccount();
  const { speech } = useVoice();
  const { agent, setAgent } = useAssistantState();
  const { go } = useNav();
  const [personalityId, setPersonalityId] = useState<PersonalityId>(defaultPersonality);
  const [accent, setAccent] = useState<Accent>(defaultAccent);
  const [section, setSection] = useState<SectionId>("account");
  const [query, setQuery] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stored preferences, unknowable on the server
    setPersonalityId(readStoredPersonality(window.localStorage));
    setAccent(readStoredAccent(window.localStorage));
  }, []);

  // The open section is whatever the address says.
  useEffect(() => {
    const read = () => {
      const detail = detailFromHash(window.location.hash);
      setSection(isSectionId(detail) ? detail : "account");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const shown = filterSections(query);
  const open = (id: SectionId) => go("settings", id === "account" ? null : id);
  const current = sections.find((entry) => entry.id === section) ?? sections[0];

  return (
    <ViewFrame id="settings">
      <div className="os-settings-app">
        <nav className="os-panel os-settings-nav" aria-label="Settings sections">
          <label className="os-convos-search">
            <Icon name="search" size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
              placeholder="Search settings" aria-label="Search settings" />
          </label>
          <ul>
            {shown.map((entry) => (
              <li key={entry.id}>
                <button type="button" className={entry.id === section ? "on" : ""} aria-current={entry.id === section ? "page" : undefined} onClick={() => open(entry.id)}>
                  <strong>{entry.label}</strong>
                  <span>{entry.summary}</span>
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 ? <p className="os-faint os-small os-settings-none">No setting matches &ldquo;{query}&rdquo;.</p> : null}
        </nav>

        <div className="os-settings-body" aria-label={current.label}>
          <h3 className="os-settings-heading">{current.label}</h3>
          {section === "account" ? <AccountPanel account={account.account} onSignOut={() => void account.signOut()} onSignIn={account.openSignIn} /> : null}
          {section === "assistant" ? (
            <>
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
                }}
              />
              <AgentPicker active={agent} onChange={(id) => setAgent(chooseAgent(window.localStorage, id))} />
              <p className="os-faint os-small">Each conversation can use its own model - pick it in Chat, beside the conversation.</p>
            </>
          ) : null}
          {section === "voice" ? (
            <VoicePicker choice={speech.voice} voices={speech.installedVoices} speaking={speech.speaking || speech.preparing}
              onChange={speech.setVoice} onPreview={(line) => speech.speak(line)} />
          ) : null}
          {section === "appearance" ? <BackgroundPanel /> : null}
          {section === "messaging" ? <MessagingPanel /> : null}
          {section === "notifications" ? <NotificationsPanel /> : null}
          {section === "data" ? <DataPanel /> : null}
          {section === "about" ? <AboutPanel /> : null}
        </div>
      </div>
    </ViewFrame>
  );
}
