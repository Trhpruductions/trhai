import test from "node:test";
import assert from "node:assert/strict";
import { childEnvironment, isOwnSecretVariable } from "../src/services/childEnv.js";

// A program TRH AI starts - a command, an app the model wrote - gets the person's
// environment, not the service's secrets.

test("the service's own keys are left out of a child's environment, and everything else is kept", () => {
  const base = {
    PATH: "C:\\Windows",
    HOME: "C:\\Users\\sam",
    TRHAI_DATA_KEY: "the-data-key",
    TRHAI_ENGINE_API_KEY: "engine-key",
    trhai_engine_api_key: "engine-key-lower",
    ASSIST_SMTP_PASSWORD: "mail-pass",
    ASCEND_WEBHOOK_SECRET: "hook",
    VEXORA_PIPER_DIR: "C:\\piper",
    TRHAI_RUNTIME_DIR: "C:\\runtime",
    ASSIST_ACCOUNTS_FILE: "C:\\data\\accounts.json",
    GITHUB_TOKEN: "the-persons-own-token",
    EMPTY: undefined
  };
  const env = childEnvironment(base);
  assert.deepEqual(Object.keys(env).sort(), ["ASSIST_ACCOUNTS_FILE", "GITHUB_TOKEN", "HOME", "PATH", "TRHAI_RUNTIME_DIR", "VEXORA_PIPER_DIR"]);
  assert.equal(env.GITHUB_TOKEN, "the-persons-own-token", "the person's own variables are theirs, as in their own shell");
  assert.ok(!JSON.stringify(env).includes("the-data-key"));
  assert.ok(!JSON.stringify(env).includes("engine-key"));
  assert.ok(!JSON.stringify(env).includes("mail-pass"));
});

test("which names count as the service's own secrets", () => {
  for (const name of ["TRHAI_DATA_KEY", "trhai_data_key", "TRHAI_ENGINE_API_KEY", "ASSIST_MAIL_PASSWORD", "ASCEND_ACCESS_TOKEN", "VEXORA_SIGNING_SECRET", "TRHAI_LICENSE_PRIVATE_KEY"]) {
    assert.equal(isOwnSecretVariable(name), true, name);
  }
  for (const name of ["PATH", "TRHAI_RUNTIME_DIR", "TRHAI_MODEL", "ASSIST_ACCOUNTS_FILE", "ACME_VENDOR_API_KEY", "AWS_SECRET_ACCESS_KEY", "KEYBOARD_LAYOUT"]) {
    assert.equal(isOwnSecretVariable(name), false, name);
  }
});
