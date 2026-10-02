import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

// The phone linked in Phone Link: set through preferences, refused when it is
// not one of the two kinds, and reported with texting for Settings to show.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-phone-preference-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const { readPreferences } = await import("../src/services/preferences.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("the phone is set through preferences, checked, and reported with texting", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const patch = (body: unknown) => fetch(`${base}/v1/preferences`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const refused = await patch({ phone: "nokia" });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { message: string }).message, /iphone, android or null/);
    assert.equal(readPreferences().phone, null, "a refused value changes nothing");

    const before = readPreferences().personality;
    const set = (await (await patch({ phone: "iphone" })).json()) as { data: { phone: string | null; personality: string } };
    assert.equal(set.data.phone, "iphone");
    assert.equal(set.data.personality, before, "the personality is left alone");

    const messaging = (await (await fetch(`${base}/v1/messaging`)).json()) as { data: { texts: { phone: string | null } } };
    assert.equal(messaging.data.texts.phone, "iphone");

    const cleared = (await (await patch({ phone: null })).json()) as { data: { phone: string | null } };
    assert.equal(cleared.data.phone, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
