"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl, requestHeaders, sessionId as resolveSessionId } from "../lib/api";
import { applyAgentDisclaimer, applyResponseStyle } from "@ascend/shared";
import { readStoredPersonality } from "../lib/personality";
import { readActiveAgent } from "../lib/agents";

// Conversation state, talking to the real local orchestrator — the same
// service the rest of this monorepo already built, tested, and runs against
// a local model. Nothing here is a mock; a reply that arrives is a reply the
// model actually produced, and a tool result is one that actually ran.

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
  strategy?: string;
  model?: string;
  toolsUsed?: Array<{ name: string; ok: boolean }>;
  /**
   * An action this reply is waiting on a yes for - a text or an email to send,
   * something to delete - as the API described it. The reply's own text says
   * the same; this is what lets the screen offer the answer as a button.
   */
  pendingConfirmation?: { tool: string; verb: string; target: string };
  /** How many images were sent with this message. */
  images?: number;
  /**
   * True while this reply is still being written.
   *
   * The text is real — it is what the model has produced so far — but it is
   * not finished, and some things have to wait for that. The voice above all:
   * reading a sentence aloud while it is still being written would speak a
   * fragment and then have nothing to follow it.
   */
  streaming?: boolean;
};

export type AssistantStatus =
  | { state: "idle" }
  | { state: "thinking"; stage?: string }
  | { state: "executing"; tool: string; stage?: string }
  | { state: "success" }
  | { state: "error"; detail: string };

/** A conversation as the API lists it (GET /v1/conversations). */
export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  turnCount: number;
  preview: string;
  /** Where a search matched, when it was inside the conversation rather than its title. */
  match?: string;
};

export type ConversationFilter = { query?: string; archived?: boolean };

type StoredTurnPayload = { id?: string; role: ChatRole; content: string; createdAt?: string; strategy?: string; model?: string };

/** Which conversation was open, so a reload comes back to it. */
const conversationKey = "trhai.chat.conversation.v1";

function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

function readOpenConversation(): string | null {
  try {
    const value = window.localStorage.getItem(conversationKey);
    return isConversationId(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberOpenConversation(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(conversationKey, id);
    else window.localStorage.removeItem(conversationKey);
  } catch {
    // Not remembered across a reload; everything else still works.
  }
}

/**
 * Stored turns as messages. "restored-" ids mark them as history rather than
 * news: they are never read aloud and never shown on the stage as a fresh reply.
 */
function restoredMessages(turns: StoredTurnPayload[]): ChatMessage[] {
  return turns.map((turn, index) => ({
    id: `restored-${turn.id ?? index}`,
    role: turn.role,
    text: turn.content,
    at: Date.parse(turn.createdAt ?? "") || Date.now(),
    strategy: turn.strategy,
    model: turn.model
  }));
}

function isPendingConfirmation(value: unknown): value is { tool: string; verb: string; target: string } {
  const pending = value as { tool?: unknown; verb?: unknown; target?: unknown } | null;
  return Boolean(pending) && typeof pending?.tool === "string" && typeof pending?.verb === "string"
    && typeof pending?.target === "string";
}

const historyTurns = 8;
/** How often to check which tool is running — see /v1/assist/activity. */
const activityPollMs = 500;
/** How often a streaming reply repaints. Fast enough to read as live, slow
 * enough that a long answer costs tens of renders rather than hundreds. */
const streamPaintMs = 60;
/** How long the core shows a finished reply as "success" before settling to idle. */
const successHoldMs = 1200;

export function useAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>({ state: "idle" });
  const [restored, setRestored] = useState(false);
  const session = useRef(resolveSessionId());
  /**
   * The conversation on screen, or null for a new chat that has not been sent
   * yet. Kept in a ref as well as state: send() reads it mid-request, and
   * reading state there would see the value from when send() was created.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const openConversationRef = useRef<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const listFilter = useRef<ConversationFilter>({});
  const listGeneration = useRef(0);
  const busy = useRef(false);
  // Bumped once per send() call. A poll tick or a success-hold timeout only
  // acts while its own call is still the most recent one — this is what
  // stops a stale callback from a superseded call clobbering the status a
  // newer call is actively setting.
  const generation = useRef(0);
  /**
   * The request in flight, so it can genuinely be stopped.
   *
   * Aborting the fetch closes the connection, which the API notices and uses
   * to stop the model. Without that the reply would only be hidden while the
   * machine carried on producing it.
   */
  const inFlight = useRef<AbortController | null>(null);

  /** Makes a conversation the open one, without touching what is on screen. */
  const adopt = useCallback((id: string | null) => {
    openConversationRef.current = id;
    setConversationId(id);
    rememberOpenConversation(id);
  }, []);

  /**
   * The conversation list, filtered as last asked (a search, or the archived
   * ones). Re-run after every reply and every change, so a new conversation's
   * title and a rename show up without anyone refreshing.
   */
  const loadConversations = useCallback(async (filter?: ConversationFilter) => {
    if (filter) listFilter.current = filter;
    const mine = ++listGeneration.current;
    const params = new URLSearchParams({ sessionId: session.current });
    if (listFilter.current.query?.trim()) params.set("q", listFilter.current.query.trim());
    if (listFilter.current.archived) params.set("archived", "1");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/conversations?${params}`, { headers: requestHeaders() });
      const payload = response.ok ? await response.json() : null;
      // Only the newest request may answer: typing a search fires several.
      if (mine === listGeneration.current && Array.isArray(payload?.data?.conversations)) {
        setConversations(payload.data.conversations as ConversationSummary[]);
      }
    } catch {
      // The list stays as it was; the next reply or change asks again.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sessionParam = encodeURIComponent(session.current);
    // Anything sent or opened while this is loading wins: a message typed in
    // the first second must not be swept away by the restore landing late.
    const startedAt = generation.current;
    const superseded = () => cancelled || generation.current !== startedAt;
    // The conversation that was open last time, if it still exists; otherwise
    // the one used most recently. Signed in, either follows the account to
    // whichever browser it was last used in.
    const open = async () => {
      const remembered = readOpenConversation();
      if (remembered) {
        const response = await fetch(`${apiBaseUrl}/v1/conversations/${remembered}?sessionId=${sessionParam}`, { headers: requestHeaders() });
        const conversation = response.ok ? (await response.json())?.data?.conversation : null;
        if (conversation) {
          if (!superseded()) {
            setMessages(restoredMessages(conversation.turns ?? []));
            adopt(conversation.id);
          }
          return;
        }
      }
      const response = await fetch(`${apiBaseUrl}/v1/assist/conversation?sessionId=${sessionParam}`, { headers: requestHeaders() });
      const payload = response.ok ? await response.json() : null;
      if (superseded()) return;
      const turns: StoredTurnPayload[] = payload?.data?.turns ?? [];
      if (turns.length > 0) setMessages(restoredMessages(turns));
      adopt(isConversationId(payload?.data?.conversationId) ? payload.data.conversationId : null);
    };
    open()
      .catch(() => { /* a fresh session has no transcript to restore, and that is fine */ })
      .finally(() => {
        if (cancelled) return;
        setRestored(true);
        void loadConversations();
      });
    return () => { cancelled = true; };
  }, [adopt, loadConversations]);

  const send = useCallback(async (
    input: string,
    images: Array<{ name: string; data: string }> = [],
    options: { regenerate?: boolean } = {}
  ) => {
    const text = input.trim();
    if (!text || busy.current) return;

    // Asking again: the question already on screen stays, the reply to it
    // goes, and the API replaces that exchange in the stored conversation
    // once the new answer exists.
    const regenerating = options.regenerate === true;
    const before = regenerating && messages[messages.length - 1]?.role === "assistant" ? messages.slice(0, -1) : messages;
    if (regenerating && (before[before.length - 1]?.role !== "user" || before[before.length - 1]?.text !== text)) return;

    busy.current = true;
    const myGeneration = ++generation.current;
    const stillCurrent = () => generation.current === myGeneration;

    // A new chat is named here, by its first message; the API creates it
    // under this id, so the list and the next message agree on which it is.
    let conversation = openConversationRef.current;
    if (!conversation) {
      conversation = crypto.randomUUID();
      adopt(conversation);
    }

    if (regenerating) {
      setMessages(before);
    } else {
      const userTurn: ChatMessage = {
        id: crypto.randomUUID(), role: "user", text, at: Date.now(),
        ...(images.length > 0 ? { images: images.length } : {})
      };
      setMessages((prior) => [...prior, userTurn]);
    }
    setStatus({ state: "thinking" });

    const earlier = regenerating ? before.slice(0, -1) : messages;
    const history = earlier.slice(-historyTurns).map((entry) => ({ role: entry.role, content: entry.text }));

    // Which tool is actually running right now, if any — real activity from
    // the orchestrator (see /v1/assist/activity), not a guess dressed up as
    // one. Absent is the ordinary case for most turns, which stay "thinking"
    // the whole way through.
    const activityPoll = window.setInterval(() => {
      fetch(`${apiBaseUrl}/v1/assist/activity?sessionId=${encodeURIComponent(session.current)}`, { headers: requestHeaders() })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!stillCurrent()) return;
          const tool = payload?.data?.tool;
          // Which part of the pipeline this actually is. Reported by the API
          // from real checkpoints, not guessed from elapsed time here.
          const stage = typeof payload?.data?.stageLabel === "string"
            ? payload.data.stageLabel
            : undefined;
          setStatus((existing) => {
            // Only ever steers a turn already in progress — a poll response
            // that lands after the request itself resolved must not drag a
            // finished turn's status back toward "thinking".
            if (existing.state !== "thinking" && existing.state !== "executing") return existing;
            return typeof tool === "string"
              ? { state: "executing", tool, stage }
              : { state: "thinking", stage };
          });
        })
        .catch(() => { /* a missed poll just leaves the last known status showing */ });
    }, activityPollMs);

    // Made before the request so streamed text has a message to land in, and
    // the finished reply replaces that same message rather than appending a
    // second copy of itself.
    const replyId = crypto.randomUUID();
    let streamed = "";

    const controller = new AbortController();
    inFlight.current = controller;

    // Declared out here so `finally` can always clear it. Created inside the
    // try, it was only cleared on the path where the stream finished normally
    // — a stopped or failed request left it repainting forever.
    let flush = 0;

    try {
      const response = await fetch(`${apiBaseUrl}/v1/assist/stream`, {
        method: "POST",
        headers: requestHeaders({ "Content-Type": "application/json" }),
        // The active agent goes by id only; the API looks it up in the shared
        // catalogue rather than taking a persona from the client. Read now, so
        // a change in the settings rail applies to the very next message.
        body: JSON.stringify({
          message: text, sessionId: session.current, history, mode: "general",
          conversationId: conversation,
          ...(regenerating ? { regenerate: true } : {}),
          agentId: readActiveAgent(window.localStorage)?.id,
          // Shown to the vision model on the API; never stored there.
          ...(images.length > 0 ? { images } : {})
        }),
        // Aborting closes the connection, which the API notices and uses to
        // stop the model. Without it, stopping would only hide the reply while
        // the machine carried on producing it.
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`The assistant service answered ${response.status}.`);
      if (!response.body) throw new Error("The assistant service sent no reply.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: Record<string, unknown> | null = null;
      let failure: string | null = null;

      // Paints whatever has arrived, on a timer. An interval callback is a
      // macrotask, so each flush is its own render — which is the whole point.
      // It also means a fast reply costs ~20 renders instead of ~550.
      let painted = "";
      flush = window.setInterval(() => {
        if (streamed === painted) return;
        painted = streamed;
        setMessages((prior) => (prior.some((message) => message.id === replyId)
          ? prior.map((message) =>
            (message.id === replyId ? { ...message, text: painted } : message))
          : [...prior, {
            id: replyId, role: "assistant" as const, text: painted,
            at: Date.now(), streaming: true
          }]));
      }, streamPaintMs);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Events are separated by a blank line; a partial one waits in the
        // buffer for the rest of it.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const body = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !body) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Accumulated here and painted by the flush timer below, never
          // straight from this loop.
          //
          // reader.read() resolves in a microtask whenever the next chunk is
          // already buffered, so a fast reply runs hundreds of updates with no
          // macrotask boundary between them — and React batches the lot into a
          // single render at the end. The first token lands in a real network
          // task and paints; every one after it was being coalesced away, so
          // the reply appeared to arrive whole despite arriving in pieces.
          if (event === "token" && typeof parsed.text === "string") streamed += parsed.text;
          if (event === "done") data = parsed;
          if (event === "failed") failure = String(parsed.message ?? "The assistant could not answer.");
        }
      }

      window.clearInterval(flush);

      if (failure) throw new Error(failure);
      if (!data) throw new Error("The assistant stopped before finishing its reply.");

      // The finished result replaces whatever was streamed. That is what makes
      // it safe for tokens to be withheld mid-stream when the model turns out
      // to have been writing a tool call: what is on screen is provisional
      // until this lands.
      // The selected personality's mandatory disclaimer, appended here.
      //
      // Three personalities carry one — Medical, Legal and Cyber Security —
      // and applyResponseStyle, the only thing that appends it, was never
      // called from anywhere in the app. Choosing "Medical" gave you a
      // personality whose own summary says "Never a substitute for care" and
      // replies that never once said so. A disclaimer the field itself calls
      // mandatory is not decoration, and a picker that silently changes
      // nothing is the fake this build exists to refuse.
      //
      // Applied to the finished message rather than at render, so it is part
      // of the text that gets stored and the text that gets read aloud — a
      // spoken medical answer needs the caveat more than a written one, not
      // less. Read at this moment rather than captured, so it follows whatever
      // is selected when the reply lands.
      const answered = typeof data.assistantMessage === "string" ? data.assistantMessage : streamed;

      const finished: ChatMessage = {
        id: replyId,
        role: "assistant",
        // And the active agent's, the same way and never twice: the Doctor
        // agent says "Not a substitute for care" of itself, and its replies
        // never did.
        text: applyAgentDisclaimer(
          applyResponseStyle(answered, readStoredPersonality(window.localStorage)),
          readActiveAgent(window.localStorage)
        ),
        at: Date.now(),
        strategy: data.strategy as string | undefined,
        model: data.model as string | undefined,
        toolsUsed: data.toolsUsed as ChatMessage["toolsUsed"],
        ...(isPendingConfirmation(data.pendingConfirmation) ? { pendingConfirmation: data.pendingConfirmation } : {})
      };

      setMessages((prior) => (prior.some((message) => message.id === replyId)
        ? prior.map((message) => (message.id === replyId ? finished : message))
        : [...prior, finished]));
      // The conversation the API recorded this in - the same one, unless it
      // had to pick - and the list, which now has its title and newest line.
      if (isConversationId(data.conversationId) && data.conversationId !== openConversationRef.current && stillCurrent()) {
        adopt(data.conversationId);
      }
      void loadConversations();
      if (stillCurrent()) {
        setStatus({ state: "success" });
        // A brief confirmation, not a resting state — see core.css's
        // core-confirm animation, built to finish well within this window.
        // Deliberately not guarded by busy/generation cleanup in `finally`
        // below: this timeout has to outlive that block to ever fire.
        window.setTimeout(() => { if (stillCurrent()) setStatus({ state: "idle" }); }, successHoldMs);
      }
    } catch (error) {
      // Stopping is not an error, and must not be reported as one. Whatever
      // had already arrived is kept and marked as stopped: those words were
      // genuinely produced, and throwing them away would lose real work to
      // make the failure tidier.
      if (controller.signal.aborted) {
        if (stillCurrent()) setStatus({ state: "idle" });
        setMessages((prior) => {
          const partial = streamed.trim();
          const existing = prior.some((message) => message.id === replyId);
          const stoppedMessage: ChatMessage = {
            id: replyId,
            role: "assistant",
            text: partial ? `${partial}\n\n_Stopped._` : "_Stopped before anything was written._",
            at: Date.now(),
            strategy: "stopped"
          };
          return existing
            ? prior.map((message) => (message.id === replyId ? stoppedMessage : message))
            : [...prior, stoppedMessage];
        });
        return;
      }

      const detail = error instanceof Error ? error.message : "The assistant could not be reached.";
      if (stillCurrent()) setStatus({ state: "error", detail });
      setMessages((prior) => [...prior, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `${detail}\n\nThe local API runs on this machine; if this persists, it may not be running.`,
        at: Date.now(),
        strategy: "error"
      }]);
    } finally {
      // Stops polling and frees the next send() to start — deliberately
      // does not touch `generation`, which stays valid through the success
      // hold above until a genuinely newer call moves it forward.
      window.clearInterval(activityPoll);
      window.clearInterval(flush);
      inFlight.current = null;
      busy.current = false;
    }
  }, [messages, adopt, loadConversations]);

  /**
   * Stop the request in flight.
   *
   * Aborts the fetch, which closes the connection, which the API turns into a
   * real cancellation of the model — so the machine stops working, not just
   * the screen. Safe to call when nothing is running.
   */
  const stop = useCallback(() => {
    inFlight.current?.abort();
  }, []);

  /** Asks the newest question again, replacing the answer it got. */
  const regenerate = useCallback(() => {
    const asked = [...messages].reverse().find((message) => message.role === "user");
    if (!asked || busy.current) return;
    void send(asked.text, [], { regenerate: true });
  }, [messages, send]);

  /** A blank chat. Nothing is created until its first message is sent. */
  const newConversation = useCallback(() => {
    if (busy.current) return;
    generation.current += 1;
    setMessages([]);
    setStatus({ state: "idle" });
    adopt(null);
  }, [adopt]);

  /** Puts a conversation from the list on screen. Not while a reply is being written. */
  const openConversation = useCallback(async (id: string) => {
    if (busy.current || id === openConversationRef.current) return;
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/conversations/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(session.current)}`,
        { headers: requestHeaders() }
      );
      const conversation = response.ok ? (await response.json())?.data?.conversation : null;
      if (!conversation) {
        // Gone - deleted in another window, most likely. The list catches up.
        void loadConversations();
        return;
      }
      generation.current += 1;
      setMessages(restoredMessages(conversation.turns ?? []));
      setStatus({ state: "idle" });
      adopt(conversation.id);
    } catch {
      // Left on the conversation already open.
    }
  }, [adopt, loadConversations]);

  const changeConversation = useCallback(async (id: string, change: { title?: string; pinned?: boolean; archived?: boolean }) => {
    try {
      const response = await fetch(`${apiBaseUrl}/v1/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: requestHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId: session.current, ...change })
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      void loadConversations();
    }
  }, [loadConversations]);

  const renameConversation = useCallback((id: string, title: string) => changeConversation(id, { title }), [changeConversation]);
  const pinConversation = useCallback((id: string, pinned: boolean) => changeConversation(id, { pinned }), [changeConversation]);
  const archiveConversation = useCallback((id: string, archived: boolean) => changeConversation(id, { archived }), [changeConversation]);

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await fetch(`${apiBaseUrl}/v1/conversations/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(session.current)}`, {
        method: "DELETE",
        headers: requestHeaders()
      });
    } catch {
      // The list below shows whether it went.
    }
    if (id === openConversationRef.current) newConversation();
    void loadConversations();
  }, [loadConversations, newConversation]);

  /** Deletes the conversation on screen - what "clear" meant when there was only one. */
  const clear = useCallback(async () => {
    const open = openConversationRef.current;
    if (open) {
      await deleteConversation(open);
      return;
    }
    setMessages([]);
    setStatus({ state: "idle" });
  }, [deleteConversation]);

  return {
    messages, status, restored, sessionId: session.current, send, stop, clear, regenerate,
    conversationId, conversations, loadConversations, newConversation, openConversation,
    renameConversation, pinConversation, archiveConversation, deleteConversation
  };
}
