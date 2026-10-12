import test from "node:test";
import assert from "node:assert/strict";
import { allAgents, agentById } from "@ascend/shared";
import {
  byRoom, homeRoomFor, recentSteps, residents, roomForKind, rooms, runningSteps
} from "../src/lib/agentWorld.js";
import type { ExecutionEvent } from "../src/hooks/useExecutionEvents.js";

function step(id: string, kind: ExecutionEvent["kind"], status: ExecutionEvent["status"], label = `${kind} ${id}`): ExecutionEvent {
  return { id, kind, label, status, startedAt: "2026-10-10T10:00:00.000Z" };
}

test("every kind of step the log records has a room", () => {
  const kinds: ExecutionEvent["kind"][] = ["plan", "create", "write", "install", "test", "verify", "launch", "command", "read"];
  for (const kind of kinds) assert.ok(rooms.some((room) => room.kinds.includes(kind)), `${kind} has no room`);
});

test("no step belongs to two rooms", () => {
  const seen = new Map<string, string>();
  for (const room of rooms) for (const kind of room.kinds) {
    assert.equal(seen.get(kind), undefined, `${kind} is in ${seen.get(kind)} and ${room.id}`);
    seen.set(kind, room.id);
  }
});

test("rooms do not share a place on the map", () => {
  const places = rooms.map((room) => `${room.col},${room.row}`);
  assert.equal(new Set(places).size, places.length);
});

test("every agent in the catalogue has a home room that exists", () => {
  for (const agent of allAgents()) assert.ok(rooms.some((room) => room.id === homeRoomFor(agent.id).id), agent.id);
});

test("with nothing running, nobody is working", () => {
  const all = residents(allAgents(), null, []);
  assert.ok(all.every((resident) => resident.state === "idle" && resident.doing === null));
});

test("with no agent chosen, TRH AI itself is the one that works", () => {
  const all = residents(allAgents(), null, [step("1", "read", "running", "Reading notes.txt")]);
  const working = all.filter((resident) => resident.state === "working");
  assert.equal(working.length, 1);
  assert.equal(working[0].id, "trh-ai");
  assert.equal(working[0].room.id, roomForKind("read").id);
  assert.equal(working[0].doing, "Reading notes.txt");
});

test("the chosen agent is the one that works, and moves to the room of the running step", () => {
  const programmer = agentById("programmer")!;
  const all = residents(allAgents(), programmer, [step("1", "test", "running", "Running the tests")]);
  const lead = all[0];
  assert.equal(lead.id, "programmer");
  assert.equal(lead.state, "working");
  assert.equal(lead.room.id, "lab");
  assert.ok(!all.some((resident) => resident.id === "trh-ai"), "TRH AI is not also standing in the world");
  assert.equal(all.filter((resident) => resident.state === "working").length, 1);
});

test("a step that has finished does not keep the agent in its room", () => {
  const programmer = agentById("programmer")!;
  const all = residents(allAgents(), programmer, [step("1", "test", "ok"), step("2", "write", "failed")]);
  assert.equal(all[0].state, "idle");
  assert.equal(all[0].room.id, homeRoomFor("programmer").id);
});

test("with several steps running, the newest decides where the agent is", () => {
  const events = [step("1", "read", "running"), step("2", "command", "running", "Running npm test")];
  assert.equal(runningSteps(events).length, 2);
  const all = residents(allAgents(), null, events);
  assert.equal(all[0].room.id, "terminal");
  assert.equal(all[0].doing, "Running npm test");
});

test("agents that are not in use are idle in their own rooms and say what they are for", () => {
  const all = residents(allAgents(), agentById("programmer")!, [step("1", "write", "running")]);
  for (const resident of all.filter((entry) => !entry.active)) {
    assert.equal(resident.state, "idle");
    assert.equal(resident.doing, null);
    assert.ok(resident.focus.length > 0);
    assert.equal(resident.room.id, homeRoomFor(resident.id).id);
  }
});

test("each agent appears once", () => {
  const ids = residents(allAgents(), agentById("lawyer")!, []).map((resident) => resident.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, allAgents().length);
});

test("the map lists every room, including empty ones, and places each resident once", () => {
  const all = residents(allAgents(), null, []);
  const grouped = byRoom(all);
  assert.equal(grouped.length, rooms.length);
  assert.equal(grouped.reduce((total, entry) => total + entry.residents.length, 0), all.length);
});

test("recent steps are newest first and limited", () => {
  const events = Array.from({ length: 12 }, (_, i) => step(String(i), "read", "ok"));
  const recent = recentSteps(events, 5);
  assert.equal(recent.length, 5);
  assert.equal(recent[0].event.id, "11");
});
