import test from "node:test";
import assert from "node:assert/strict";
import { groupConversations, whenUsed } from "../src/lib/conversationGroups.js";

// The chat list's grouping and time labels, against a fixed "now" so the
// boundaries are exact: midnight, a week, a month.

const now = new Date(2026, 9, 2, 15, 30); // 2 Oct 2026, 15:30 local
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month, day, hour, minute).toISOString();
const conversation = (id: string, updatedAt: string, pinned = false) => ({ id, updatedAt, pinned });

test("pinned first, then today, yesterday, the week, the month, and by month after that", () => {
  const groups = groupConversations([
    conversation("pin", at(2025, 0, 1), true),
    conversation("today", at(2026, 9, 2, 0, 5)),
    conversation("yesterday", at(2026, 9, 1, 23, 59)),
    conversation("week", at(2026, 8, 26)),
    conversation("month", at(2026, 8, 10)),
    conversation("august", at(2026, 7, 20)),
    conversation("july", at(2026, 6, 4))
  ], now);

  assert.deepEqual(groups.map((group) => [group.label, group.conversations.map((entry) => entry.id)]), [
    ["Pinned", ["pin"]],
    ["Today", ["today"]],
    ["Yesterday", ["yesterday"]],
    ["Previous 7 days", ["week"]],
    ["Previous 30 days", ["month"]],
    ["August 2026", ["august"]],
    ["July 2026", ["july"]]
  ]);
});

test("midnight is the boundary between today and yesterday, not 24 hours", () => {
  const groups = groupConversations([
    conversation("just-after", at(2026, 9, 2, 0, 1)),
    conversation("just-before", at(2026, 9, 1, 23, 58))
  ], now);
  assert.deepEqual(groups.map((group) => group.label), ["Today", "Yesterday"]);
});

test("order within a group is the order the list arrived in", () => {
  const [today] = groupConversations([
    conversation("newer", at(2026, 9, 2, 14)),
    conversation("older", at(2026, 9, 2, 9))
  ], now);
  assert.deepEqual(today.conversations.map((entry) => entry.id), ["newer", "older"]);
});

test("time labels are short and still unambiguous", () => {
  assert.equal(whenUsed(at(2026, 9, 2, 15, 29, ), now), "1m");
  assert.equal(whenUsed(new Date(now.getTime() - 20_000).toISOString(), now), "now");
  assert.equal(whenUsed(at(2026, 9, 2, 12, 0), now), "3h");
  assert.equal(whenUsed(at(2026, 9, 1, 9, 0), now), "Yesterday");
  assert.equal(whenUsed(at(2026, 8, 28), now), "Mon");
  assert.equal(whenUsed(at(2026, 7, 12), now), "12 Aug");
  assert.equal(whenUsed(at(2025, 11, 25), now), "25 Dec 2025");
  assert.equal(whenUsed("not a date", now), "");
});
