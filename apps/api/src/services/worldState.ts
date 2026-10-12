// What the agents' world shows: which agent the assistant was last asked to be,
// and everything it has really been doing, across every session.
//
// The world is a separate app and has no session of its own, so it reads this
// instead of one browser's trace. Nothing is made up: who is where comes from
// the real execution steps (see agentWorld in @ascend/shared), and the agent in
// use is the one the most recent request named.

import { allAgents, agentById, byRoom, recentSteps, residents, rooms, type Agent, type ExecutionEvent } from "@ascend/shared";
import { listAllEvents } from "./executionLog.js";

let lastAgent: { id: string | null; at: string } | null = null;

/** Called for every turn: the agent it named, or none. */
export function noteAgentUse(id: string | null, now: Date = new Date()): void {
  lastAgent = { id, at: now.toISOString() };
}

export function resetWorldState(): void {
  lastAgent = null;
}

export function readWorld(now: Date = new Date()) {
  const active: Agent | null = lastAgent?.id ? agentById(lastAgent.id) ?? null : null;
  const events = listAllEvents(80) as ExecutionEvent[];
  const all = residents(allAgents(), active, events);
  return {
    at: now.toISOString(),
    rooms,
    residents: all,
    byRoom: byRoom(all).map((entry) => ({ roomId: entry.room.id, residents: entry.residents.map((resident) => resident.id) })),
    steps: recentSteps(events, 12),
    activeAgentId: active?.id ?? null,
    activeSince: lastAgent?.at ?? null,
    working: all[0].state === "working"
  };
}
