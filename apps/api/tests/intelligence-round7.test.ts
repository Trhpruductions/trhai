import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own, with known contents, before anything reads it.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-round7-"));
process.env.ASCEND_WORKSPACE = testWorkspace;
mkdirSync(path.join(testWorkspace, "calculator", "public"), { recursive: true });
writeFileSync(path.join(testWorkspace, "calculator", "server.js"), "// server\n", "utf8");
writeFileSync(path.join(testWorkspace, "notes.txt"), "first note\n", "utf8");

const { asksAboutMachineState, reshapesAnEarlierReply } = await import("../src/services/actionIntent.js");
const { isListWorkspaceRequest, parseNthThingRequest } = await import("../src/services/memoryRequests.js");
const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");
const { describeTelemetry, formatUptime } = await import("../src/services/systemTelemetry.js");

// Seventh intelligence sweep: the first live run after the model was given a
// context window its prompt fits in. Follow-ups, the transcript, the
// workspace, and the machine's own readings.

test("'what did I ask you first?' is answered from the transcript", async () => {
  // Live: searched the transcript for "first question", found nothing, and
  // answered that the question being answered was the first one asked.
  assert.equal(parseNthThingRequest("What did I ask you first?"), 1);
  assert.equal(parseNthThingRequest("what did i say first"), 1);
  assert.equal(parseNthThingRequest("what was my first question?"), 1);
  assert.equal(parseNthThingRequest("What was my second message"), 2);
  assert.equal(parseNthThingRequest("what was my last question?"), -1);
  assert.equal(parseNthThingRequest("what did I ask you to do first?"), null, "a different question");
  assert.equal(parseNthThingRequest("what should I ask first?"), null);

  const history = [
    { role: "user" as const, content: "What's the capital of Australia?" },
    { role: "assistant" as const, content: "The capital of Australia is Canberra." },
    { role: "user" as const, content: "And roughly how many people live there?" },
    { role: "assistant" as const, content: "About 470,000." }
  ];
  const reply = await runAssistantOrchestrator({
    mode: "general", userMessage: "What did I ask you first?", sessionId: "round7-first", history
  });
  assert.equal(reply.strategy, "recap", reply.assistantMessage);
  assert.match(reply.assistantMessage, /What's the capital of Australia\?/);
});

test("a request to list the workspace is answered with its top level, by the app", async () => {
  // Live: the model listed the workspace, then listed calculator/ in the same
  // reply that already held the answer, and reported the calculator's files as
  // "the files in your workspace".
  for (const request of ["list the files in my workspace", "What's in my workspace?", "show me my workspace",
    "what files are in my workspace?", "list everything in the workspace", "what files do I have?"]) {
    assert.equal(isListWorkspaceRequest(request), true, request);
  }
  for (const request of ["list the files in calculator", "what files did that create?", "list my apps",
    "is there a workspace setting for tabs?"]) {
    assert.equal(isListWorkspaceRequest(request), false, request);
  }

  const reply = await runAssistantOrchestrator({ mode: "general", userMessage: "list the files in my workspace" });
  assert.equal(reply.strategy, "list");
  assert.match(reply.assistantMessage, /2 items at the top level/);
  assert.match(reply.assistantMessage, /- calculator\//);
  assert.match(reply.assistantMessage, /- notes\.txt \(11 bytes\)/);
  assert.ok(reply.assistantMessage.includes(testWorkspace), "says which folder it listed");
  // The tool's note to the model is not shown to the person.
  assert.doesNotMatch(reply.assistantMessage, /recursive: true/);
  assert.doesNotMatch(reply.assistantMessage, /server\.js/, "the top level, not inside the folders");
});

test("reshaping the last answer is recognised, and asking for a file is not", () => {
  for (const request of ["Make that answer one sentence.", "make it shorter", "say that again more simply",
    "translate that to French", "can you rephrase that?", "put it in bullet points", "make your last answer shorter"]) {
    assert.equal(reshapesAnEarlierReply(request), true, request);
  }
  for (const request of ["make that into a file called summary.txt", "save that as a document", "make it an app",
    "make me a todo app", "write a haiku about autumn", "make the button blue in index.html"]) {
    assert.equal(reshapesAnEarlierReply(request), false, request);
  }
});

test("questions about the machine are told apart from ones that only sound like it", () => {
  for (const request of ["what's my CPU usage right now?", "how much RAM am I using?", "how much memory is in use?",
    "how hot is my GPU?", "is my graphics card busy?", "how much free space is on drive C?", "how full is my disk?",
    "how long has my computer been on?", "what's my download speed?", "how's my PC doing?"]) {
    assert.equal(asksAboutMachineState(request), true, request);
  }
  for (const request of ["what's in your memory?", "what do you remember about me?", "what's the temperature in Paris?",
    "write a haiku about autumn", "how much space does a tent take?", "list my apps"]) {
    assert.equal(asksAboutMachineState(request), false, request);
  }
});

test("a reading that could not be taken says so, and why", () => {
  const text = describeTelemetry({
    cpu: { model: "Test CPU", cores: 8, speedMhz: 0, fraction: null, detail: "", unavailable: "No processor time elapsed between samples." },
    memory: { fraction: 0.5, detail: "8.0 / 16.0 GB", unavailable: null },
    gpu: {
      name: null, fraction: null, detail: "", unavailable: "No NVIDIA GPU detected on this machine.",
      vram: null, temperatureC: null, clockMhz: null, powerWatts: null
    },
    cloud: { services: [], detail: "" },
    disk: { fraction: null, detail: "", unavailable: "x" },
    network: { fraction: null, detail: "↓92k  ↑5k/s", unavailable: null, receivedBytesPerSecond: 92000, sentBytesPerSecond: 5000 },
    uptimeSeconds: 600,
    takenAt: new Date(0).toISOString()
  }, { label: "Q:", space: null });

  assert.match(text, /^Processor: no reading - no processor time elapsed between samples\.$/m);
  assert.match(text, /^Memory: 8\.0 \/ 16\.0 GB in use \(50%\)\.$/m);
  assert.match(text, /^Graphics card: no reading - no NVIDIA GPU detected on this machine\.$/m);
  assert.match(text, /^Drive Q: no reading - that drive could not be measured\.$/m);
  assert.match(text, /^Network: ↓92k ↑5k\/s\.$/m);
  assert.match(text, /^Up for: 10 minutes\.$/m);
  // No number appears for anything that was not read.
  assert.doesNotMatch(text, /Processor: \d|Graphics card: [^n]/);
});

test("uptime reads as a person would say it", () => {
  assert.equal(formatUptime(59), "0 minutes");
  assert.equal(formatUptime(61), "1 minute");
  assert.equal(formatUptime(3600), "1 hour");
  assert.equal(formatUptime(3 * 3600 + 5 * 60), "3 hours 5 minutes");
  assert.equal(formatUptime(86400), "1 day");
  assert.equal(formatUptime(2 * 86400 + 3600), "2 days 1 hour");
});
