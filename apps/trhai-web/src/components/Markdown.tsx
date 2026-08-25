"use client";

import { useState } from "react";
import { parseMarkdown, type Block, type Inline } from "@ascend/shared";
import "./markdown.css";

// Renders a parsed reply as React elements.
//
// There is no dangerouslySetInnerHTML here and there must never be one. The
// text comes from a language model, and a model can be talked into writing
// anything — so rather than escaping strings correctly and hoping, nothing is
// ever treated as markup at all. Every node below becomes an element, and
// every string becomes a text child, which React escapes by construction.
//
// The parser refuses unsafe link schemes before this sees them (see
// isSafeHref); this layer adds rel="noreferrer" so a link cannot reach back
// into the page that opened it.

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "text") return <span key={index}>{node.text}</span>;
        if (node.kind === "code") return <code key={index} className="md-code">{node.text}</code>;
        if (node.kind === "bold") return <strong key={index}><InlineNodes nodes={node.children} /></strong>;
        if (node.kind === "italic") return <em key={index}><InlineNodes nodes={node.children} /></em>;
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer noopener" className="md-link">
            <InlineNodes nodes={node.children} />
          </a>
        );
      })}
    </>
  );
}

/**
 * A code block, with a way to take the code.
 *
 * Copying is the thing people actually want from a code block in a chat
 * reply, and selecting multi-line text in a scrolling pane is fiddly. The
 * button reports what really happened rather than flashing "Copied" on faith:
 * the clipboard can be refused by the browser, and claiming success then
 * would leave someone pasting whatever was there before.
 */
function CodeBlock({ language, text }: { language: string | null; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <div className="md-block">
      <div className="md-block-head">
        <span className="md-lang">{language ?? "code"}</span>
        <button type="button" className="md-copy" onClick={() => void copy()}>
          {state === "copied" ? "copied" : state === "failed" ? "couldn't copy" : "copy"}
        </button>
      </div>
      <pre className="md-pre"><code>{text}</code></pre>
    </div>
  );
}

function BlockNode({ block }: { block: Block }) {
  if (block.kind === "code") return <CodeBlock language={block.language} text={block.text} />;

  if (block.kind === "heading") {
    const children = <InlineNodes nodes={block.children} />;
    // Levels map to real heading elements so the reply has a usable outline
    // for a screen reader, rather than styled paragraphs.
    if (block.level === 1) return <h1 className="md-h">{children}</h1>;
    if (block.level === 2) return <h2 className="md-h">{children}</h2>;
    if (block.level === 3) return <h3 className="md-h">{children}</h3>;
    if (block.level === 4) return <h4 className="md-h">{children}</h4>;
    if (block.level === 5) return <h5 className="md-h">{children}</h5>;
    return <h6 className="md-h">{children}</h6>;
  }

  if (block.kind === "list") {
    const items = block.items.map((item, index) => (
      <li key={index}><InlineNodes nodes={item} /></li>
    ));
    return block.ordered
      ? <ol className="md-list">{items}</ol>
      : <ul className="md-list">{items}</ul>;
  }

  if (block.kind === "quote") {
    return <blockquote className="md-quote"><InlineNodes nodes={block.children} /></blockquote>;
  }

  if (block.kind === "rule") return <hr className="md-rule" />;

  return <p className="md-p"><InlineNodes nodes={block.children} /></p>;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);

  // An unparseable reply is still a reply. Falling back to the raw text means
  // a model saying something the parser cannot categorise is shown as it was
  // written rather than as an empty bubble.
  if (blocks.length === 0) {
    return text.trim() ? <p className={className}>{text}</p> : null;
  }

  return (
    <div className={className ? `md ${className}` : "md"}>
      {blocks.map((block, index) => <BlockNode key={index} block={block} />)}
    </div>
  );
}
