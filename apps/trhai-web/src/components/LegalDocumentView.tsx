"use client";

import { type MouseEvent, type ReactNode } from "react";
import {
  isLegalDocId, parseLegalInline, sectionAnchor,
  type LegalBlock, type LegalDocId, type LegalDocument, type LegalInline
} from "@ascend/shared";
import "./legal.css";

// A legal text, read from its data and shown as a page.
//
// Nothing here treats a string as markup: every span becomes an element and every string
// a text child, as in Markdown.tsx. A fact the owner has not supplied is drawn as an open
// item - set apart, in words - never as a gap or as something made up.
//
// The app lives at one address and keeps its place in the hash (#settings/legal), so a
// link that scrolls within a text must not change the hash: those are buttons in links'
// clothing, handled here, and a link to another text asks the host to open it.

function Spans({ nodes, onOpenDoc }: { nodes: LegalInline[]; onOpenDoc: (id: LegalDocId) => void }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text": return <span key={index}>{node.text}</span>;
      case "code": return <code key={index} className="legal-code">{node.text}</code>;
      case "bold": return <strong key={index}><Spans nodes={node.children} onOpenDoc={onOpenDoc} /></strong>;
      case "italic": return <em key={index}><Spans nodes={node.children} onOpenDoc={onOpenDoc} /></em>;
      case "open": return <mark key={index} className="legal-open">[To be supplied: {node.label}]</mark>;
      case "link": {
        const target = /^#legal-(.+)$/.exec(node.href)?.[1];
        if (target && isLegalDocId(target)) {
          return (
            <a key={index} href={node.href} className="legal-link"
              onClick={(event) => { event.preventDefault(); onOpenDoc(target); }}>
              <Spans nodes={node.children} onOpenDoc={onOpenDoc} />
            </a>
          );
        }
        return (
          <a key={index} href={node.href} className="legal-link" target="_blank" rel="noreferrer noopener">
            <Spans nodes={node.children} onOpenDoc={onOpenDoc} />
          </a>
        );
      }
    }
  });
}

function Text({ value, onOpenDoc }: { value: string; onOpenDoc: (id: LegalDocId) => void }) {
  return <Spans nodes={parseLegalInline(value)} onOpenDoc={onOpenDoc} />;
}

function Block({ block, onOpenDoc, showReviewNotes }: { block: LegalBlock; onOpenDoc: (id: LegalDocId) => void; showReviewNotes: boolean }) {
  if (block.kind === "p") return <p><Text value={block.text} onOpenDoc={onOpenDoc} /></p>;
  if (block.kind === "note") {
    if (block.tone === "review" && !showReviewNotes) return null;
    return (
      <aside className={`legal-note ${block.tone}`}>
        <strong>{block.tone === "review" ? "For legal review. " : "In short. "}</strong>
        <Text value={block.text} onOpenDoc={onOpenDoc} />
      </aside>
    );
  }
  if (block.kind === "list") {
    const items = block.items.map((item, index) => <li key={index}><Text value={item} onOpenDoc={onOpenDoc} /></li>);
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
  }
  // A table wider than the screen scrolls inside its own box, which can be reached and
  // scrolled with the keyboard because it is focusable and named.
  return (
    <div className="legal-table-wrap" role="region" aria-label={block.caption} tabIndex={0}>
      <table>
        <caption><Text value={block.caption} onOpenDoc={onOpenDoc} /></caption>
        <thead>
          <tr>{block.head.map((cell, index) => <th key={index} scope="col"><Text value={cell} onOpenDoc={onOpenDoc} /></th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => index === 0
                ? <th key={index} scope="row"><Text value={cell} onOpenDoc={onOpenDoc} /></th>
                : <td key={index}><Text value={cell} onOpenDoc={onOpenDoc} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegalDocumentView({ doc, onOpenDoc, showReviewNotes, headingId }: {
  doc: LegalDocument;
  onOpenDoc: (id: LegalDocId) => void;
  /** Points for the lawyer, shown while the texts are a draft. */
  showReviewNotes: boolean;
  /** The id the page's own title carries, for a dialog to name itself by. */
  headingId?: string;
}) {
  const jump = (anchor: string) => (event: MouseEvent) => {
    event.preventDefault();
    const heading = document.getElementById(anchor);
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  };

  return (
    <article className="legal-doc" aria-labelledby={headingId ?? `${doc.id}-title`}>
      <h2 className="legal-title" id={headingId ?? `${doc.id}-title`}>{doc.title}</h2>
      <p className="legal-meta">{doc.version ? `Version ${doc.version}. ` : ""}In effect from {doc.effective}.</p>
      <p className="legal-summary"><Text value={doc.summary} onOpenDoc={onOpenDoc} /></p>
      <nav className="legal-toc" aria-label={`In ${doc.title}`}>
        <ol>
          {doc.sections.map((section) => {
            const anchor = sectionAnchor(doc, section);
            return <li key={section.id}><a href={`#${anchor}`} onClick={jump(anchor)}>{section.heading}</a></li>;
          })}
        </ol>
      </nav>
      {doc.sections.map((section) => {
        const anchor = sectionAnchor(doc, section);
        return (
          <section key={section.id} aria-labelledby={anchor} className="legal-section">
            <h3 id={anchor} tabIndex={-1}>{section.heading}</h3>
            {section.blocks.map((block, index) => <Block key={index} block={block} onOpenDoc={onOpenDoc} showReviewNotes={showReviewNotes} />)}
          </section>
        );
      })}
    </article>
  );
}
