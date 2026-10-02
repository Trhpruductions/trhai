import test from "node:test";
import assert from "node:assert/strict";
import { bootProgress, checkService, checkTheRest, initialSteps, type BootStep } from "../src/lib/boot.js";

type Route = (init?: RequestInit) => { status: number; body: unknown } | "down";

function fakeApi(routes: Record<string, Route>) {
  const seen: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", "");
    seen.push({ path, init });
    const route = routes[path];
    const answer = route ? route(init) : { status: 404, body: {} };
    if (answer === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, seen };
}

const healthy: Record<string, Route> = {
  "/health": () => ({ status: 200, body: { status: "ok" } }),
  "/v1/assist/model": () => ({ status: 200, body: { data: { available: true, model: "qwen2.5-coder:7b" } } }),
  "/v1/capabilities": () => ({ status: 200, body: { data: { tools: new Array(35).fill({ name: "t" }) } } }),
  "/v1/build-info": () => ({ status: 200, body: { data: { webVersion: "0.1.3" } } })
};

function collect() {
  const steps = initialSteps();
  const order: string[] = [];
  const onStep = (patch: Omit<BootStep, "label">) => {
    const step = steps.find((entry) => entry.id === patch.id);
    if (step) Object.assign(step, patch);
    if (patch.state !== "running") order.push(`${patch.id}:${patch.state}`);
  };
  return { steps, order, onStep };
}

test("the service counts as up only when its health check says so", async () => {
  assert.equal(await checkService("http://api", fakeApi(healthy).fetcher), true);
  assert.equal(await checkService("http://api", fakeApi({ "/health": () => "down" }).fetcher), false);
  assert.equal(await checkService("http://api", fakeApi({ "/health": () => ({ status: 503, body: {} }) }).fetcher), false);
});

test("each step reports what it actually found", async () => {
  const { steps, onStep } = collect();
  const findings = await checkTheRest("http://api", fakeApi(healthy).fetcher, null, onStep);

  assert.equal(findings.model, "qwen2.5-coder:7b");
  assert.equal(findings.version, "0.1.3");
  assert.equal(findings.account, null);
  const byId = Object.fromEntries(steps.map((step) => [step.id, step]));
  assert.deepEqual([byId.model.state, byId.model.detail], ["ok", "qwen2.5-coder:7b"]);
  assert.deepEqual([byId.account.state, byId.account.detail], ["ok", "Not signed in"]);
  assert.deepEqual([byId.tools.state, byId.tools.detail], ["ok", "35 tools ready"]);
});

test("no model is a warning, not a failure: the rest of the app still works", async () => {
  const { steps, onStep } = collect();
  await checkTheRest("http://api", fakeApi({
    ...healthy,
    "/v1/assist/model": () => ({ status: 200, body: { data: { available: false, reason: "nothing pulled" } } })
  }).fetcher, null, onStep);

  const model = steps.find((step) => step.id === "model");
  assert.equal(model?.state, "warn");
  assert.match(model?.detail ?? "", /memory, files and tools still work/);
});

test("a stored session is confirmed with the API, and one it refuses is marked to forget", async () => {
  const account = { id: "u1", email: "ada@example.com", displayName: "Ada", createdAt: "2026-10-01T00:00:00.000Z" };
  const good = fakeApi({ ...healthy, "/v1/auth/me": (init) =>
    (init?.headers as Record<string, string>)?.Authorization === "Bearer tok-1"
      ? { status: 200, body: { data: { account } } }
      : { status: 401, body: {} } });
  const signedIn = collect();
  const found = await checkTheRest("http://api", good.fetcher, "tok-1", signedIn.onStep);
  assert.deepEqual(found.account, account);
  assert.equal(found.sessionExpired, false);
  assert.equal(signedIn.steps.find((step) => step.id === "account")?.detail, "Signed in as Ada");

  const expired = collect();
  const gone = await checkTheRest("http://api", good.fetcher, "tok-old", expired.onStep);
  assert.equal(gone.account, null);
  assert.equal(gone.sessionExpired, true);
  assert.match(expired.steps.find((step) => step.id === "account")?.detail ?? "", /sign in again/);
});

test("progress moves only when a check has an answer", () => {
  const steps = initialSteps();
  assert.equal(bootProgress(steps, false), 0);
  steps[0].state = "running";
  assert.equal(bootProgress(steps, false), 0, "a check in flight is not progress");
  steps[0].state = "ok";
  assert.equal(bootProgress(steps, true), 0.25);
  for (const step of steps) step.state = "ok";
  assert.equal(bootProgress(steps, true), 1);
});
