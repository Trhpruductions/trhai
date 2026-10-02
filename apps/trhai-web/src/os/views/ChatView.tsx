"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import type { ChatMessage } from "../../hooks/useAssistant";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState, useConversations } from "../state/assistant";
import { useSystem } from "../state/system";
import { ConversationList } from "./ConversationList";
import "./views.css";

// The conversation, in full, beside every other one. The command bar below is
// where you write; this is the record - every reply labelled with how it was
// produced - and the list of conversations to move between.

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

function Message({ message, last, onConfirm, onRegenerate }: {
  message: ChatMessage;
  last: boolean;
  onConfirm: (answer: string) => void;
  /** Present only on the newest reply, when it can be asked again. */
  onRegenerate?: () => void;
}) {
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
  const failed = message.strategy === "error" || message.strategy === "stopped";
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
            {onRegenerate ? (
              <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={onRegenerate}>
                <Icon name="refresh" size={13} />{failed ? "Try again" : "Regenerate"}
              </button>
            ) : null}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** The name the API gives a conversation from its first question, before the list has it. */
function provisionalTitle(messages: ChatMessage[]): string {
  const asked = messages.find((message) => message.role === "user")?.text.split(/\r?\n/)[0]?.trim() ?? "";
  if (!asked) return "New conversation";
  return asked.length > 60 ? `${asked.slice(0, 59).trimEnd()}…` : asked;
}

export function ChatView() {
  const { messages, busy, status, send, restored, ask, screenShareable, regenerate } = useAssistantState();
  const { conversationId, conversations, deleteConversation, newConversation } = useConversations();
  const { modelName, online } = useSystem();
  const [listOpen, setListOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows, unless the reader has scrolled up.
  useEffect(() => {
    const scroller = document.getElementById("os-workspace");
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240;
    if (nearBottom) end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Land at the newest message on opening, and on switching conversation.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [restored, conversationId]);

  const listed = conversations.find((conversation) => conversation.id === conversationId);
  const title = listed?.title ?? provisionalTitle(messages);
  const fresh = messages.length === 0;

  // The newest reply can be asked again - unless images came with the question,
  // which are not kept and so could not be sent a second time.
  const newest = messages[messages.length - 1];
  const asked = messages[messages.length - 2];
  const canRegenerate = !busy && newest?.role === "assistant" && !newest.streaming && asked?.role === "user" && !asked.images;

  const starters = ["How is my PC doing?", ...(screenShareable ? ["What's on my screen?"] : []), "What do you know about me?", "Summarize my documents"];

  return (
    <div className={`os-chat-shell${listOpen ? " list-open" : ""}`}>
      <aside className="os-convos" aria-label="Conversations">
        <ConversationList onPicked={() => setListOpen(false)} />
      </aside>
      {listOpen ? <div className="os-convos-scrim" aria-hidden="true" onClick={() => setListOpen(false)} /> : null}

      <ViewFrame
        id="chat"
        className="os-chat"
        title={fresh ? "New conversation" : title}
        blurb={fresh
          ? "Talk to TRH AI - every reply is written on this PC."
          : `${messages.length} message${messages.length === 1 ? "" : "s"}${listed?.pinned ? " · pinned" : ""}${listed?.archived ? " · archived" : ""}`}
        actions={(
          <>
            <button type="button" className="os-btn os-btn-sm os-chat-list-toggle" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
              <Icon name="panel" size={14} />Conversations
            </button>
            <span className={`os-chip ${modelName ? "accent" : "warn"}`}>{modelName ?? "No model"}</span>
            <button type="button" className="os-btn os-btn-sm" disabled={busy || fresh} onClick={newConversation}>
              <Icon name="plus" size={14} />New
            </button>
            {confirmDelete ? (
              <>
                <span className="os-faint os-small">Delete this conversation? It cannot be undone.</span>
                <button type="button" className="os-btn os-btn-danger os-btn-sm"
                  onClick={() => { setConfirmDelete(false); if (conversationId) void deleteConversation(conversationId); else newConversation(); }}>
                  Delete
                </button>
                <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirmDelete(false)}>Keep</button>
              </>
            ) : (
              <button type="button" className="os-btn os-btn-sm" disabled={fresh || busy} onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={14} />Delete
              </button>
            )}
          </>
        )}
      >
        <div className="os-transcript" role="log" aria-label="Conversation" aria-live="polite">
          {fresh ? (
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
            <Message
              key={message.id}
              message={message}
              last={index === messages.length - 1 && !busy}
              onConfirm={(answer) => void send(answer)}
              onRegenerate={index === messages.length - 1 && canRegenerate ? regenerate : undefined}
            />
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
    </div>
  );
}
