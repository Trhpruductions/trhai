"use client";

import { VoicePicker } from "../../components/VoicePicker";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState, useLevels, useVoice } from "../state/assistant";
import { useSystem } from "../state/system";
import "./views.css";

// Talking to TRH AI. Everything here is the real voice pipeline: the
// microphone's own level, local transcription (whisper.cpp), local speech
// (Piper or the browser's voice), and the hands-free loop that decides where
// a sentence ends.

function VoiceOrb() {
  const { level } = useLevels();
  const { mic, speech } = useVoice();
  const scale = 1 + Math.min(1, level) * 0.22;
  return (
    <div className={`os-voice-orb${mic.listening ? " listening" : ""}${speech.speaking ? " speaking" : ""}`} aria-hidden="true">
      <span className="os-voice-orb-glow" style={{ transform: `scale(${scale.toFixed(3)})` }} />
      <span className="os-voice-orb-core" />
      <div className="os-voice-bars">
        {Array.from({ length: 48 }, (_, index) => {
          const angle = (index / 48) * 360;
          const profile = 0.35 + 0.65 * Math.abs(Math.sin((index / 48) * Math.PI * 5));
          const length = 8 + Math.min(1, level) * profile * 34;
          return <span key={index} style={{ transform: `rotate(${angle}deg) translateY(-118px)`, height: `${length.toFixed(1)}px` }} />;
        })}
      </div>
    </div>
  );
}

function InputMeter() {
  const { micAmplitude } = useLevels();
  const { mic } = useVoice();
  const value = mic.listening ? Math.min(1, micAmplitude * 2.2) : 0;
  return (
    <div className="os-reading">
      <div className="os-reading-head"><span className="os-label">Input level</span><span className="os-mono os-reading-value">{mic.listening ? `${Math.round(value * 100)}%` : "—"}</span></div>
      <div className="os-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label="Microphone input level">
        <span style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}

export function VoiceView() {
  const { mic, speech, toggleMic, handsFree, setHandsFree } = useVoice();
  const { draft, lastAsked, lastReply, busy, status } = useAssistantState();
  const { stt } = useSystem();

  const state = mic.transcribing ? "Processing" : mic.listening ? "Listening" : speech.speaking ? "Speaking" : busy ? "Thinking" : "Mic ready";
  const recognitionReady = mic.supported && mic.transcriptionAvailable !== false;

  return (
    <ViewFrame
      id="voice"
      actions={(
        <>
          <button type="button" className={`os-btn${handsFree ? " on" : ""}`} disabled={!recognitionReady} onClick={() => setHandsFree(!handsFree)} aria-pressed={handsFree}>
            <Icon name="wave" size={16} />Hands-free {handsFree ? "on" : "off"}
          </button>
          <button type="button" className={`os-btn${speech.enabled ? " on" : ""}`} disabled={speech.engine === "none"} onClick={() => speech.setEnabled(!speech.enabled)} aria-pressed={speech.enabled}>
            <Icon name={speech.enabled ? "speaker" : "speakerOff"} size={16} />Read replies aloud
          </button>
        </>
      )}
    >
      <div className="os-voice-layout">
        <section className="os-panel os-voice-console" aria-label="Voice console">
          <VoiceOrb />
          <div className="os-voice-state">
            <span className="os-label">Voice state</span>
            <strong className={`os-voice-word ${state.toLowerCase().replace(" ", "-")}`}>{state}</strong>
            <p className="os-dim">
              {!mic.supported ? "This browser exposes no microphone."
                : mic.error ? mic.error
                  : handsFree ? "Hands-free is on: just talk. TRH AI sends each sentence when you pause, and never listens while it speaks."
                    : mic.listening ? "Speak, then press the button again - or pause - to send."
                      : "Press the button and speak. Your voice is transcribed on this PC and never uploaded."}
            </p>
          </div>
          <button
            type="button"
            className={`os-voice-button${mic.listening ? " live" : ""}`}
            disabled={!mic.supported || mic.transcribing}
            onClick={() => void toggleMic()}
            aria-pressed={mic.listening}
          >
            <Icon name={mic.listening ? "stop" : "mic"} size={26} />
            <span>{mic.transcribing ? "Transcribing…" : mic.listening ? "Stop and send" : "Start speaking"}</span>
          </button>
          <span className="os-faint os-small">Shortcut: <kbd className="os-kbd">Alt</kbd>+<kbd className="os-kbd">M</kbd></span>
        </section>

        <div className="os-voice-side">
          <section className="os-panel">
            <header className="os-panel-head"><h3 className="os-panel-title">Pipeline</h3></header>
            <div className="os-panel-body os-readings">
              <InputMeter />
              <ul className="os-health-rows">
                <li><span className={`os-dot ${recognitionReady ? "ok" : "warn"}`} aria-hidden="true" /><span>Recognition</span>
                  <span className="os-faint os-mono">{stt?.available ? `whisper ${stt.model ?? ""}`.trim() : stt?.reason ? "not installed" : "checking"}</span></li>
                <li><span className={`os-dot ${speech.engine !== "none" ? "ok" : "warn"}`} aria-hidden="true" /><span>Voice output</span>
                  <span className="os-faint os-mono">{speech.engine === "neural" ? "Piper (neural)" : speech.engine === "browser" ? "browser voice" : "none"}</span></li>
                <li><span className={`os-dot ${mic.listening ? "accent live" : ""}`} aria-hidden="true" /><span>Microphone</span>
                  <span className="os-faint os-mono">{mic.listening ? "open" : "closed"}</span></li>
              </ul>
              {mic.transcriptionReason && mic.transcriptionAvailable === false ? <p className="os-faint os-small">{mic.transcriptionReason}</p> : null}
            </div>
          </section>

          <section className="os-panel">
            <header className="os-panel-head"><h3 className="os-panel-title">Current command</h3></header>
            <div className="os-panel-body os-voice-turn">
              <p className={draft || lastAsked ? "" : "os-faint"}>{draft || lastAsked?.text || "Nothing said yet."}</p>
              <span className="os-label">AI response</span>
              <p className="os-dim">
                {busy ? (status.state === "executing" ? `Running ${status.tool.replace(/_/g, " ")}…` : "Thinking…")
                  : speech.speaking ? "Speaking the reply…"
                    : lastReply ? lastReply.text.replace(/[*_`#>]/g, "").slice(0, 280) : "No reply yet."}
              </p>
            </div>
          </section>

          <VoicePicker
            choice={speech.voice}
            voices={speech.installedVoices}
            speaking={speech.speaking || speech.preparing}
            onChange={speech.setVoice}
            onPreview={(line) => speech.speak(line)}
          />
        </div>
      </div>
    </ViewFrame>
  );
}
