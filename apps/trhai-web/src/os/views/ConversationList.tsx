"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ConversationSummary } from "../../hooks/useAssistant";
import { groupConversations, whenUsed } from "../../lib/conversationGroups";
import { Icon } from "../ui/Icon";
import { useAssistantState, useConversations } from "../state/assistant";

// Every conversation, beside the one on screen: start a new one, search them
// all (titles and everything said), and pin, rename, archive or delete any of
// them. Nothing here is local-only - the list is the account's, wherever it
// was last used.

function Conversation({ conversation, open, now, locked, onPicked }: {
  conversation: ConversationSummary;
  open: boolean;
  now: Date;
  /** A reply is being written: other conversations wait until it lands. */
  locked: boolean;
  onPicked?: () => void;
}) {
  const { openConversation, renameConversation, pinConversation, archiveConversation, deleteConversation } = useConversations();
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = new FormData(event.currentTarget).get("title");
    setRenaming(false);
    if (typeof title === "string" && title.trim() && title.trim() !== conversation.title) void renameConversation(conversation.id, title);
  };

  return (
    <li className={`os-convo${open ? " open" : ""}${confirming ? " confirming" : ""}`}>
      {renaming ? (
        <form className="os-convo-rename" onSubmit={rename}>
          <input
            name="title"
            className="os-input"
            defaultValue={conversation.title}
            maxLength={80}
            aria-label="Conversation name"
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => { if (event.key === "Escape") setRenaming(false); }}
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
          />
        </form>
      ) : (
        <button
          type="button"
          className="os-convo-open"
          aria-current={open ? "true" : undefined}
          disabled={locked && !open}
          onClick={() => { void openConversation(conversation.id); onPicked?.(); }}
        >
          <span className="os-convo-title">
            {conversation.pinned ? <Icon name="pin" size={12} className="os-convo-pin" /> : null}
            <span>{conversation.title}</span>
          </span>
          <span className="os-convo-when os-mono">{whenUsed(conversation.updatedAt, now)}</span>
          {conversation.match || conversation.preview ? (
            <span className={`os-convo-sub${conversation.match ? " match" : ""}`}>{conversation.match ?? conversation.preview}</span>
          ) : null}
        </button>
      )}

      {confirming ? (
        <div className="os-convo-confirm" role="group" aria-label={`Delete ${conversation.title}`}>
          <span>Delete for good?</span>
          <button type="button" className="os-btn os-btn-sm os-btn-danger" onClick={() => { setConfirming(false); void deleteConversation(conversation.id); }}>Delete</button>
          <button type="button" className="os-btn os-btn-sm" onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : !renaming ? (
        <div className="os-convo-actions">
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={conversation.pinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`}
            aria-pressed={conversation.pinned} data-tip={conversation.pinned ? "Unpin" : "Pin"} data-tip-pos="below"
            onClick={() => void pinConversation(conversation.id, !conversation.pinned)}>
            <Icon name="pin" size={13} />
          </button>
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Rename ${conversation.title}`}
            data-tip="Rename" data-tip-pos="below" onClick={() => setRenaming(true)}>
            <Icon name="pencil" size={13} />
          </button>
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm"
            aria-label={conversation.archived ? `Bring back ${conversation.title}` : `Archive ${conversation.title}`}
            data-tip={conversation.archived ? "Unarchive" : "Archive"} data-tip-pos="below"
            onClick={() => void archiveConversation(conversation.id, !conversation.archived)}>
            <Icon name="archive" size={13} />
          </button>
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label={`Delete ${conversation.title}`}
            data-tip="Delete" data-tip-pos="below" onClick={() => setConfirming(true)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function ConversationList({ onPicked }: { onPicked?: () => void }) {
  const { conversationId, conversations, loadConversations, newConversation } = useConversations();
  const { busy } = useAssistantState();
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Searched as you type, a beat after the last key; at once when switching
  // between conversations and the archive.
  useEffect(() => {
    const timer = window.setTimeout(() => void loadConversations({ query, archived }), query ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [query, archived, loadConversations]);

  // "5m" becomes "6m" without anyone touching anything.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => groupConversations(conversations, now), [conversations, now]);
  const searching = query.trim().length > 0;

  return (
    <div className="os-convos-inner">
      <div className="os-convos-head">
        <button type="button" className="os-btn os-btn-primary os-convos-new" disabled={busy}
          onClick={() => { newConversation(); onPicked?.(); }}>
          <Icon name="plus" size={16} />New chat
        </button>
        <label className="os-convos-search">
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
            placeholder={archived ? "Search the archive" : "Search conversations"}
            aria-label={archived ? "Search archived conversations" : "Search conversations"}
          />
          {query ? (
            <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label="Clear the search" onClick={() => setQuery("")}>
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </label>
      </div>

      <div className="os-convos-list" aria-label={archived ? "Archived conversations" : "Conversations"}>
        {groups.length === 0 ? (
          <p className="os-convos-empty">
            {searching ? <>Nothing {archived ? "archived " : ""}matches &ldquo;{query.trim()}&rdquo;.</>
              : archived ? "Nothing archived. Archive a conversation to keep it without it sitting in the list."
                : "No conversations yet. Your first message starts one."}
          </p>
        ) : groups.map((group) => (
          <section key={group.label} className="os-convos-group" aria-label={group.label}>
            <h4 className="os-label">{group.label}</h4>
            <ul>
              {group.conversations.map((conversation) => (
                <Conversation
                  key={conversation.id}
                  conversation={conversation}
                  open={conversation.id === conversationId}
                  now={now}
                  locked={busy}
                  onPicked={onPicked}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="os-convos-foot">
        <button type="button" className="os-btn os-btn-sm os-btn-ghost" aria-pressed={archived} onClick={() => setArchived(!archived)}>
          <Icon name={archived ? "chevronLeft" : "archive"} size={14} />{archived ? "Back to conversations" : "Archived"}
        </button>
      </div>
    </div>
  );
}
