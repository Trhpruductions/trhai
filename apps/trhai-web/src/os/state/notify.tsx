"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Notifications: a toast when something happens, and a history to look back on.
//
// Every notice is about something that actually happened - a reminder fired,
// the local service went away and came back, a reply finished while you were
// in another workspace. Nothing here is generated to make the screen look busy.

export type NoticeLevel = "info" | "success" | "warning" | "error";

export type Notice = {
  id: string;
  level: NoticeLevel;
  title: string;
  body?: string;
  /** Which part of the system it came from, for the history. */
  source?: string;
  at: number;
  read: boolean;
  /** Stays on screen until dismissed - for things that must not be missed. */
  sticky?: boolean;
  action?: { label: string; run: () => void };
};

export type NoticeInput = Omit<Notice, "id" | "at" | "read">;

type NotifyActions = {
  notify: (notice: NoticeInput) => string;
  dismissToast: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
};

type NotifyState = { notices: Notice[]; toasts: Notice[]; unread: number };

const ActionsContext = createContext<NotifyActions | null>(null);
const StateContext = createContext<NotifyState>({ notices: [], toasts: [], unread: 0 });

/** How long a toast stays, by how much it matters. */
const toastMs: Record<NoticeLevel, number> = { info: 6000, success: 5000, warning: 9000, error: 12000 };
const historyLimit = 60;
const toastLimit = 4;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [toastIds, setToastIds] = useState<string[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string) => {
    setToastIds((prior) => prior.filter((toast) => toast !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const notify = useCallback((input: NoticeInput) => {
    const notice: Notice = { ...input, id: crypto.randomUUID(), at: Date.now(), read: false };
    setNotices((prior) => [notice, ...prior].slice(0, historyLimit));
    setToastIds((prior) => [notice.id, ...prior].slice(0, toastLimit));
    if (!notice.sticky) {
      timers.current.set(notice.id, window.setTimeout(() => dismissToast(notice.id), toastMs[notice.level]));
    }
    return notice.id;
  }, [dismissToast]);

  const markAllRead = useCallback(() => {
    setNotices((prior) => (prior.some((notice) => !notice.read) ? prior.map((notice) => ({ ...notice, read: true })) : prior));
  }, []);

  const clearAll = useCallback(() => {
    setNotices([]);
    setToastIds([]);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
    };
  }, []);

  const actions = useMemo<NotifyActions>(() => ({ notify, dismissToast, markAllRead, clearAll }), [notify, dismissToast, markAllRead, clearAll]);
  const state = useMemo<NotifyState>(() => ({
    notices,
    toasts: toastIds.map((id) => notices.find((notice) => notice.id === id)).filter((notice): notice is Notice => Boolean(notice)),
    unread: notices.filter((notice) => !notice.read).length
  }), [notices, toastIds]);

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useNotify(): NotifyActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("useNotify needs NotifyProvider");
  return actions;
}

export function useNotices(): NotifyState {
  return useContext(StateContext);
}
