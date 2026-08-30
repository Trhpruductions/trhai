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
