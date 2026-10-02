// How the chat workspace lays out the conversation list: pinned ones first,
// then the rest by when they were last used. Pure, so the boundaries can be
// tested without a browser or a clock.

export type ListedConversation = { id: string; pinned: boolean; updatedAt: string };

export type ConversationGroup<T extends ListedConversation> = { label: string; conversations: T[] };

/** Midnight at the start of `now`'s day, moved by whole calendar days (safe across clock changes). */
function dayStart(now: Date, daysBack: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime();
}

/**
 * Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, then one group
 * per month. Keeps the order the list arrived in within each group, and groups
 * in the order they first appear - which, for a list sorted pinned-then-newest,
 * is the reading order.
 */
export function groupConversations<T extends ListedConversation>(list: T[], now: Date): Array<ConversationGroup<T>> {
  const today = dayStart(now, 0);
  const yesterday = dayStart(now, 1);
  const week = dayStart(now, 7);
  const month = dayStart(now, 30);
  const groups = new Map<string, T[]>();

  for (const conversation of list) {
    const at = Date.parse(conversation.updatedAt) || 0;
    const label = conversation.pinned ? "Pinned"
      : at >= today ? "Today"
        : at >= yesterday ? "Yesterday"
          : at >= week ? "Previous 7 days"
            : at >= month ? "Previous 30 days"
              : new Date(at).toLocaleDateString("en", { month: "long", year: "numeric" });
    groups.set(label, [...(groups.get(label) ?? []), conversation]);
  }

  return [...groups].map(([label, conversations]) => ({ label, conversations }));
}

/** When a conversation was last used, as briefly as is still clear: "now", "5m", "3h", "Yesterday", "Mon", "12 Sep". */
export function whenUsed(updatedAt: string, now: Date): string {
  const at = Date.parse(updatedAt);
  if (!at) return "";
  const minutes = Math.floor((now.getTime() - at) / 60000);
  if (minutes < 1) return "now";
  if (at >= dayStart(now, 0)) return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
  if (at >= dayStart(now, 1)) return "Yesterday";
  const then = new Date(at);
  if (at >= dayStart(now, 6)) return then.toLocaleDateString("en", { weekday: "short" });
  return then.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(then.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
