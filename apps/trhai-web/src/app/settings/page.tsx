"use client";

import { useEffect, useState } from "react";
import { useSpeech } from "../../hooks/useSpeech";
import { accents, readStoredAccent, writeStoredAccent, type Accent } from "../../lib/theme";
import { readStoredPersonality, writeStoredPersonality } from "../../lib/personality";
import { allPersonalities, type PersonalityId } from "@ascend/shared";
import "./settings.css";

const accentLabel: Record<Accent, string> = {
  cyan: "Cyan",
  violet: "Violet",
  emerald: "Emerald",
  amber: "Amber"
};

function VoiceSettings() {
  const speech = useSpeech();

  if (speech.engine === "none") {
    return (
      <div className="panel settings-card">
        <span className="hud-label">Voice</span>
        <p className="muted">
          {speech.neural && !speech.neural.available ? speech.neural.reason : "No voice is available on this machine."}
        </p>
      </div>
    );
  }

  return (
    <div className="panel settings-card">
      <div className="settings-row">
        <span className="hud-label">Voice</span>
        <button type="button" className={`btn btn-sm${speech.enabled ? " btn-on" : ""}`}
          onClick={() => speech.setEnabled(!speech.enabled)}>
          {speech.enabled ? "On" : "Off"}
        </button>
      </div>
      <p className="muted settings-desc">
        Replies are read aloud on this machine. Nothing is uploaded, and no account is involved.
      </p>
      <div className="settings-row">
        {speech.engine === "neural" ? (
          <span className="chip chip-live">Neural · {speech.neural?.available ? speech.neural.voice : ""}</span>
        ) : (
          <span className="chip">Browser voice</span>
        )}
        {speech.preparing ? <span className="chip chip-warn">Generating…</span> : null}
      </div>
      <div className="settings-row">
        <button type="button" className="btn btn-sm" disabled={speech.preparing}
          onClick={() => speech.speaking ? speech.stop() : speech.speak("This is how I will sound.")}>
          {speech.speaking ? "Stop" : speech.preparing ? "Generating…" : "Hear it"}
        </button>
      </div>
      {speech.error ? <p className="faint settings-note">{speech.error}</p> : null}
    </div>
  );
}

function PersonalitySettings() {
  const [personality, setPersonality] = useState<PersonalityId>("professional");

  useEffect(() => {
    setPersonality(readStoredPersonality(window.localStorage));
  }, []);

  function choose(id: PersonalityId) {
    setPersonality(id);
    writeStoredPersonality(window.localStorage, id);
  }

  return (
    <div className="panel settings-card">
      <span className="hud-label">Personality</span>
      <p className="muted settings-desc">
        Changes what the dashboard suggests and how replies read. It never changes what TRHAI
        is allowed to do.
      </p>
      <div className="settings-personality-list">
        {allPersonalities().map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`btn btn-sm${personality === entry.id ? " btn-on" : ""}`}
            aria-pressed={personality === entry.id}
            title={entry.summary}
            onClick={() => choose(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemeSettings() {
  const [accent, setAccent] = useState<Accent>("cyan");

  useEffect(() => {
    setAccent(readStoredAccent(window.localStorage));
  }, []);

  function choose(next: Accent) {
    setAccent(next);
    document.documentElement.setAttribute("data-accent", next);
    writeStoredAccent(window.localStorage, next);
  }

  return (
    <div className="panel settings-card">
      <span className="hud-label">Accent</span>
      <p className="muted settings-desc">Which signal colour the HUD uses. Applies everywhere, immediately.</p>
      <div className="settings-swatches">
        {accents.map((option) => (
          <button
            key={option}
            type="button"
            className={`swatch swatch-${option}${accent === option ? " active" : ""}`}
            aria-pressed={accent === option}
            onClick={() => choose(option)}
            title={accentLabel[option]}
          >
            {accent === option ? "✓" : ""}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="settings">
      <header className="settings-head">
        <h1>Settings</h1>
        <p className="muted">Voice, theme and personality are real today. Memory and tool permissions arrive in later phases.</p>
      </header>

      <VoiceSettings />
      <PersonalitySettings />
      <ThemeSettings />
    </div>
  );
}
