import assert from "node:assert/strict";

/**
 * A strict enough check that a piece of XML is well formed: the declaration at
 * the start, every start tag closed by its own end tag in order, attributes
 * quoted and not repeated, only the five escapes (and numeric ones) after an
 * ampersand, no bare "<" in text. It is not a validator of any schema - the
 * tests read the files with real readers for that - but a writer that gets
 * escaping or nesting wrong is caught here, with the position.
 */
export function assertWellFormed(xml: string, label = "xml"): void {
  const where = (at: number) => `${label}, near: ${JSON.stringify(xml.slice(Math.max(0, at - 30), at + 40))}`;
  let at = 0;
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    assert.ok(end > 0, `${label}: the declaration is not closed`);
    at = end + 2;
  }
  const open: string[] = [];
  let sawRoot = false;
  while (at < xml.length) {
    if (xml[at] !== "<") {
      const next = xml.indexOf("<", at);
      const text = xml.slice(at, next < 0 ? xml.length : next);
      assert.ok(open.length > 0 || text.trim() === "", `${label}: text outside the root element: ${where(at)}`);
      for (const match of text.matchAll(/&([^;\s]*);?/g)) assert.match(match[0], /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/, `a bad escape in ${where(at + (match.index ?? 0))}`);
      at = next < 0 ? xml.length : next;
      continue;
    }
    const end = xml.indexOf(">", at);
    assert.ok(end > 0, `${label}: a tag is not closed: ${where(at)}`);
    const tag = xml.slice(at + 1, end);
    assert.ok(!tag.includes("<"), `${label}: a "<" inside a tag: ${where(at)}`);
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      assert.equal(open.pop(), name, `${label}: </${name}> does not close the element that is open: ${where(at)}`);
    } else {
      assert.ok(open.length > 0 || !sawRoot, `${label}: a second root element: ${where(at)}`);
      sawRoot = true;
      const selfClosing = tag.endsWith("/");
      const body = selfClosing ? tag.slice(0, -1) : tag;
      const name = /^[^\s/>]+/.exec(body)?.[0];
      assert.ok(name && /^[A-Za-z_][\w.:-]*$/.test(name), `${label}: a bad element name: ${where(at)}`);
      const attributes = body.slice(name.length);
      const seen = new Set<string>();
      let rest = attributes;
      while (rest.trim() !== "") {
        const match = /^\s+([^\s=]+)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(rest);
        assert.ok(match, `${label}: an attribute is malformed in <${name}>: ${where(at)}`);
        assert.ok(!seen.has(match[1]), `${label}: the attribute ${match[1]} is repeated in <${name}>`);
        seen.add(match[1]);
        for (const escape of match[2].matchAll(/&([^;\s]*);?/g)) assert.match(escape[0], /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/, `a bad escape in an attribute of <${name}>`);
        rest = rest.slice(match[0].length);
      }
      if (!selfClosing) open.push(name);
    }
    at = end + 1;
  }
  assert.deepEqual(open, [], `${label}: elements left open`);
  assert.ok(sawRoot, `${label}: no root element`);
}
