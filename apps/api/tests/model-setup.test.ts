import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cancelSetup, downloadVerified, engineArchives, engineVariantFor, hardwareDefaults, modelCatalog, readHardware,
  recommendedModel, removeModel, resetSetupForTests, SetupCancelled, setupJob, startSetup,
  type CatalogModel, type EngineVariant, type Hardware, type PinnedFile
} from "../src/services/modelSetup.js";

// First-run setup: what this PC gets, and that nothing reaches the engine's
// folders unless it is whole and is what its makers published.

const gib = 1024 ** 3;
const smallPc: Hardware = { totalMemoryBytes: 8 * gib, cpuCores: 4, gpu: null };
const bigPc: Hardware = { totalMemoryBytes: 32 * gib, cpuCores: 16, gpu: { vendor: "nvidia", name: "RTX 4060", memoryMiB: 8188, driver: "581.29" } };

function pinned(name: string, content: Buffer, url = `https://files.example/${name}`): PinnedFile {
  return { name, url, sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

/** Serves the given files by URL, honouring Range unless told not to. */
function server(files: Record<string, Buffer>, options: { ranges?: boolean; slow?: boolean } = {}) {
  const seen: Array<{ url: string; range: string | null }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    seen.push({ url, range });
    const body = files[url];
    if (!body) return new Response("missing", { status: 404 });
    const from = range && options.ranges !== false ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const part = body.subarray(from);
    if (options.slow) {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (signal?.aborted) { controller.error(new Error("aborted")); return; }
          controller.enqueue(new Uint8Array(part.subarray(0, 4)));
        }
      });
      return new Response(stream, { status: from ? 206 : 200 });
    }
    return new Response(new Uint8Array(part), { status: from ? 206 : 200 });
  };
  return { fetcher, seen };
}

async function finished(): Promise<NonNullable<ReturnType<typeof setupJob>>> {
  for (let i = 0; i < 400; i += 1) {
    const job = setupJob();
    if (job && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("setup did not finish");
}

test("a small PC without a card gets the CPU engine, the 4B model and settings that suit it", () => {
  assert.equal(engineVariantFor(smallPc), "cpu");
  assert.equal(recommendedModel(smallPc), "qwen3-4b-instruct-2507");
  assert.deepEqual(hardwareDefaults(smallPc, {}), {
    TRHAI_CONTEXT_TOKENS: "8192", TRHAI_MODEL_TIMEOUT_MS: "600000", TRHAI_IDLE_UNLOAD_SECONDS: "1800", TRHAI_MODEL: "qwen3-4b-instruct-2507"
  });
});

test("what .env already says is never overridden", () => {
  const env = { TRHAI_MODEL: "qwen2.5-3b", TRHAI_CONTEXT_TOKENS: "4096", TRHAI_MODEL_TIMEOUT_MS: "900000", TRHAI_IDLE_UNLOAD_SECONDS: "60" };
  assert.deepEqual(hardwareDefaults(smallPc, env), {});
  assert.equal(hardwareDefaults(smallPc, { OLLAMA_MODEL: "llama3.2" }).TRHAI_MODEL, undefined);
});

test("a PC with an 8 GB card keeps the defaults and gets the 7B coder; the driver picks the CUDA build", () => {
  assert.deepEqual(hardwareDefaults(bigPc, {}), {});
  assert.equal(recommendedModel(bigPc), "qwen2.5-coder-7b");
  assert.equal(engineVariantFor(bigPc), "cuda-13.4");
  assert.equal(engineVariantFor({ gpu: { ...bigPc.gpu!, driver: "551.86" } }), "cuda-12.4");
  assert.equal(recommendedModel({ totalMemoryBytes: 16 * gib, cpuCores: 8, gpu: null }), "qwen2.5-coder-7b", "16 GB of memory runs the 7B too");
});

test("nvidia-smi's answer is read into the card; no answer means no card", () => {
  const answering = (() => ({ status: 0, stdout: "NVIDIA GeForce RTX 4060 Laptop GPU, 8188, 581.29\n" })) as unknown as Parameters<typeof readHardware>[0];
  assert.deepEqual(readHardware(answering).gpu, { vendor: "nvidia", name: "NVIDIA GeForce RTX 4060 Laptop GPU", memoryMiB: 8188, driver: "581.29" });
  const missing = (() => { throw new Error("ENOENT"); }) as unknown as Parameters<typeof readHardware>[0];
  assert.equal(readHardware(missing).gpu, null);
  const failing = (() => ({ status: 9, stdout: "" })) as unknown as Parameters<typeof readHardware>[0];
  assert.equal(readHardware(failing).gpu, null);
});

test("every download is pinned: https, a fixed release or commit, a size and a SHA-256", () => {
  const files = [...Object.values(engineArchives).flat(), ...modelCatalog.flatMap((model) => model.files)];
  for (const file of files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.name);
    assert.ok(file.sizeBytes > 1_000_000, file.name);
    assert.match(file.url, /^https:\/\/(github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\/|huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/)/, file.name);
    assert.ok(file.url.endsWith(`/${file.name}`), file.name);
  }
  assert.equal(new Set(modelCatalog.map((model) => model.id)).size, modelCatalog.length);
});

test("what is recommended may be used commercially; research-licensed models say so", () => {
  for (const hardware of [smallPc, bigPc]) {
    const model = modelCatalog.find((entry) => entry.id === recommendedModel(hardware));
    assert.ok(model?.license.commercialUse, `${model?.id} is recommended`);
  }
  for (const model of modelCatalog.filter((entry) => !entry.license.commercialUse)) {
    assert.match(model.license.name, /non-commercial/);
    assert.match(model.summary, /personal use only/);
  }
});

test("a download that matches is put in place, and nothing is left behind", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-dl-"));
  const content = Buffer.from("a whole model file, exactly as published");
  const file = pinned("model.gguf", content);
  const { fetcher } = server({ [file.url]: content });
  let last = 0;
  await downloadVerified(file, path.join(dir, "model.gguf"), { fetcher: fetcher as never, onProgress: (done) => { last = done; } });
  assert.deepEqual(readFileSync(path.join(dir, "model.gguf")), content);
  assert.equal(existsSync(path.join(dir, "model.gguf.part")), false);
  assert.equal(last, content.length);
});

test("a download that does not match is deleted, not installed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-dl-"));
  const content = Buffer.from("what the makers published");
  const file = pinned("model.gguf", content);
  const { fetcher } = server({ [file.url]: Buffer.from("something else, same size!") .subarray(0, content.length) });
  await assert.rejects(downloadVerified(file, path.join(dir, "model.gguf"), { fetcher: fetcher as never }), /did not match/);
  assert.equal(existsSync(path.join(dir, "model.gguf")), false);
  assert.equal(existsSync(path.join(dir, "model.gguf.part")), false);
});

test("a download that stopped part-way carries on from where it stopped", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-dl-"));
  const content = Buffer.from("0123456789".repeat(50));
  const file = pinned("model.gguf", content);
  writeFileSync(path.join(dir, "model.gguf.part"), content.subarray(0, 200));
  const { fetcher, seen } = server({ [file.url]: content });
  await downloadVerified(file, path.join(dir, "model.gguf"), { fetcher: fetcher as never });
  assert.equal(seen[0].range, "bytes=200-");
  assert.deepEqual(readFileSync(path.join(dir, "model.gguf")), content);
});

test("a server that ignores the range is answered by starting over", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-dl-"));
  const content = Buffer.from("abcdefghij".repeat(40));
  const file = pinned("model.gguf", content);
  writeFileSync(path.join(dir, "model.gguf.part"), content.subarray(0, 120));
  const { fetcher } = server({ [file.url]: content }, { ranges: false });
  await downloadVerified(file, path.join(dir, "model.gguf"), { fetcher: fetcher as never });
  assert.deepEqual(readFileSync(path.join(dir, "model.gguf")), content);
});

test("a server error is reported in a sentence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-dl-"));
  const file = pinned("gone.gguf", Buffer.from("x"));
  const { fetcher } = server({});
  await assert.rejects(downloadVerified(file, path.join(dir, "gone.gguf"), { fetcher: fetcher as never }), /server answered 404/);
});

test("stopping a download keeps what arrived, to carry on from", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-dl-"));
  const content = Buffer.alloc(4000, 7);
  const file = pinned("model.gguf", content);
  const { fetcher } = server({ [file.url]: content }, { slow: true });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 120);
  await assert.rejects(downloadVerified(file, path.join(dir, "model.gguf"), { fetcher: fetcher as never, signal: stop.signal }), SetupCancelled);
  assert.equal(existsSync(path.join(dir, "model.gguf")), false);
  assert.ok(statSync(path.join(dir, "model.gguf.part")).size > 0);
});

function fakeRelease(root: string) {
  const engineZip = Buffer.from("pretend llama.cpp archive");
  const weights = Buffer.from("pretend 4B weights");
  const visionMain = Buffer.from("pretend vision weights");
  const visionProjector = Buffer.from("pretend projector");
  const engineFile = pinned("llama-test-bin-win-cpu-x64.zip", engineZip);
  const catalog: CatalogModel[] = [
    { ...modelCatalog[0], id: "tiny-chat", files: [pinned("Tiny-Q4_K_M.gguf", weights)] },
    { ...modelCatalog[3], id: "tiny-vl", vision: true, files: [pinned("Tiny-VL-Q4_K_M.gguf", visionMain), pinned("mmproj-Tiny-VL.gguf", visionProjector)] }
  ];
  const engineFiles = { cpu: [engineFile], "cuda-12.4": [engineFile], "cuda-13.4": [engineFile] } as Record<EngineVariant, PinnedFile[]>;
  const files = {
    [engineFile.url]: engineZip, [catalog[0].files[0].url]: weights,
    [catalog[1].files[0].url]: visionMain, [catalog[1].files[1].url]: visionProjector
  };
  const restarts: number[] = [];
  const deps = {
    env: { TRHAI_RUNTIME_DIR: root } as NodeJS.ProcessEnv,
    hardware: smallPc,
    catalog,
    engineFiles,
    unzip: (_archive: string, into: string) => {
      mkdirSync(into, { recursive: true });
      writeFileSync(path.join(into, process.platform === "win32" ? "llama-server.exe" : "llama-server"), "engine");
    },
    restart: async (between?: () => void) => { between?.(); restarts.push(Date.now()); }
  };
  return { deps, files, restarts };
}

test("setup installs the engine and the models where the engine finds them, then restarts it once", async () => {
  resetSetupForTests();
  const root = mkdtempSync(path.join(tmpdir(), "trhai-runtime-"));
  const { deps, files, restarts } = fakeRelease(root);
  const { fetcher } = server(files);
  const started = startSetup({ engine: true, models: ["tiny-chat", "tiny-vl"] }, { ...deps, fetcher: fetcher as never });
  assert.ok(started.ok);
  assert.equal(started.job.steps.length, 3);
  const job = await finished();
  assert.equal(job.state, "done", job.error ?? "");
  assert.ok(job.steps.every((step) => step.state === "done" && step.doneBytes === step.totalBytes));
  assert.ok(existsSync(path.join(root, "engine", "b11366", process.platform === "win32" ? "llama-server.exe" : "llama-server")));
  assert.ok(existsSync(path.join(root, "models", "tiny-chat.gguf")), "one file: <id>.gguf");
  assert.ok(existsSync(path.join(root, "models", "tiny-vl", "mmproj-Tiny-VL.gguf")), "with a projector: a folder <id>");
  assert.equal(existsSync(path.join(root, "engine", "b11366.unpacking")), false);
  assert.equal(restarts.length, 1);

  // Asked again, there is nothing left to do.
  const again = startSetup({ engine: true, models: ["tiny-chat"] }, { ...deps, fetcher: fetcher as never });
  assert.ok(again.ok);
  assert.equal(again.job.steps.length, 0);
  assert.equal(again.job.state, "done");
});

test("a model that fails its check stops setup with the reason; the engine keeps what did finish", async () => {
  resetSetupForTests();
  const root = mkdtempSync(path.join(tmpdir(), "trhai-runtime-"));
  const { deps, files, restarts } = fakeRelease(root);
  const tampered = { ...files, [deps.catalog[0].files[0].url]: Buffer.from("pretend 4B weightz") };
  const { fetcher } = server(tampered);
  assert.ok(startSetup({ engine: true, models: ["tiny-chat", "tiny-vl"] }, { ...deps, fetcher: fetcher as never }).ok);
  const job = await finished();
  assert.equal(job.state, "failed");
  assert.match(job.error ?? "", /did not match/);
  assert.deepEqual(job.steps.map((step) => step.state), ["done", "failed", "cancelled"]);
  assert.equal(existsSync(path.join(root, "models", "tiny-chat.gguf")), false);
  assert.equal(restarts.length, 1, "restarted for the engine that did install");
});

test("one setup at a time, only models it knows, and stopping it is reported as stopped", async () => {
  resetSetupForTests();
  const root = mkdtempSync(path.join(tmpdir(), "trhai-runtime-"));
  const { deps, files } = fakeRelease(root);
  assert.equal(startSetup({ models: ["not-a-model"] }, deps).ok, false);
  const { fetcher } = server(files, { slow: true });
  assert.ok(startSetup({ models: ["tiny-chat"] }, { ...deps, fetcher: fetcher as never }).ok);
  const second = startSetup({ models: ["tiny-chat"] }, { ...deps, fetcher: fetcher as never });
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /already running/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cancelSetup(), true);
  const job = await finished();
  assert.equal(job.state, "cancelled");
  assert.equal(job.error, null);
  assert.equal(job.steps[0].state, "cancelled");
  assert.equal(cancelSetup(), false);
});

test("removing a model deletes only that model, while the engine is stopped", async () => {
  resetSetupForTests();
  const root = mkdtempSync(path.join(tmpdir(), "trhai-runtime-"));
  mkdirSync(path.join(root, "models", "vision-model"), { recursive: true });
  writeFileSync(path.join(root, "models", "chat.gguf"), "chat");
  writeFileSync(path.join(root, "models", "other.gguf"), "other");
  writeFileSync(path.join(root, "models", "vision-model", "weights.gguf"), "v");
  writeFileSync(path.join(root, "models", "vision-model", "mmproj-x.gguf"), "p");
  const order: string[] = [];
  const restart = async (between?: () => void) => { order.push("stopped"); between?.(); order.push("started"); };
  const env = { TRHAI_RUNTIME_DIR: root } as NodeJS.ProcessEnv;

  assert.deepEqual(await removeModel("chat", { env, restart }), { ok: true });
  assert.equal(existsSync(path.join(root, "models", "chat.gguf")), false);
  assert.ok(existsSync(path.join(root, "models", "other.gguf")));
  assert.deepEqual(order, ["stopped", "started"]);

  assert.deepEqual(await removeModel("vision-model", { env, restart }), { ok: true });
  assert.equal(existsSync(path.join(root, "models", "vision-model")), false);
  assert.ok(existsSync(path.join(root, "models")));

  const missing = await removeModel("nothing-here", { env, restart });
  assert.equal(missing.ok, false);
});
