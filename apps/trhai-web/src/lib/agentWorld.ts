// The agents' world: a map of rooms, and where each agent is standing in it.
//
// Everything here is read from what TRH AI really did. The seven rooms are the
// seven kinds of step the execution log records, so an agent is in the Library
// only because a read really started and in the Workshop only because a file
// really began being written. Nothing moves on a timer and nothing is acted
// out: with no step running, the agent stands in its own room and the screen
// says it is idle.
//
// Only the agent that is active can be working. The assistant is one process
// doing one request at a time - the other agents are roles it can take on, not
// workers running beside it - so showing them busy would be inventing activity.
// They stand in their rooms and say what they are for.

import type { Agent } from "@ascend/shared";
import type { ExecutionEvent } from "../hooks/useExecutionEvents";

export type RoomId = "study" | "library" | "workshop" | "depot" | "lab" | "terminal" | "launchpad";

export type Room = {
  id: RoomId;
  name: string;
  /** What happens here, in a few words. */
  purpose: string;
  /** The execution steps that put an agent in this room. */
  kinds: ExecutionEvent["kind"][];
  /** Grid position on the map: column, then row. */
  col: number;
  row: number;
};

export const rooms: Room[] = [
  { id: "study", name: "Study", purpose: "Plans the work before any of it is done", kinds: ["plan"], col: 0, row: 0 },
  { id: "library", name: "Library", purpose: "Reads files, pages and notes", kinds: ["read"], col: 1, row: 0 },
  { id: "workshop", name: "Workshop", purpose: "Creates and writes files and apps", kinds: ["create", "write"], col: 2, row: 0 },
  { id: "depot", name: "Depot", purpose: "Installs what a project needs", kinds: ["install"], col: 0, row: 1 },
  { id: "lab", name: "Lab", purpose: "Tests and checks what was made", kinds: ["test", "verify"], col: 1, row: 1 },
  { id: "terminal", name: "Terminal", purpose: "Runs commands on this PC", kinds: ["command"], col: 2, row: 1 },
  { id: "launchpad", name: "Launchpad", purpose: "Starts apps so they can be seen running", kinds: ["launch"], col: 1, row: 2 }
];

export function roomById(id: RoomId): Room {
  return rooms.find((room) => room.id === id) ?? rooms[0];
}

/** The room a kind of step happens in. */
export function roomForKind(kind: ExecutionEvent["kind"]): Room {
  return rooms.find((room) => room.kinds.includes(kind)) ?? rooms[0];
}

/** Where an agent stands when nothing is running: the room closest to its work. */
const homeRoom: Record<string, RoomId> = {
  programmer: "workshop",
  designer: "workshop",
  "game-developer": "workshop",
  researcher: "library",
  lawyer: "library",
  doctor: "library",
  "financial-advisor": "study",
  marketer: "study",
  streamer: "launchpad",
  "content-creator": "launchpad"
};

export function homeRoomFor(agentId: string): Room {
  return roomById(homeRoom[agentId] ?? "study");
}

/** TRH AI itself, which works whether or not an agent has been chosen. */
export const coreAgent = { id: "trh-ai", name: "TRH AI", avatar: "◉", role: "The assistant", focus: "Answers directly, with no role taken on" } as const;

export type Resident = {
  id: string;
  name: string;
  avatar: string;
  role: string;
  /** What this agent is for - the line shown for an idle one. */
  focus: string;
  room: Room;
  state: "working" | "idle";
  /** What it is doing right now, from the step itself; null while idle. */
  doing: string | null;
  /** Whether this is the agent the assistant is currently using. */
  active: boolean;
};

/** The steps still running, oldest first. */
export function runningSteps(events: ExecutionEvent[]): ExecutionEvent[] {
  return events.filter((event) => event.status === "running");
}

/**
 * Who is where.
 *
 * The agent in use - or TRH AI itself when none is chosen - goes to the room of
 * the step running now, and says what the step says. With nothing running it
 * stays in its own room, idle. Every other agent stays in its own room, idle.
 */
export function residents(agents: Agent[], active: Agent | null, events: ExecutionEvent[]): Resident[] {
  const running = runningSteps(events);
  const current = running.length > 0 ? running[running.length - 1] : null;

  const worker = active
    ? { id: active.id, name: active.name, avatar: active.avatar, role: active.role, focus: active.focus }
    : coreAgent;

  const fromAgents: Resident[] = agents
    .filter((agent) => agent.id !== worker.id)
    .map((agent) => ({
      id: agent.id, name: agent.name, avatar: agent.avatar, role: agent.role, focus: agent.focus,
      room: homeRoomFor(agent.id), state: "idle" as const, doing: null, active: false
    }));

  const lead: Resident = {
    id: worker.id, name: worker.name, avatar: worker.avatar, role: worker.role, focus: worker.focus,
    room: current ? roomForKind(current.kind) : homeRoomFor(worker.id),
    state: current ? "working" : "idle",
    doing: current ? current.label : null,
    active: true
  };

  return [lead, ...fromAgents];
}

/** Residents grouped by the room they are in, in the order the map lays rooms out. */
export function byRoom(all: Resident[]): Array<{ room: Room; residents: Resident[] }> {
  return rooms.map((room) => ({ room, residents: all.filter((resident) => resident.room.id === room.id) }));
}

/** The latest steps, newest first, each with the room it happened in. */
export function recentSteps(events: ExecutionEvent[], limit = 8): Array<{ event: ExecutionEvent; room: Room }> {
  return [...events].reverse().slice(0, limit).map((event) => ({ event, room: roomForKind(event.kind) }));
}
