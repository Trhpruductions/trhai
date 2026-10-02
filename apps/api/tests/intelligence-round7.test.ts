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

test("stopping an app is done by the app, and never stops one that was not meant", async () => {
  // Live, with the conversation in view: "stop the calculator app" was
  // answered with directions to run "npm stop" in tip-calculator, and the
  // calculator kept running.
  const stopped: string[] = [];
  const running = (projects: string[]) => projects.map((project, index) => ({
    project, port: 5000 + index, url: `http://localhost:${5000 + index}`, pid: 1, startedAt: "", output: []
  }));
  const ask = (userMessage: string, projects: string[]) => runAssistantOrchestrator({
    mode: "general", userMessage,
    stopApp: (project) => { stopped.push(project); return true; },
    runningApps: () => running(projects),
    listApps: () => ["calculator", "todo-list-app", "recipe-box"].map((name) => ({ name, running: projects.includes(name), url: null }))
  });

  const named = await ask("stop the calculator app", ["calculator", "todo-list-app"]);
  assert.equal(named.strategy, "app");
  assert.equal(named.assistantMessage, "Stopped calculator (it was at http://localhost:5000).");
  assert.deepEqual(stopped, ["calculator"]);

  // "the app", with one running: that one.
  stopped.length = 0;
  assert.match((await ask("please stop the app", ["todo-list-app"])).assistantMessage, /^Stopped todo-list-app/);
  assert.deepEqual(stopped, ["todo-list-app"]);

  // A name that matches nothing running stops nothing, even with one app up.
  stopped.length = 0;
  const wrong = await ask("stop the weather app", ["todo-list-app"]);
  assert.match(wrong.assistantMessage, /Nothing running is called "weather", so nothing was stopped\. Running now: todo-list-app\./);
  const notUp = await ask("stop the calculator app", []);
  assert.match(notUp.assistantMessage, /"calculator" is not running, so there was nothing to stop\./);
  const which = await ask("stop the app", ["calculator", "recipe-box"]);
  assert.match(which.assistantMessage, /^Which one\? Running now: calculator, recipe-box\.$/);
  assert.deepEqual(stopped, [], "nothing was stopped by any of those");
});

test("a request with no verb gets the app builders only when it names something to build", async () => {
  const { wantsSomethingBuilt } = await import("../src/services/actionIntent.js");
  for (const request of ["I need a task tracker", "make a snake game", "plan an app for my workouts",
    "I want a website for my bakery", "create a landing page for my band", "build me a calculator"]) {
    assert.equal(wantsSomethingBuilt(request), true, request);
  }
  // Verbatim: called plan_app three runs out of three, and once built
  // "Tonight S Stream Two Hours" into the workspace.
  for (const request of ["Plan tonight's stream: two hours of a survival game", "write a haiku about autumn",
    "give me three tips for writing clear error messages", "plan my week"]) {
    assert.equal(wantsSomethingBuilt(request), false, request);
  }
});

test("the shell is for requests about the machine", async () => {
  const { mentionsTheMachine } = await import("../src/services/actionIntent.js");
  for (const request of ["is anything listening on port 4000?", "what version of node is installed?", "run npm test",
    "check git status in D:/trhai", "is chrome open?", "ping google.com", "how big is my downloads folder?", "what's my IP address?"]) {
    assert.equal(mentionsTheMachine(request), true, request);
  }
  // Verbatim live requests that ran commands nobody asked for.
  for (const request of ["Plan tonight's stream: two hours of a survival game",
    "Give me three openings for a blog post about learning to code at 40", "write a haiku about autumn",
    "give me a name for my cat", "What's the capital of Australia?"]) {
    assert.equal(mentionsTheMachine(request), false, request);
  }
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
  // Bytes, said as bytes: the dashboard's "↓92k" was once retold as kilobits.
  assert.match(text, /^Network: receiving 92 KB\/s \(kilobytes per second\), sending 5 KB\/s \(kilobytes per second\)\.$/m);
  assert.match(text, /^Up for: 10 minutes\.$/m);
  // No number appears for anything that was not read.
  assert.doesNotMatch(text, /Processor: \d|Graphics card: [^n]/);
});

test("a reply's readings must be ones the machine gave", async () => {
  const { inventsAReading } = await import("../src/services/contradictedClaims.js");
  const readings = "Processor: 27% busy across 16 cores (Test CPU).\nMemory: 18.2 / 31.9 GB in use (57%).\n"
    + "Graphics card: Test GPU, 12% busy, video memory 5.9 / 8.0 GB (74%), 48°C.\n"
    + "Drive C: 1,645.85 GB free of 3.64 TB (55% used).\nUp for: 3 days 4 hours.";

  // Verbatim inventions from the live run.
  assert.equal(inventsAReading("The CPU usage on this machine is currently at 45%.", readings), true);
  assert.equal(inventsAReading("The GPU temperature is currently at 82 degrees Celsius.", readings), true);
  assert.equal(inventsAReading("Drive C has 250 GB of free space.", readings), true);
  // Faithful, rounded or reworded.
  assert.equal(inventsAReading("Your CPU is at 27% across 16 cores.", readings), false);
  assert.equal(inventsAReading("About 6 GB of your 8 GB of video memory is in use, and it is at 48°C.", readings), false);
  assert.equal(inventsAReading("Drive C has 1,645.85 GB free.", readings), false);
  assert.equal(inventsAReading("It has been on for 3 days.", readings), false);
  assert.equal(inventsAReading("Your machine is fairly quiet right now.", readings), false, "no number, nothing to check");
});

test("a reading is told apart from advice about one", async () => {
  const { asksForAReading } = await import("../src/services/actionIntent.js");
  for (const request of ["what's my CPU usage right now?", "how hot is my GPU?", "how much free space is on drive C?"]) {
    assert.equal(asksForAReading(request), true, request);
  }
  for (const request of ["how do I lower my CPU usage?", "is my GPU too hot?", "why is my RAM so full?",
    "what's the best way to free up disk space?"]) {
    assert.equal(asksForAReading(request), false, request);
  }
});

test("a drive named in a request is the one measured", async () => {
  const { driveNamedIn } = await import("../src/services/agentTools.js");
  assert.equal(driveNamedIn("how much free space is on drive C?"), "C");
  assert.equal(driveNamedIn("is D: full?"), "D");
  assert.equal(driveNamedIn("how full is E:\\games?"), "E");
  assert.equal(driveNamedIn("how much free space do I have?"), "");
  assert.equal(driveNamedIn("I drive a car"), "", "a verb, not a drive");
});

test("a GPU temperature comes with the card's own limit when the card reports one", () => {
  // Live: "is my GPU too hot?" at 64°C got "Yes... consider shutting it down".
  const telemetry = {
    cpu: { model: "Test CPU", cores: 8, speedMhz: 0, fraction: 0.1, detail: "", unavailable: null },
    memory: { fraction: 0.5, detail: "8.0 / 16.0 GB", unavailable: null },
    gpu: {
      name: "Test GPU", fraction: 0.2, detail: "", unavailable: null,
      vram: null, temperatureC: 63, clockMhz: null, powerWatts: null
    },
    cloud: { services: [], detail: "" },
    disk: { fraction: null, detail: "", unavailable: null },
    network: { fraction: null, detail: "", unavailable: "Measuring…", receivedBytesPerSecond: null, sentBytesPerSecond: null },
    uptimeSeconds: 60,
    takenAt: new Date(0).toISOString()
  };

  assert.match(describeTelemetry(telemetry, { label: "C:", space: null }, 20),
    /Graphics card: Test GPU, 20% busy, 63°C, which is 20°C below the point where the card starts slowing itself down to stay cool \(about 83°C\)\./);
  // No margin reported, none implied.
  assert.match(describeTelemetry(telemetry, { label: "C:", space: null }), /Graphics card: Test GPU, 20% busy, 63°C\.$/m);
});

test("a command offered for the user to run, inline, is caught", async () => {
  const { narratesACommand } = await import("../src/services/agentLoop.js");
  // Verbatim, with run_command on offer.
  assert.equal(narratesACommand("The process using the most RAM is currently unknown. You can identify it by using the "
    + "Task Manager or by running the command `tasklist /fi \"MEMUSAGE gt 1024\"` in Command Prompt."), true);
  assert.equal(narratesACommand("To check, run `netstat -ano | findstr :4000` and look for LISTENING."), true);
  // A tool's name, or how to start what was just built, is not that.
  assert.equal(narratesACommand("I used the `calculate` tool for that."), false);
  assert.equal(narratesACommand("Run `npm start` in the app's folder to launch it."), false);
  assert.equal(narratesACommand("The setting is called `maxRetries`."), false);
});

test("memory is summed per program, whatever the locale writes its numbers with", async () => {
  const { parsePs, parseTasklist } = await import("../src/services/systemTelemetry.js");
  const tasklist = [
    '"chrome.exe","1200","Console","1","1,240,920 K"',
    '"chrome.exe","1300","Console","1","200.000 K"',
    '"RustDedicated.exe","4100","Console","1","643 808 K"',
    '"System Idle Process","0","Services","0","8 K"',
    "not a row"
  ].join("\r\n");
  const programs = parseTasklist(tasklist);
  assert.deepEqual(programs.map((program) => [program.name, program.processes]), [["chrome", 2], ["RustDedicated", 1], ["System Idle Process", 1]]);
  assert.equal(programs[0].bytes, (1240920 + 200000) * 1024);

  const ps = parsePs("node 51200\nnode 20480\npostgres 10240\n");
  assert.deepEqual(ps.map((program) => [program.name, program.bytes / 1024, program.processes]), [["node", 71680, 2], ["postgres", 10240, 1]]);
});

test("the readings name the programs holding the most memory", () => {
  const text = describeTelemetry({
    cpu: { model: "Test CPU", cores: 8, speedMhz: 0, fraction: 0.1, detail: "", unavailable: null },
    memory: { fraction: 0.5, detail: "8.0 / 16.0 GB", unavailable: null },
    gpu: { name: null, fraction: null, detail: "", unavailable: "No NVIDIA GPU detected on this machine.", vram: null, temperatureC: null, clockMhz: null, powerWatts: null },
    cloud: { services: [], detail: "" },
    disk: { fraction: null, detail: "", unavailable: null },
    network: { fraction: null, detail: "", unavailable: "Measuring…", receivedBytesPerSecond: null, sentBytesPerSecond: null },
    uptimeSeconds: 60,
    takenAt: new Date(0).toISOString()
  }, { label: "C:", space: null }, null, [
    { name: "chrome", bytes: 1.5 * 1024 ** 3, processes: 14 },
    { name: "Code", bytes: 650 * 1024 ** 2, processes: 1 }
  ]);
  assert.match(text, /^Programs using the most memory: chrome 1\.5 GB \(14 processes\), Code 650\.0 MB\. Processor use per program is not measured here\.$/m);
});

test("a tool's bare name, as the whole reply, is a call when the tool needs nothing", async () => {
  // Live, the whole reply to "which process is using the most RAM?" was
  // "system_status", shown to the user as the answer.
  const { parseTextToolCalls } = await import("../src/services/agentLoop.js");
  assert.deepEqual(parseTextToolCalls("system_status"), [{ name: "system_status", arguments: {} }]);
  assert.deepEqual(parseTextToolCalls("`current_datetime`"), [{ name: "current_datetime", arguments: {} }]);
  // One that needs arguments is not guessed at, and a name in a sentence is prose.
  assert.deepEqual(parseTextToolCalls("read_file"), []);
  assert.deepEqual(parseTextToolCalls("I would use system_status for that."), []);
});

test("uptime reads as a person would say it", () => {
  assert.equal(formatUptime(59), "0 minutes");
  assert.equal(formatUptime(61), "1 minute");
  assert.equal(formatUptime(3600), "1 hour");
  assert.equal(formatUptime(3 * 3600 + 5 * 60), "3 hours 5 minutes");
  assert.equal(formatUptime(86400), "1 day");
  assert.equal(formatUptime(2 * 86400 + 3600), "2 days 1 hour");
});
