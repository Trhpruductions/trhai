"use client";

import { allPersonalities, type PersonalityId } from "@ascend/shared";
import { accents, type Accent } from "../lib/theme";
import "./personality.css";

// Choosing how TRHAI answers.
//
// This was on the settings surface, and when the surfaces went it went with
// them - leaving a stored value that took full effect and nothing anywhere to
// change it. That mattered more than an ordinary missing preference: three of
// these personalities declare a mandatory disclaimer that is appended to every
// reply they produce, so "no way to choose" meant no way to get the disclaimer
// on medical, legal or security questions.
//
// It lives in the console rail rather than the stage. The main screen is the
// core, the box and the microphone; this is a setting, and settings belong
// behind the handle with the rest of the instruments.

export function PersonalityPicker({ active, onChange, accent, onAccentChange }: {
  active: PersonalityId;
  onChange: (id: PersonalityId) => void;
  accent: Accent;
  onAccentChange: (accent: Accent) => void;
}) {
  const personalities = allPersonalities();
  const current = personalities.find((entry) => entry.id === active) ?? personalities[0];

  return (
    <section className="hud-panel persona-pick">
      <span className="hud-label">Personality</span>

      <select
        className="persona-select"
        value={current.id}
        aria-label="How TRHAI answers"
        onChange={(event) => onChange(event.target.value as PersonalityId)}
      >
        {personalities.map((entry) => (
          <option key={entry.id} value={entry.id}>{entry.label}</option>
        ))}
      </select>

      {/* The personality's own summary, not a description written here, so this
          cannot drift from what the personality actually does. */}
      <p className="persona-summary">{current.summary}</p>

      {/* Shown only when the chosen personality genuinely declares one. It is
          the real string that gets appended, not a paraphrase of it. */}
      {current.responseStyle.mandatoryDisclaimer ? (
        <p className="persona-disclaimer">
          <span className="persona-disclaimer-label">Every reply carries:</span>
          {current.responseStyle.mandatoryDisclaimer}
        </p>
      ) : null}

      {/* The accent, stranded the same way and for the same reason.
          globals.css has carried three alternates besides the default since
          they were written, and the boot script in <head> reads the stored
          value on every load - but the control that wrote it was on the
          settings surface, so the script was reading a key nothing could set.

          A fixed list rather than a colour picker: an arbitrary hex cannot be
          checked for contrast against these near-black surfaces. */}
      <div className="accent-row" role="group" aria-label="Accent colour">
        {accents.map((option) => (
          <button
            key={option}
            type="button"
            className={`accent-dot accent-${option}${option === accent ? " on" : ""}`}
            aria-pressed={option === accent}
            title={option}
            onClick={() => onAccentChange(option)}
          >
            <span className="sr-only">{option}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
