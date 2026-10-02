"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import type { ChatMessage } from "../../hooks/useAssistant";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState } from "../state/assistant";
import { useSystem } from "../state/system";
import "./views.css";

// The conversation, in full. The command bar below is where you write; this
// is the record - every reply labelled with how it was produced.

/** How a reply was produced, in words. Read from the API's own strategy field. */
function provenance(message: ChatMessage): string | null {
  const model = message.model?.replace(/^ollama\//, "").replace(/:latest$/, "");
  switch (message.strategy) {
    case "generated": return model ? `Written by ${model}` : "Written by the local model";
    case "vision": return model ? `Looked at with ${model}` : "Looked at with the vision model";
    case "answer": return "Quoted from your saved notes";
    case "calendar": case "conversion": case "reading": return "Worked out on this PC";
    case "message": return "Prepared on this PC - nothing is sent without your yes";
    case "schedule": return "Saved on this PC";
    case "stopped": return "Stopped";
    case "error": return null;
    default: return message.strategy ? "Answered on this PC" : null;
  }
}

function Message({ message, last, onConfirm }: { message: ChatMessage; last: boolean; onConfirm: (answer: string) => void }) {
  const [copied, setCopied] = useState(false);
  if (message.role === "user") {
    return (
      <div className="os-msg user">
        <div className="os-msg-bubble">
          <p>{message.text}</p>
          {message.images ? <span className="os-chip"><Icon name="image" size={12} />{message.images} image{message.images === 1 ? "" : "s"}</span> : null}
        </div>
      </div>
    );
  }
  const credit = provenance(message);
  const sending = message.pendingConfirmation?.tool === "send_text" || message.pendingConfirmation?.tool === "send_email";
  return (
    <div className={`os-msg assistant${message.strategy === "error" ? " error" : ""}`}>
      <span className="os-msg-mark" aria-hidden="true">AI</span>
      <div className="os-msg-body">
        <Markdown text={message.text || " "} className="os-markdown" />
        {message.streaming ? <span className="os-cursor" aria-label="Still writing" /> : null}
        {last && message.pendingConfirmation && !message.streaming ? (
          <div className="os-confirm" role="group" aria-label={message.pendingConfirmation.verb}>
            <button type="button" className="os-btn os-btn-primary" onClick={() => onConfirm(sending ? "send it" : "yes")}>
              <Icon name="check" size={15} />{sending ? "Send" : "Yes, go ahead"}
            </button>
            <button type="button" className="os-btn" onClick={() => onConfirm("no")}>{sending ? "Don't send" : "No"}</button>
          </div>
        ) : null}
        {!message.streaming ? (
          <footer className="os-msg-meta">
            {credit ? <span className="os-faint">{credit}</span> : null}
            {(message.toolsUsed ?? []).map((tool, index) => (
              <span key={`${tool.name}-${index}`} className={`os-chip ${tool.ok ? "" : "warn"}`}>{tool.name.replace(/_/g, " ")}</span>
            ))}
            <button
              type="button"
              className="os-btn os-btn-sm os-btn-ghost"
              onClick={() => void navigator.clipboard?.writeText(message.text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => {})}
            >
              <Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied" : "Copy"}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

export function ChatView() {
  const { messages, busy, status, send, clear, restored, ask, screenShareable } = useAssistantState();
  const { modelName, online } = useSystem();
  const [confirmClear, setConfirmClear] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows, unless the reader has scrolled up.
  useEffect(() => {
    const scroller = document.getElementById("os-workspace");
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240;
    if (nearBottom) end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Land at the newest message on opening.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [restored]);

  const starters = ["How is my PC doing?", ...(screenShareable ? ["What's on my screen?"] : []), "What do you know about me?", "Summarize my documents"];

  return (
    <ViewFrame
      id="chat"
      className="os-chat"
      actions={(
        <>
          <span className={`os-chip ${modelName ? "accent" : "warn"}`}>{modelName ?? "No model"}</span>
          <span className="os-chip">{messages.length} message{messages.length === 1 ? "" : "s"}</span>
          {confirmClear ? (
            <>
              <span className="os-faint os-small">Clear this conversation? It cannot be undone.</span>
              <button type="button" className="os-btn os-btn-danger os-btn-sm" onClick={() => { setConfirmClear(false); void clear(); }}>Clear</button>
              <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirmClear(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className="os-btn os-btn-sm" disabled={messages.length === 0 || busy} onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={14} />Clear
            </button>
          )}
        </>
      )}
    >
      <div className="os-transcript" role="log" aria-label="Conversation" aria-live="polite">
        {messages.length === 0 ? (
          <div className="os-empty os-chat-empty">
            <strong>{restored ? "Start a conversation" : "Loading the conversation…"}</strong>
            <p>Ask anything in the command bar below - type, speak, or attach an image. Replies are written on this PC.</p>
            {restored ? (
              <div className="os-starters">
                {starters.map((starter) => (
                  <button key={starter} type="button" className="os-starter" disabled={!online} onClick={() => ask(starter)}>{starter}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : messages.map((message, index) => (
          <Message key={message.id} message={message} last={index === messages.length - 1 && !busy} onConfirm={(answer) => void send(answer)} />
        ))}
        {busy && messages[messages.length - 1]?.role === "user" ? (
          <div className="os-msg assistant thinking">
            <span className="os-msg-mark" aria-hidden="true">AI</span>
            <div className="os-msg-body">
              <span className="os-thinking"><span /><span /><span /></span>
              <span className="os-faint os-small">
                {status.state === "executing" ? `Running ${status.tool.replace(/_/g, " ")}` : status.state === "thinking" ? (status.stage ?? "Thinking") : "Working"}
              </span>
            </div>
          </div>
        ) : null}
        <div ref={end} />
      </div>
    </ViewFrame>
  );
}
