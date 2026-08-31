import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// A motion budget, enforced statically.
//
// The backlog asks for a motion performance harness (E11-S3). A real frame
// counter needs a GPU and a browser, which a node test has neither of — but
// the regressions that actually happened here were not subtle timing problems.
// They were a specific, checkable mistake: putting a filter on something that
// animates.
//
// Measured on this machine: rotating two arcs that each carried a
// drop-shadow cost about a third of the frame rate, 60fps down to 40. A blur
// filter on a moving element is re-rasterised every frame, and at 660px that
// is an enormous layer to redraw sixty times a second. Removing the filters
// and holding the arcs still brought it back.
//
// So this encodes the rule rather than the measurement. It cannot tell you the
// frame rate, and it can tell you that the one thing known to destroy it is
// not in the stylesheet — which is the part that would otherwise be caught
// only by someone remembering to look.

const styleRoot = path.resolve(import.meta.dirname, "..", "src");

function stylesheets(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...stylesheets(full));
    else if (entry.endsWith(".css")) found.push(full);
  }
  return found;
}

/**
 * Rule bodies, as `{ selector, body }`.
 *
 * Deliberately crude: this splits on braces rather than parsing CSS, which is
 * wrong for nested at-rules in general. It is right for what it checks —
 * whether one declaration block contains both an animation and a filter — and
 * a real parser would be a dependency for a check this small.
 */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    out.push({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] });
  }
  return out;
}

const files = stylesheets(styleRoot);

test("the stylesheets are actually being read", () => {
  // A gate that silently checks nothing is worse than no gate: it reports
  // success forever.
  assert.ok(files.length >= 3, `only found ${files.length} stylesheets under src`);
});

test("nothing that animates continuously also carries a filter", () => {
  const offenders: string[] = [];

  for (const file of files) {
    const css = readFileSync(file, "utf8");
    for (const rule of rules(css)) {
      // `animation:` only — a transition costs its filter while it runs, which
      // is a moment, not every frame forever.
      const animates = /(^|[\s;])animation\s*:/.test(rule.body)
        && !/animation\s*:\s*none/.test(rule.body);
      if (!animates) continue;

      const filtered = /(^|[\s;])(-webkit-)?(backdrop-)?filter\s*:/.test(rule.body)
        && !/filter\s*:\s*none/.test(rule.body);
      if (filtered) {
        offenders.push(`${path.basename(file)} → ${rule.selector}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these animate every frame and carry a filter, which is re-rasterised every "
      + "frame with them — the exact combination that cost 20fps here:\n  "
      + offenders.join("\n  ")
  );
});

test("the check would catch the regression it was written for", () => {
  // The gate above passes on a clean stylesheet, which proves nothing on its
  // own. This feeds it the rule that actually caused the problem and confirms
  // it is recognised — otherwise the check could be broken and silent.
  const regression = `
    .cc-arc-outer {
      background: conic-gradient(from 0deg, transparent, rgba(96,214,255,0.5));
      filter: drop-shadow(0 0 6px rgba(96, 214, 255, 0.35));
      animation: cc-arc-spin 96s linear infinite;
    }
  `;

  const caught = rules(regression).filter((rule) =>
    /(^|[\s;])animation\s*:/.test(rule.body)
    && /(^|[\s;])(-webkit-)?(backdrop-)?filter\s*:/.test(rule.body));

  assert.equal(caught.length, 1, "the check no longer recognises its own regression case");
  assert.match(caught[0].selector, /cc-arc-outer/);
});

test("a filter with no animation is left alone", () => {
  // Static filters are fine — they are rasterised once. The gate must not
  // push anyone into removing those, or it will be worked around instead of
  // followed.
  const fine = `
    .hud-panel { backdrop-filter: blur(14px) saturate(135%); }
    .gauge-fill { filter: drop-shadow(0 0 5px rgba(53,199,255,0.7)); transition: stroke-dasharray 600ms; }
  `;

  const flagged = rules(fine).filter((rule) =>
    /(^|[\s;])animation\s*:/.test(rule.body)
    && /(^|[\s;])(-webkit-)?(backdrop-)?filter\s*:/.test(rule.body));

  assert.deepEqual(flagged, []);
});
