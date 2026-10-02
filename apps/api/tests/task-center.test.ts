import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// The Task center: the work TRH AI has finished and how each piece went, what
// is running right now, and every run of every schedule. Every store is
// pointed at a scratch directory before anything that reads it is imported.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-task-center-"));
process.env.ASSIST_TASK_FILE = path.join(dataDir, "tasks.json");
process.env.ASSIST_TASK_HISTORY_FILE = path.join(dataDir, "task-history.json");
process.env.ASSIST_SCHEDULE_FILE = path.join(dataDir, "schedules.json");
process.env.ASSIST_TASKS_FILE = path.join(dataDir, "todo.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const { getTask, isTaskRunning, markTaskRunning, recordTask, resetTasks, updateTask } = await import("../src/services/taskStore.js");
const {
  archiveIfInterrupted, clearFinishedTasks, forgetFinishedTask, listFinishedTasks, maxFinishedPerSession,
  recordFinishedTask, reloadTaskHistoryFromDisk, resetTaskHistory, runTrackedTask, stepsSince
} = await import("../src/services/taskHistory.js");
const { beginEvent, endEvent, recordEvent, resetExecutionLog } = await import("../src/services/executionLog.js");
const {
  addSchedule, claimRun, listScheduleRuns, maxRunsKept, recordRun, reloadSchedulesFromDisk, removeSchedule, resetSchedules
} = await import("../src/services/scheduleStore.js");
const { runScheduleNow } = await import("../src/services/scheduler.js");
const { resetAccounts } = await import("../src/services/accounts.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function fresh(): void {
  resetTasks();
  resetTaskHistory();
  resetExecutionLog();
}

/** A task as the orchestrator leaves it after its turn. */
function finish(key: string, request: string, update: Parameters<typeof updateTask>[1]) {
  recordTask(key, { request, taskType: "create", status: "executing" });
  const ended = updateTask(key, update);
  assert.ok(ended);
  return ended;
}

// ---- the history ------------------------------------------------------------

test("a finished task is kept with its result, the tools it ran and the steps it took", () => {
  fresh();
  const since = new Date(Date.now() - 1000).toISOString();
  recordTask("th-a", { request: "Build a notes app", taskType: "create", status: "executing" });
  const writing = beginEvent("th-a", "write", "Writing index.html");
  endEvent("th-a", writing, "ok", "312 bytes", "notes-app/index.html");
  recordEvent("th-a", "test", "Running its smoke test", "failed", "1 of 3 checks failed");
  const ended = updateTask("th-a", { status: "succeeded", toolsUsed: ["build_app"], lastResult: "Built notes-app." });
  assert.ok(ended);

  recordFinishedTask("th-a", ended, stepsSince("th-a", since));

  const [kept] = listFinishedTasks("th-a");
  assert.equal(kept.status, "succeeded");
  assert.equal(kept.request, "Build a notes app");
  assert.equal(kept.result, "Built notes-app.");
  assert.deepEqual(kept.toolsUsed, ["build_app"]);
  assert.deepEqual(kept.steps.map((step) => [step.label, step.status]), [
    ["Writing index.html", "ok"], ["Running its smoke test", "failed"]
  ]);
  assert.equal(kept.steps[0].artifact, "notes-app/index.html");
  assert.equal(typeof kept.steps[0].durationMs, "number", "a finished step says how long it took");
});

test("a task still running has not finished, and is not kept", () => {
  fresh();
  recordTask("th-b", { request: "Fix the router", taskType: "fix", status: "executing" });
  const current = getTask("th-b");
  assert.ok(current);
  assert.equal(recordFinishedTask("th-b", current, []), null);
  assert.deepEqual(listFinishedTasks("th-b"), []);
});

test("a resumed task is the same entry: back on top, its steps carried over, the old error gone", () => {
  fresh();
  const blocked = finish("th-c", "Summarise the logs", { status: "blocked", error: "No local model was available to run this." });
  recordFinishedTask("th-c", blocked, [{ id: "x1", kind: "read", label: "Reading the logs", status: "ok", startedAt: new Date().toISOString() }]);
  const other = finish("th-c", "Something else", { status: "succeeded", lastResult: "Done." });
  recordFinishedTask("th-c", other, []);

  // "continue": the blocked task is resumed, under its own id, and succeeds.
  const resumed = { ...blocked, status: "succeeded" as const, lastResult: "Three errors, all from the disk check." };
  recordFinishedTask("th-c", resumed, [{ id: "x2", kind: "verify", label: "Checking the summary", status: "ok", startedAt: new Date().toISOString() }]);

  const list = listFinishedTasks("th-c");
  assert.deepEqual(list.map((entry) => entry.request), ["Summarise the logs", "Something else"]);
  assert.equal(list[0].status, "succeeded");
  assert.equal(list[0].error, undefined, "the blocked attempt's error does not follow it onto the success");
  assert.equal(list[0].result, "Three errors, all from the disk check.");
  assert.deepEqual(list[0].steps.map((step) => step.label), ["Reading the logs", "Checking the summary"]);
});

test("a task that never finished is kept as interrupted when the next replaces it - unless it is still running", () => {
  fresh();
  recordTask("th-d", { request: "Build a timer", taskType: "create", status: "executing" });

  markTaskRunning("th-d", true);
  assert.equal(archiveIfInterrupted("th-d"), null, "work genuinely under way is not interrupted");
  markTaskRunning("th-d", false);

  const kept = archiveIfInterrupted("th-d");
  assert.equal(kept?.status, "interrupted");
  assert.match(kept?.error ?? "", /never finished/);

  // A task that did finish has already been kept, as itself.
  finish("th-d", "Build a clock", { status: "succeeded", lastResult: "Done." });
  assert.equal(archiveIfInterrupted("th-d"), null);
});

test("work that throws is failed, with its reason and the steps it got through, and still throws", async () => {
  fresh();
  const since = new Date().toISOString();
  recordTask("th-e", { request: "Write the release notes", taskType: "create", status: "executing" });

  await assert.rejects(runTrackedTask("th-e", since, async () => {
    assert.equal(isTaskRunning("th-e"), true, "running while the work runs");
    recordEvent("th-e", "write", "Writing NOTES.md", "ok");
    throw new Error("The disk is full.");
  }), /disk is full/);

  assert.equal(isTaskRunning("th-e"), false, "and not after");
  assert.equal(getTask("th-e")?.status, "failed");
  const [kept] = listFinishedTasks("th-e");
  assert.equal(kept.status, "failed");
  assert.equal(kept.error, "The disk is full.");
  assert.deepEqual(kept.steps.map((step) => step.label), ["Writing NOTES.md"]);
});

test("running is counted, so two runs at once cannot clear each other", () => {
  markTaskRunning("th-f", true);
  markTaskRunning("th-f", true);
  markTaskRunning("th-f", false);
  assert.equal(isTaskRunning("th-f"), true);
  markTaskRunning("th-f", false);
  assert.equal(isTaskRunning("th-f"), false);
});

test("only this attempt's steps are kept, not the ones before it", () => {
  fresh();
  const earlier = new Date(Date.now() - 60_000);
  endEvent("th-g", beginEvent("th-g", "read", "Last run's read", earlier), "ok", undefined, undefined, earlier);
  const since = new Date().toISOString();
  recordEvent("th-g", "write", "This run's write", "ok");
  assert.deepEqual(stepsSince("th-g", since).map((event) => event.label), ["This run's write"]);
});

test("the history is capped, survives a restart, and can be cleared one entry or all at once", () => {
  fresh();
  for (let index = 0; index < maxFinishedPerSession + 3; index += 1) {
    recordFinishedTask("th-h", finish("th-h", `Task ${index}`, { status: "succeeded", lastResult: "ok" }), []);
  }
  const list = listFinishedTasks("th-h");
  assert.equal(list.length, maxFinishedPerSession);
  assert.equal(list[0].request, `Task ${maxFinishedPerSession + 2}`, "newest first");

  reloadTaskHistoryFromDisk();
  assert.equal(listFinishedTasks("th-h").length, maxFinishedPerSession, "still there after a restart");

  assert.equal(forgetFinishedTask("th-h", list[0].id), true);
  assert.equal(forgetFinishedTask("th-h", list[0].id), false);
  assert.equal(clearFinishedTasks("th-h"), maxFinishedPerSession - 1);
  assert.deepEqual(listFinishedTasks("th-h"), []);
});

// ---- schedule runs ----------------------------------------------------------

const t0 = new Date(2026, 9, 2, 8, 0, 0, 0);
const at = (minutes: number, ms = 0) => new Date(t0.getTime() + minutes * 60_000 + ms);

function remindEvery30(id: string) {
  const created = addSchedule({ id, name: "Water", action: { kind: "remind", text: "Drink some water" }, cadence: { kind: "interval", minutes: 30 }, now: t0 });
  assert.ok(created);
  return created;
}

test("each run of a schedule is logged: claimed, then finished with how long it took", () => {
  resetSchedules();
  remindEvery30("sr-a");

  claimRun("sr-a", at(30));
  assert.equal(listScheduleRuns("sr-a")?.[0].status, "interrupted", "claimed, and saying so until it reports");
  recordRun("sr-a", "ok", "Drink some water", at(30, 1500));

  const [run] = listScheduleRuns("sr-a") ?? [];
  assert.deepEqual(run, { at: at(30).toISOString(), status: "ok", detail: "Drink some water", durationMs: 1500 });
  assert.equal(listScheduleRuns("sr-a")?.length, 1, "the claim became the run, not a second entry");
});

test("a missed run is logged at the time it was due", () => {
  resetSchedules();
  const schedule = remindEvery30("sr-b");
  recordRun("sr-b", "missed", "The machine was not running when this was due.", at(95));
  const [run] = listScheduleRuns("sr-b") ?? [];
  assert.equal(run.status, "missed");
  assert.equal(run.at, schedule.nextDueAt);
  assert.equal(run.durationMs, undefined);
});

test("the run log is capped, survives a restart, keeps an unfinished run as interrupted, and goes with its schedule", () => {
  resetSchedules();
  remindEvery30("sr-c");
  for (let index = 0; index < maxRunsKept + 5; index += 1) {
    claimRun("sr-c", at(index * 30));
    recordRun("sr-c", "ok", `Run ${index}`, at(index * 30, 10));
  }
  claimRun("sr-c", at(9999));

  reloadSchedulesFromDisk();
  const runs = listScheduleRuns("sr-c") ?? [];
  assert.equal(runs.length, maxRunsKept);
  assert.equal(runs[0].status, "interrupted", "a run that never reported back still says so after a restart");
  assert.equal(runs[1].detail, `Run ${maxRunsKept + 4}`);

  assert.equal(removeSchedule("sr-c"), true);
  assert.equal(listScheduleRuns("sr-c"), null);
});

test("a schedule cannot be started a second time while its first run is still going", () => {
  resetSchedules();
  addSchedule({ id: "sr-d", name: "Flow", action: { kind: "flow" }, cadence: { kind: "interval", minutes: 60 }, now: t0 });
  // The flow run awaits before it finishes, so the second call lands mid-run.
  assert.equal(runScheduleNow("sr-d"), "started");
  assert.equal(runScheduleNow("sr-d"), "running");
  assert.equal(runScheduleNow("no-such-schedule"), "missing");
});

// ---- over HTTP --------------------------------------------------------------

async function startTestServer() {
  const server = createApp().listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function call(baseUrl: string, method: string, route: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as any : null };
}

/** A stand-in Ollama that answers every chat, so a turn reaches the agent and finishes. */
function fakeOllama() {
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        if (request.url?.startsWith("/api/tags")) {
          response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
          return;
        }
        response.end(JSON.stringify({ model: "llama3.2:latest", message: { content: "Short sentences, and say what to do next." } }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

test("a signed-in user's task, history and steps are read under their account, not the browser", async () => {
  fresh();
  resetAccounts();
  resetRateLimits();
  const model = await fakeOllama();
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = model.baseUrl;
  const server = await startTestServer();
  try {
    const registered = await call(server.baseUrl, "POST", "/v1/auth/register", { body: { email: "tasks@example.com", password: "correct horse battery" } });
    const token: string = registered.body.data.token;
    const accountKey = `user:${registered.body.data.account.id}`;

    const turn = await call(server.baseUrl, "POST", "/v1/assist", {
      token, body: { mode: "general", sessionId: "browser-a", message: "Explain what makes an error message readable." }
    });
    assert.equal(turn.status, 200);

    const current = await call(server.baseUrl, "GET", "/v1/agent-tasks?sessionId=browser-a", { token });
    assert.equal(current.body.data.tasks.length, 1, "the account's task, found from any browser it signs in on");
    assert.equal(current.body.data.tasks[0].status, "succeeded");
    assert.equal(current.body.data.tasks[0].running, false);
    assert.equal(current.body.data.tasks[0].resumable, false, "finished work is not resumed by a later \"continue\"");

    const history = await call(server.baseUrl, "GET", "/v1/agent-tasks/history?sessionId=browser-a", { token });
    assert.equal(history.body.data.history.length, 1);
    assert.equal(history.body.data.history[0].request, "Explain what makes an error message readable.");
    assert.equal(history.body.data.limit, maxFinishedPerSession);

    // The browser's own id, without the account, holds none of it.
    assert.equal((await call(server.baseUrl, "GET", "/v1/agent-tasks?sessionId=browser-a")).body.data.tasks.length, 0);
    assert.equal((await call(server.baseUrl, "GET", "/v1/agent-tasks/history?sessionId=browser-a")).body.data.history.length, 0);

    recordEvent(accountKey, "read", "Reading the style guide", "ok");
    const steps = await call(server.baseUrl, "GET", "/v1/execution?sessionId=browser-a", { token });
    assert.deepEqual(steps.body.data.events.map((event: { label: string }) => event.label), ["Reading the style guide"]);
    assert.deepEqual((await call(server.baseUrl, "GET", "/v1/execution?sessionId=browser-a")).body.data.events, []);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    await server.close();
    model.server.close();
  }
});

test("the history can be cleared over HTTP, one entry or all of it, and only by its owner", async () => {
  fresh();
  recordFinishedTask("hist-a", finish("hist-a", "First", { status: "succeeded", lastResult: "ok" }), []);
  recordFinishedTask("hist-a", finish("hist-a", "Second", { status: "failed", error: "It broke." }), []);
  const server = await startTestServer();
  try {
    const listed = await call(server.baseUrl, "GET", "/v1/agent-tasks/history?sessionId=hist-a");
    assert.deepEqual(listed.body.data.history.map((entry: { request: string }) => entry.request), ["Second", "First"]);
    const second = listed.body.data.history[0].id;

    assert.equal((await call(server.baseUrl, "DELETE", `/v1/agent-tasks/history/${second}?sessionId=hist-b`)).status, 404, "not someone else's");
    assert.equal((await call(server.baseUrl, "DELETE", `/v1/agent-tasks/history/${second}?sessionId=hist-a`)).status, 204);
    assert.equal((await call(server.baseUrl, "DELETE", "/v1/agent-tasks/history?sessionId=hist-a")).body.data.cleared, 1);
    assert.equal((await call(server.baseUrl, "GET", "/v1/agent-tasks/history?sessionId=hist-a")).body.data.history.length, 0);
    assert.equal((await call(server.baseUrl, "GET", "/v1/agent-tasks/history")).status, 400, "no identity, no history");
  } finally {
    await server.close();
  }
});

test("a schedule can be run now, its run is logged, and the list says whether it is running", async () => {
  resetSchedules();
  const server = await startTestServer();
  try {
    const created = await call(server.baseUrl, "POST", "/v1/schedules", {
      body: { name: "Stretch", action: { kind: "remind", text: "Stand up and stretch" }, cadence: { kind: "interval", minutes: 45 } }
    });
    assert.equal(created.status, 201);
    const id: string = created.body.data.schedule.id;
    assert.equal(created.body.data.schedule.running, false);

    assert.equal((await call(server.baseUrl, "POST", `/v1/schedules/${id}/run`)).status, 202);
    const runs = await call(server.baseUrl, "GET", `/v1/schedules/${id}/runs`);
    assert.equal(runs.body.data.runs.length, 1);
    assert.equal(runs.body.data.runs[0].status, "ok");
    assert.equal(runs.body.data.runs[0].detail, "Stand up and stretch");
    assert.equal(typeof runs.body.data.runs[0].durationMs, "number");

    const listed = await call(server.baseUrl, "GET", "/v1/schedules");
    const schedule = listed.body.data.schedules.find((entry: { id: string }) => entry.id === id);
    assert.equal(schedule.running, false);
    assert.equal(schedule.lastStatus, "ok");
    assert.equal("runs" in schedule, false, "the list every screen polls stays the size it was");

    assert.equal((await call(server.baseUrl, "POST", "/v1/schedules/nope/run")).status, 404);
    assert.equal((await call(server.baseUrl, "GET", "/v1/schedules/nope/runs")).status, 404);
  } finally {
    await server.close();
  }
});
