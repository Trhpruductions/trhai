"use client";

import { clampRate, type VoiceChoice } from "../lib/voicePreference";
import "./voicepicker.css";

// Choosing how TRHAI sounds, by listening to it.
//
// The voice was a constant in the code, picked by reasoning about accents. That
// is the wrong way to settle a voice: it is either right in your ears or it is
// not, and the only way to know is to hear it say something. So every installed
// voice is listed with a button that speaks a line in it, and the speed is a
// slider rather than a number somebody chose.
//
// The line previewed is deliberately a sentence TRHAI would really say, not
// "the quick brown fox". A voice can sound fine reading a pangram and wrong
// reading a status report.

const previewLine = "All systems are online. Your workspace is ready when you are.";

/** Cadence, in the words of what it does rather than its internal name. */
const cadenceLabels: Record<VoiceChoice["cadence"], string> = {
  measured: "Calm and even",
  deliberate: "Slow and composed",
  brisk: "Quick and light",
  playful: "Lively"
};

export function VoicePicker({ choice, voices, onChange, onPreview, speaking }: {
  choice: VoiceChoice;
  voices: Array<{ id: string; name: string; locale: string; quality: string }>;
  onChange: (next: VoiceChoice) => void;
  onPreview: (line: string) => void;
  speaking: boolean;
}) {
  return (
    <section className="hud-panel voicepick">
      <span className="hud-label">Voice</span>

      {voices.length === 0 ? (
        <p className="faint voicepick-none">
          No neural voices are installed, so replies use the browser&apos;s own voice.
        </p>
      ) : (
        <>
          <select
            className="voicepick-select"
            value={choice.voiceId}
            aria-label="Which voice TRHAI speaks in"
            onChange={(event) => onChange({ ...choice, voiceId: event.target.value })}
          >
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} · {voice.locale.replace("_", "-")} · {voice.quality}
              </option>
            ))}
          </select>

          <label className="voicepick-rate">
            <span className="voicepick-rate-label">
              Speed
              {/* The number is shown because a slider with no reading is a
                  control you cannot return to a setting you liked. */}
              <span className="voicepick-rate-value">{choice.rate.toFixed(2)}×</span>
            </span>
            <input
              type="range"
              min="0.7"
              max="1.4"
              step="0.01"
              value={choice.rate}
              onChange={(event) => onChange({ ...choice, rate: clampRate(Number(event.target.value)) })}
            />
          </label>

          <select
            className="voicepick-select"
            value={choice.cadence}
            aria-label="Delivery"
            onChange={(event) => onChange({ ...choice, cadence: event.target.value as VoiceChoice["cadence"] })}
          >
            {(Object.keys(cadenceLabels) as Array<VoiceChoice["cadence"]>).map((cadence) => (
              <option key={cadence} value={cadence}>{cadenceLabels[cadence]}</option>
            ))}
          </select>

          <button
            type="button"
            className="voicepick-preview"
            onClick={() => onPreview(previewLine)}
            disabled={speaking}
          >
            {speaking ? "Speaking…" : "► Hear it"}
          </button>
        </>
      )}
    </section>
  );
}
