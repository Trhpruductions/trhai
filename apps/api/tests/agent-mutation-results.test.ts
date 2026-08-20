import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, withMutationResults } from "../src/services/agentLoop.js";
import type { ToolContext } from "../src/services/agentTools.js";
import type { LocalModelConfig } from "../src/services/localModel.js";

// Caught live: asked to build a support-ticket tracker, build_app wrote a
// real project and verified it — "9/9 checks passed" — and the model's final
// answer described entirely different files that were never written (db.js,
// app.js, ticket-form.js) and never mentioned the verification at all. The
// build was correct; the report of it was invented.

const testWorkspace = mkdtempSync(path.join(tmpdir(), "ascend-mutation-"));
process.env.ASCEND_WORKSPACE = testWorkspace;

const context: ToolContext = { memories: [], knowledge: [] };

test("a fabricated answer still carries the real mutation result", () => {
  const real = 'Built "Ticket Tracker" in the workspace at ticket-tracker/ with 6 files, '
    + "and verified it: 9/9 checks passed";
  const hallucinated = "The app uses db.js, app.js and ticket-form.js to manage tickets.";

  const combined = withMutationResults(hallucinated, [real]);

  assert.match(combined, /db\.js/, "the model's own words are kept");
  assert.match(combined, /9\/9 checks passed/, "the real result is present too");
});

test("a result the model already relayed verbatim is not duplicated", () => {
  const real = "Saved: my billing database is Postgres 16";
  const text = withMutationResults(`Done. ${real}`, [real]);

  assert.equal((text.match(/Saved: my billing database is Postgres 16/g) ?? []).length, 1);
});

test("nothing is appended when there was nothing that mutated state", () => {
  assert.equal(withMutationResults("Two plus two is four.", []), "Two plus two is four.");
});

test("an empty model reply still carries the real result", () => {
  // The failure case is exactly this: the model says nothing useful of its
  // own, or something unrelated, and the real fact must not be lost either way.
  assert.equal(withMutationResults("", ["Saved: x"]), "Saved: x");
});

test("more than one mutation in a turn all survive", () => {
  const text = withMutationResults("ok", ["Saved: x", "Deleted: y"]);
  assert.match(text, /Saved: x/);
  assert.match(text, /Deleted: y/);
});

/**
 * A stand-in Ollama that answers with a fixed, unrelated story regardless of
 * what the tool actually reported — reproducing the live failure exactly.
 */
function fakeModelThatIgnoresToolResults() {
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    let turn = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        turn += 1;
        response.writeHead(200, { "Content-Type": "application/json" });

        if (turn === 1) {
          response.end(JSON.stringify({
            model: "llama3.1:8b",
            message: {
              content: "",
              tool_calls: [{ function: { name: "write_file", arguments: { path: "x.txt", content: "hi" } } }]
            }
          }));
          return;
        }

        // Ignores the real tool result entirely and narrates something else,
        // exactly as observed live.
        response.end(JSON.stringify({
          model: "llama3.1:8b",
          message: {
            content: "The app uses db.js, app.js and ticket-form.js to manage tickets."
          }
        }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

test("the real result survives end to end through runAgent, not just the helper", async () => {
  const { server, baseUrl } = await fakeModelThatIgnoresToolResults();
  const config: LocalModelConfig = { baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };

  try {
    const result = await runAgent(config, "write a file", {
      ...context,
      saveDocument: () => true,
      // write_file has no saveDocument path; it goes through workspace.ts
      // directly, so no context stub is needed for it to actually write.
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    // The hallucinated narrative is still there — it is not suppressed, only
    // supplemented — and the real, verifiable fact is present alongside it.
    assert.match(result.text, /db\.js/);
    assert.match(result.text, /Wrote x\.txt/);
  } finally {
    server.close();
  }
});
