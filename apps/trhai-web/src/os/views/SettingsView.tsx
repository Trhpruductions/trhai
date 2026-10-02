"use client";

import { useEffect, useState } from "react";
import { defaultPersonality, type PersonalityId } from "@ascend/shared";
import { AccountPanel } from "../../components/AccountPanel";
import { MessagingPanel } from "../../components/MessagingPanel";
import { VoicePicker } from "../../components/VoicePicker";
import { PersonalityPicker } from "../../components/PersonalityPicker";
import { AgentPicker } from "../../components/AgentPicker";
import { useAccount } from "../../components/AppGate";
import { readStoredPersonality, writeStoredPersonality } from "../../lib/personality";
import {
  defaultAccent, defaultBackdrop, readStoredAccent, readStoredBackdrop, writeStoredAccent, writeStoredBackdrop,
  type Accent, type BackdropMode
} from "../../lib/theme";
import { chooseAgent } from "../../lib/agents";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState, useVoice } from "../state/assistant";
import "./views.css";

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
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={mode === option.id}
              className={mode === option.id ? "on" : ""}
              onClick={() => {
                setMode(option.id);
                writeStoredBackdrop(window.localStorage, option.id);
                document.documentElement.setAttribute("data-backdrop", option.id);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="os-faint os-small">{current.detail}</p>
      </div>
    </section>
  );
}

export function SettingsView() {
  const account = useAccount();
  const { speech } = useVoice();
  const { agent, setAgent } = useAssistantState();
  const [personalityId, setPersonalityId] = useState<PersonalityId>(defaultPersonality);
  const [accent, setAccent] = useState<Accent>(defaultAccent);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stored preferences, unknowable on the server
    setPersonalityId(readStoredPersonality(window.localStorage));
    setAccent(readStoredAccent(window.localStorage));
  }, []);

  return (
    <ViewFrame id="settings">
      <div className="os-settings">
        <AccountPanel account={account.account} onSignOut={() => void account.signOut()} onSignIn={account.openSignIn} />
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
        <BackgroundPanel />
        <AgentPicker active={agent} onChange={(id) => setAgent(chooseAgent(window.localStorage, id))} />
        <VoicePicker
          choice={speech.voice}
          voices={speech.installedVoices}
          speaking={speech.speaking || speech.preparing}
          onChange={speech.setVoice}
          onPreview={(line) => speech.speak(line)}
        />
        <MessagingPanel />
      </div>
    </ViewFrame>
  );
}
