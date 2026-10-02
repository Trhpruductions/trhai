"use client";

import { useCallback, useRef, useState } from "react";
import { CoreGL } from "../../components/CoreGL";
import { Markdown } from "../../components/Markdown";
import { activeStage, stages } from "../../components/corePresence";
import { useElementWidth } from "../../hooks/useElementWidth";
import { Icon } from "../ui/Icon";
import { coreWords } from "../core/coreWords";
import { useAssistantState, useLevels, useVoice } from "../state/assistant";
import { useSystem } from "../state/system";
import { useNav } from "../state/nav";
import { useBackdropAnchor } from "../shell/Backdrop";

// The center of the command center: the core, what it is doing in words, and
// the latest exchange. The core's state, the words and the stage rail all come
// from the same real state (corePresence); none of them is decoration.

function CoreCanvas({ size }: { size: number }) {
  const { core } = useAssistantState();
  const { micAmplitude, speechAmplitude } = useLevels();
  const { mic, speech } = useVoice();
  const { telemetry } = useSystem();
  const load = telemetry ? Math.max(telemetry.cpu.fraction ?? 0, telemetry.gpu.fraction ?? 0) : undefined;
  return (
    <CoreGL
      state={core}
      size={size}
      amplitude={mic.listening ? micAmplitude : speech.speaking ? speechAmplitude : undefined}
      load={load}
    />
  );
}

export function Stage() {
  const assistant = useAssistantState();
  const { core, status, busy, messages, lastAsked, lastReply, replyFromThisRun, dismissedReplyId, dismissReply, send } = assistant;
  const { online, modelName, rendering, renderingDismissed, dismissRendering } = useSystem();
  const { mic, speech } = useVoice();
  const { go } = useNav();
  const box = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(box);
  const [copied, setCopied] = useState(false);
  // The backdrop puts the key art's own globe exactly under this one.
  const setAnchor = useBackdropAnchor();
  const coreRef = useCallback((element: HTMLDivElement | null) => {
    box.current = element;
    setAnchor(element);
  }, [setAnchor]);

  const words = coreWords(core);
  const stageNow = activeStage(core, messages.length > 0);
  const detail = online === false
    ? "The local API is not answering. Everything resumes when it is back."
    : status.state === "executing" ? `Running ${status.tool.replace(/_/g, " ")}${status.stage ? ` · ${status.stage}` : ""}`
      : status.state === "thinking" ? (status.stage ?? "Working out the answer")
        : status.state === "error" ? status.detail
          : mic.transcribing ? "Transcribing what you said, on this PC"
            : mic.listening ? "Listening - speak your request"
              : speech.speaking ? "Speaking the reply"
                : modelName ? `${modelName} ready - ask anything below` : "No local model is loaded";

  const showReply = (busy || (replyFromThisRun && lastReply?.id !== dismissedReplyId)) && (lastReply || lastAsked);
  const confirming = !busy && replyFromThisRun && lastReply?.pendingConfirmation;
  const sendingMessage = confirming && (lastReply?.pendingConfirmation?.tool === "send_text" || lastReply?.pendingConfirmation?.tool === "send_email");

  const starters = [
    "How is my PC doing?",
    ...(assistant.screenShareable ? ["What's on my screen?"] : []),
    "What's on my schedule?",
    "What do you know about me?"
  ];

  return (
    <section className={`os-stage ${words.tone}`} aria-label="TRH AI core">
      <div className="os-core-wrap" ref={coreRef}>
        {/* Drawn at the size it is shown, so its hairlines stay sharp. */}
        <CoreCanvas size={width ? Math.round(width) : 420} />
        <div className="os-core-mark" aria-hidden="true"><span>TRH</span><em>AI</em></div>
      </div>

      <div className="os-status-block" aria-live="polite">
        <span className="os-label">TRH AI · {online === null ? "Connecting" : online ? "Online" : "Offline"} · Living intelligence system</span>
        <h1 className={`os-state-word ${words.tone}`}>{words.word}</h1>
        <p className="os-state-detail">{detail}</p>
        <ol className="os-stages" aria-label="Progress">
          {stages.map((stage) => (
            <li key={stage} className={stage === stageNow ? "active" : ""} aria-current={stage === stageNow ? "step" : undefined}>
              {stage.charAt(0) + stage.slice(1).toLowerCase()}
            </li>
          ))}
        </ol>
      </div>

      {showReply ? (
        <article className="os-panel os-reply" aria-live="polite">
          {lastAsked ? <p className="os-reply-asked"><span className="os-label">You</span>{lastAsked.text}</p> : null}
          <div className="os-reply-body">
            <span className="os-label">TRH AI</span>
            {replyFromThisRun && lastReply ? <Markdown text={lastReply.text} className="os-markdown" /> : <p className="os-faint">Working…</p>}
          </div>
          {confirming && lastReply?.pendingConfirmation ? (
            <div className="os-confirm" role="group" aria-label={lastReply.pendingConfirmation.verb}>
              <button type="button" className="os-btn os-btn-primary" onClick={() => void send(sendingMessage ? "send it" : "yes")}>
                <Icon name="check" size={15} />{sendingMessage ? "Send" : "Yes, go ahead"}
              </button>
              <button type="button" className="os-btn" onClick={() => void send("no")}>{sendingMessage ? "Don't send" : "No"}</button>
            </div>
          ) : null}
          {!busy && lastReply ? (
            <footer className="os-reply-actions">
              <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => go("chat")}><Icon name="external" size={14} />Open in chat</button>
              <button
                type="button"
                className="os-btn os-btn-sm os-btn-ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(lastReply.text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => {});
                }}
              >
                <Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => dismissReply(lastReply.id)}><Icon name="close" size={14} />Dismiss</button>
            </footer>
          ) : null}
        </article>
      ) : !busy ? (
        <div className="os-starters" aria-label="Try asking">
          {starters.map((starter) => (
            <button key={starter} type="button" className="os-starter" disabled={!online} onClick={() => assistant.ask(starter)}>{starter}</button>
          ))}
        </div>
      ) : null}

      {rendering && !renderingDismissed ? (
        <article className="os-panel os-render" aria-label={`Rendering: ${rendering.title}`}>
          <header className="os-panel-head">
            <h3 className="os-panel-title">{rendering.kind === "diagram" ? "Diagram" : "Mockup"} · {rendering.title}</h3>
            <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label="Dismiss rendering" onClick={dismissRendering}>
              <Icon name="close" size={14} />
            </button>
          </header>
          <iframe className="os-render-frame" title={rendering.title} srcDoc={rendering.html} sandbox="" />
        </article>
      ) : null}
    </section>
  );
}
