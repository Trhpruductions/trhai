import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep the test run out of the real machine's state.
//
// Loaded before any test file, via --import in the test script, because the
// thing it protects is read when a module loads and per-file guards therefore
// run too late: ESM hoists imports, so a test file setting an environment
// variable at the top of its body has already imported the module that read it.
//
// Two failures made this necessary, in opposite directions and both real:
//
//   - Tests that disarm deleted the developer's actual grant file, so running
//     the suite silently revoked machine access from the app they were using.
//     Their assistant stopped being able to reach their files mid-task, for a
//     reason nothing on screen could explain.
//
//   - Then, with a grant in place, tests asserting "a path outside the
//     workspace is refused" found access granted and failed. A suite whose
//     result depends on whether somebody used the app that afternoon is not
//     testing the code.
//
// A throwaway file per run settles both. It is empty, so access starts off,
// which is the state every test that cares about it expects.
process.env.TRHAI_ARM_FILE = path.join(
  mkdtempSync(path.join(tmpdir(), "trhai-test-arm-")),
  "command-arm.json"
);

// The same for the machine's app data, where installed apps and devices leave
// their traces - Phone Link's linked phone, for one. The CI runner has none of
// it and a developer's PC has plenty, so a test whose stand-in missed a code
// path passed here, on the real phone, and failed only in CI (#58). An empty
// folder makes every run see what CI sees; a test that needs a device says so
// with a stand-in. (The data-key store already keeps to a temp file in tests.)
process.env.LOCALAPPDATA = mkdtempSync(path.join(tmpdir(), "trhai-test-localappdata-"));

// And the same for the model engine. With nothing set, a model request goes to
// TRH AI's own engine on this PC, which is running whenever the app is: a test
// without a stand-in would be answered by the real model, and would load it
// onto the graphics card of the PC the suite runs on. A port nothing listens
// on makes "no model" the answer wherever a test has not supplied one - what
// CI sees. Tests that restore this variable after their stand-in put this
// value back, not the real engine's address.
process.env.TRHAI_ENGINE_URL = "http://127.0.0.1:9";
