import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { beginEvent, endEvent, resetExecutionLog, listAllEvents } from "../src/services/executionLog.js";
import { noteAgentUse, readWorld, resetWorldState } from "../src/services/worldState.js";

beforeEach(() => {
  resetExecutionLog();
  resetWorldState();
});

test("with nothing happening, nobody is working and no agent is in use", () => {
  const world = readWorld();
  assert.equal(world.working, false);
  assert.equal(world.activeAgentId, null);
  assert.ok(world.residents.every((resident) => resident.state === "idle"));
  assert.equal(world.steps.length, 0);
});

test("the agent last asked for is the one that works, in the room of the step running", () => {
  noteAgentUse("programmer");
  beginEvent("s1", "test", "Running the tests");
  const world = readWorld();
  assert.equal(world.activeAgentId, "programmer");
  assert.equal(world.working, true);
  const lead = world.residents[0];
  assert.equal(lead.id, "programmer");
  assert.equal(lead.room.id, "lab");
  assert.equal(lead.doing, "Running the tests");
});

test("when the step ends, the agent goes idle", () => {
  noteAgentUse("programmer");
  const id = beginEvent("s1", "write", "Writing server.js");
  endEvent("s1", id, "ok");
  const world = readWorld();
  assert.equal(world.working, false);
  assert.equal(world.residents[0].state, "idle");
  assert.equal(world.steps.length, 1);
});

test("a request that names no agent leaves TRH AI itself to do the work", () => {
  noteAgentUse("lawyer");
  noteAgentUse(null);
  beginEvent("s1", "read", "Reading notes.txt");
  const world = readWorld();
  assert.equal(world.activeAgentId, null);
  assert.equal(world.residents[0].id, "trh-ai");
  assert.equal(world.residents[0].room.id, "library");
});

test("an agent id the catalogue does not know is no agent", () => {
  noteAgentUse("not-a-real-agent");
  assert.equal(readWorld().activeAgentId, null);
});

test("steps from every session are merged, oldest first, and limited", () => {
  const early = new Date("2026-10-10T10:00:00Z");
  const late = new Date("2026-10-10T10:05:00Z");
  beginEvent("a", "read", "first", early);
  beginEvent("b", "write", "second", late);
  const all = listAllEvents(10);
  assert.deepEqual(all.map((event) => event.label), ["first", "second"]);
  assert.equal(listAllEvents(1)[0].label, "second");
});

test("the world answers with every room and every agent, each once", () => {
  const world = readWorld();
  assert.equal(world.rooms.length, 7);
  const ids = world.residents.map((resident) => resident.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(world.byRoom.flatMap((entry) => entry.residents).length, ids.length);
});
