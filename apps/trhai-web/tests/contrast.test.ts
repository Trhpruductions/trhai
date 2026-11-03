import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The colour pairs the audit of 2026-11-01 measured, kept at WCAG 2.2 AA: 4.5:1 for text,
// 3:1 for a control's edge. Computed from the real tokens in the stylesheets, against the
// backgrounds those words really sit on - a translucent panel over the key art, at the
// art's typical darkness and at its brightest hundredth - so a token cannot drift back
// without this failing. The maths is WCAG's own: relative luminance and contrast ratio.

const here = path.dirname(fileURLToPath(import.meta.url));
const sheet = (file: string) => readFileSync(path.join(here, "..", "src", file), "utf8");
const os = sheet("os/os.css");
const shell = sheet("os/shell/shell.css");
const gate = sheet("components/gate.css");

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** A custom property's value, in the whole sheet or from the first `within` onwards. */
function token(css: string, name: string, within?: string): string {
  const scope = within ? css.slice(css.indexOf(within)) : css;
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(scope);
  assert.ok(match, `${name} is defined${within ? ` under ${within}` : ""}`);
  return match[1].trim();
}

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  assert.ok(rgba, `${value} is a colour this test can read`);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
}

const over = (top: Rgba, under: Rgb): Rgb => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])) as Rgb;
const solid = (value: string, under: Rgb): Rgb => over(parse(value), under);

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const atLeast = (need: number, fg: Rgb, bg: Rgb, what: string) => assert.ok(ratio(fg, bg) >= need, `${what}: ${ratio(fg, bg).toFixed(2)}:1, needs ${need}:1`);

// The key art after the work scrim, as the audit measured it: what the art typically shows
// through as, and its brightest hundredth.
const artTypical: Rgb = [2, 7, 18];
const artBright: Rgb = [9, 58, 88];
const panel = solid(token(os, "--os-surface"), artTypical);
const brightPanel = solid(token(os, "--os-surface"), artBright);
const field = over([5, 9, 18, 0.7], panel);
const accents = ["cyan", "violet", "emerald", "amber"] as const;
const accentToken = (name: string, accent: (typeof accents)[number]) => accent === "cyan" ? token(os, name) : token(os, name, `[data-accent="${accent}"]`);

test("the quietest text (text-3) reads on every surface it sits on, the art at its brightest included", () => {
  const text3 = solid(token(os, "--os-text-3"), panel);
  const grounds: Record<string, Rgb> = {
    panel,
    "a panel over the brightest art": brightPanel,
    "a row under the pointer": solid(token(os, "--os-surface-hover"), panel),
    "the solid surface": solid(token(os, "--os-surface-solid"), panel),
    "a field": field
  };
  for (const [name, ground] of Object.entries(grounds)) atLeast(4.5, text3, ground, name);
  for (const accent of accents) {
    atLeast(4.5, text3, solid(accentToken("--os-accent-soft", accent), panel), `the open row in ${accent}`);
    atLeast(4.5, text3, solid(accentToken("--os-accent-soft", accent), over([9, 14, 27, 0.97], artTypical)), `the palette's chosen row in ${accent}`);
  }
  assert.match(shell, /\.os-hints \{[^}]*color: var\(--os-text-2\)/, "the hints under the command bar sit on the art itself, so they use the louder grey");
});

test("a field's edge, resting and focused, stands out from the panel 3:1 in every accent", () => {
  atLeast(3, solid(token(os, "--os-line-field"), field), panel, "a resting field's edge");
  for (const accent of accents) {
    atLeast(3, solid(accentToken("--os-accent-line", accent), field), panel, `the ${accent} accent line, the focus edge of a search field`);
    atLeast(3, solid(accentToken("--os-accent", accent), field), panel, `the ${accent} accent, the focus edge of a field`);
  }
  assert.match(os, /\.os-input \{[^}]*border: 1px solid var\(--os-line-field\)/, "fields use the field edge");
  assert.match(os, /\.os-input:focus \{[^}]*border-color: var\(--os-accent\)/, "a focused field's edge is the accent itself");
});

test("a count on a red badge is ink, not white", () => {
  const danger = solid(token(os, "--os-danger"), panel);
  for (const [name, pattern] of [["the sidebar's red badge", /\.os-nav-badge\.danger \{[^}]*color: (#[0-9a-f]{6})/i], ["the bell's count", /\.os-bell-count \{[^}]*color: (#[0-9a-f]{6})/i]] as const) {
    const match = pattern.exec(shell);
    assert.ok(match, `${name} sets a colour`);
    atLeast(4.5, solid(match[1], danger), danger, name);
  }
});

test("the sign-in screen's quiet words and placeholders read on its card", () => {
  const card = solid(token(gate, "--g-panel"), [7, 14, 27]);
  atLeast(4.5, solid(token(gate, "--g-faint"), card), card, "the faint words (notes, hints, the divider)");
  const control = over([4, 10, 20, 0.7], card);
  const placeholder = /\.gate-control input::placeholder \{ color: (#[0-9a-f]{6}); \}/.exec(gate);
  assert.ok(placeholder, "the placeholder sets a colour");
  atLeast(4.5, solid(placeholder[1], control), control, "a placeholder");
});

test("in forced colours, state and edges are drawn with the system's own colours", () => {
  const start = os.indexOf("@media (forced-colors: active)");
  assert.ok(start >= 0, "os.css has a forced-colours block");
  const block = os.slice(start);
  for (const needle of [
    "Highlight", "HighlightText", "CanvasText", "forced-color-adjust: none",
    '.os-switch[aria-checked="true"]', '[aria-current="page"]', '[aria-selected="true"]', '[role="radio"][aria-checked="true"]',
    ":focus-visible", ".os-backdrop", ".os-nav-badge", ".os-input"
  ]) assert.ok(block.includes(needle), `the block covers ${needle}`);
});
