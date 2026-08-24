import test from "node:test";
import assert from "node:assert/strict";
import { checkNeuralVoice, describeVoice, synthesizeNeural, wasCancelled } from "../src/neuralSpeech.js";

// The client side of the local neural voice.
//
// Every failure mode here has to come back as a reported reason rather than a
// throw or a silence, because the fallback path depends on being told: the
// browser voice only gets its turn if this says clearly that it could not
// speak.

const baseUrl = "http://localhost:4000";

/** A fetch that answers with one canned response. */
function stubFetch(
  response: Omit<Partial<Response>, "headers"> & {
    jsonBody?: unknown;
    blobBody?: Blob;
    responseHeaders?: Record<string, string>;
  }
) {
  return (async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    blob: async () => response.blobBody ?? new Blob([]),
    headers: { get: (name: string) => response.responseHeaders?.[name] ?? null }
  })) as unknown as typeof fetch;
}

test("an installed neural voice is reported with its name", async () => {
  const status = await checkNeuralVoice(
    stubFetch({
      jsonBody: {
        data: {
          available: true,
          voice: "en_GB-alan-medium",
          voices: [{ id: "en_GB-alan-medium", name: "Alan", locale: "en_GB", quality: "medium" }],
          maxCharacters: 2000
        }
      }
    }),
    baseUrl
  );

  assert.equal(status.available, true);
  assert.equal(status.available === true ? status.voice : "", "en_GB-alan-medium");
  assert.equal(status.available === true ? status.voices.length : 0, 1);
});

test("voice entries without an id are dropped rather than offered", async () => {
  const status = await checkNeuralVoice(
    stubFetch({
      jsonBody: {
        data: {
          available: true,
          voice: "en_GB-alan-medium",
          voices: [
            { id: "en_GB-alan-medium", name: "Alan", locale: "en_GB", quality: "medium" },
            { name: "Nameless", locale: "en_US", quality: "high" }
          ]
        }
      }
    }),
    baseUrl
  );

  // An entry with no id cannot be selected for, so listing it would put a dead
  // option in the picker.
  assert.equal(status.available === true ? status.voices.length : 0, 1);
});

test("a voice list that is not a list does not become one", async () => {
  const status = await checkNeuralVoice(
    stubFetch({ jsonBody: { data: { available: true, voice: "en_GB-alan-medium", voices: "several" } } }),
    baseUrl
  );

  assert.deepEqual(status.available === true ? status.voices : null, []);
});

test("a voice is described by accent and quality, not by a guessed gender", () => {
  const described = describeVoice({ id: "en_GB-alan-medium", name: "Alan", locale: "en_GB", quality: "medium" });

  assert.match(described, /Alan/);
  assert.match(described, /British/);
  assert.match(described, /medium quality/);
});

test("an unfamiliar locale is shown rather than hidden", () => {
  const described = describeVoice({ id: "fr_FR-siwis-low", name: "Siwis", locale: "fr_FR", quality: "low" });

  // Better to show "fr-FR" than to drop the only clue about how it will sound.
  assert.match(described, /fr-FR/);
});

test("an absent neural voice carries the API's reason, not a generic one", async () => {
  const status = await checkNeuralVoice(
    stubFetch({ jsonBody: { data: { available: false, reason: "Piper is not installed on this machine." } } }),
    baseUrl
  );

  assert.equal(status.available, false);
  // The specific reason is what tells the user whether to install the program
  // or download a voice; replacing it with "unavailable" wastes their time.
  assert.match(status.available === false ? status.reason : "", /not installed/i);
});

test("an unreachable API is unavailable, not an exception", async () => {
  const failing = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
  const status = await checkNeuralVoice(failing, baseUrl);

  // Not having the neural voice is a normal state — the browser voices still
  // work — so this must never take the interface down with it.
  assert.equal(status.available, false);
  assert.match(status.available === false ? status.reason : "", /could not reach/i);
});

test("a malformed payload is treated as unavailable rather than trusted", async () => {
  const status = await checkNeuralVoice(stubFetch({ jsonBody: { data: { available: true } } }), baseUrl);

  // available:true with no voice name is not a usable answer; believing it
  // would mean offering a voice that produces nothing.
  assert.equal(status.available, false);
});

test("synthesis returns the audio it was given", async () => {
  const blob = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])]);
  const result = await synthesizeNeural("Hello.", {}, stubFetch({ blobBody: blob }), baseUrl);

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.blob.size : 0, 4);
});

test("the voice that actually spoke comes back with the audio", async () => {
  const result = await synthesizeNeural(
    "Hello.",
    { voiceId: "en_GB-alan-medium" },
    stubFetch({
      blobBody: new Blob([new Uint8Array([1])]),
      responseHeaders: { "X-Speech-Voice": "en_GB-cori-high" }
    }),
    baseUrl
  );

  // The server falls back when a requested voice is gone. Reading which one
  // spoke is what lets the interface say so, rather than labelling the audio
  // with a voice that did not produce it.
  assert.equal(result.ok === true ? result.voice : "", "en_GB-cori-high");
});

test("a missing voice header is null rather than a guess", async () => {
  const result = await synthesizeNeural(
    "Hello.",
    { voiceId: "en_GB-alan-medium" },
    stubFetch({ blobBody: new Blob([new Uint8Array([1])]) }),
    baseUrl
  );

  // Assuming the requested voice was used would turn an unknown into a claim.
  assert.equal(result.ok === true ? result.voice : "unset", null);
});

test("empty audio is a failure, not a successful silence", async () => {
  const result = await synthesizeNeural("Hello.", {}, stubFetch({ blobBody: new Blob([]) }), baseUrl);

  // Silence that reports success is the exact failure this codebase refuses:
  // the user would press the button, hear nothing, and be told it worked.
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /no audio/i);
});

test("a service error surfaces the API's own message", async () => {
  const result = await synthesizeNeural(
    "Hello.",
    {},
    stubFetch({ ok: false, status: 503, jsonBody: { message: "Piper is not installed on this machine." } }),
    baseUrl
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /not installed/i);
});

test("an error body that is not JSON still fails cleanly", async () => {
  const broken = (async () => ({
    ok: false,
    status: 500,
    json: async () => { throw new SyntaxError("not JSON"); },
    blob: async () => new Blob([])
  })) as unknown as typeof fetch;

  const result = await synthesizeNeural("Hello.", {}, broken, baseUrl);

  assert.equal(result.ok, false);
  assert.ok((result.ok === false ? result.reason : "").length > 0);
});

test("a cancelled request is distinguishable from a real failure", async () => {
  const aborting = (async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  }) as unknown as typeof fetch;

  const result = await synthesizeNeural("Hello.", {}, aborting, baseUrl);

  assert.equal(result.ok, false);
  // The difference matters: a real failure should fall back to the browser
  // voice, while a cancellation means the user asked for silence and getting
  // the browser voice instead would be the opposite of what they wanted.
  assert.equal(wasCancelled(result), true);
});

test("a genuine failure is not mistaken for a cancellation", async () => {
  const result = await synthesizeNeural(
    "Hello.",
    {},
    stubFetch({ ok: false, status: 503, jsonBody: { message: "Piper exited with code 1." } }),
    baseUrl
  );

  assert.equal(wasCancelled(result), false);
});

test("the rate is sent so the model paces itself rather than the player", async () => {
  let sentBody: string | undefined;
  const capturing = (async (_url: string, init?: RequestInit) => {
    sentBody = init?.body as string;
    return { ok: true, status: 200, json: async () => ({}), blob: async () => new Blob([new Uint8Array([1])]) };
  }) as unknown as typeof fetch;

  await synthesizeNeural("Hello.", { rate: 1.1 }, capturing, baseUrl);

  // Speeding up playback in the browser would shift the pitch and undo the
  // reason for using a neural voice; the model has to do the pacing.
  assert.equal(JSON.parse(sentBody ?? "{}").rate, 1.1);
});

test("the chosen voice and the personality's cadence both reach the server", async () => {
  let sentBody: string | undefined;
  const capturing = (async (_url: string, init?: RequestInit) => {
    sentBody = init?.body as string;
    return { ok: true, status: 200, json: async () => ({}), blob: async () => new Blob([new Uint8Array([1])]) };
  }) as unknown as typeof fetch;

  await synthesizeNeural(
    "Hello.",
    { voiceId: "en_GB-alan-medium", cadence: "deliberate", expressiveness: 0.7 },
    capturing,
    baseUrl
  );

  assert.deepEqual(JSON.parse(sentBody ?? "{}"), {
    text: "Hello.",
    voiceId: "en_GB-alan-medium",
    // Cadence is what makes one personality sound different from another;
    // dropping it here would leave every profile sounding identical.
    cadence: "deliberate",
    expressiveness: 0.7
  });
});
