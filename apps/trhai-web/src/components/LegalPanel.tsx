"use client";

import { useState } from "react";
import {
  draftNotice, legalDocument, legalDocuments, legalTextsReady, legalToMarkdown, openLegalItems, type LegalDocId
} from "@ascend/shared";
import { Icon } from "../os/ui/Icon";
import { useNotify } from "../os/state/notify";
import { LegalDocumentView } from "./LegalDocumentView";
import "./legal.css";

// Settings > Legal: every text TRH AI publishes, read in place.
//
// The list and the texts come from one registry (@ascend/shared), the same one the sign-in
// screen's links, the paywall and the website export read, so this screen can never show
// a different Privacy Policy from the one a person agreed to.

export function LegalPanel({ docId, onOpen }: { docId: LegalDocId | null; onOpen: (id: LegalDocId | null) => void }) {
  const { notify } = useNotify();
  const [copied, setCopied] = useState(false);
  const draft = !legalTextsReady();
  const open = openLegalItems();

  const copyMarkdown = async (id: LegalDocId) => {
    const text = legalToMarkdown(legalDocument(id), { showReviewNotes: draft, link: (other) => `#settings/legal/${other}` });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      notify({ level: "error", title: "Could not copy", body: "The clipboard is not available here.", source: "SETTINGS" });
    }
  };

  if (docId) {
    const doc = legalDocument(docId);
    return (
      <section className="os-panel">
        <header className="os-panel-head">
          <button type="button" className="os-btn os-btn-sm" onClick={() => onOpen(null)}><Icon name="grid" size={14} />All texts</button>
          <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => void copyMarkdown(docId)} aria-live="polite">
            <Icon name="copy" size={13} />{copied ? "Copied as text" : "Copy as text"}
          </button>
        </header>
        <div className="os-panel-body">
          {draft ? <p className="legal-draft" role="note">{draftNotice}</p> : null}
          <LegalDocumentView doc={doc} onOpenDoc={onOpen} showReviewNotes={draft} />
        </div>
      </section>
    );
  }

  return (
    <>
      {draft ? (
        <section className="os-panel">
          <header className="os-panel-head"><h3 className="os-panel-title">Not yet reviewed</h3><span className="os-chip warn">Draft</span></header>
          <div className="os-panel-body os-stack">
            <p className="os-small os-dim">{draftNotice}</p>
            <p className="os-small os-dim">{open.length === 0 ? "Every fact has been supplied; a lawyer's review is what remains." : `${open.length} fact${open.length === 1 ? "" : "s"} still to be supplied by the business, shown in the texts as "to be supplied".`}</p>
          </div>
        </section>
      ) : null}
      <section className="os-panel">
        <header className="os-panel-head"><h3 className="os-panel-title">The texts</h3></header>
        <div className="os-panel-body">
          <ul className="os-data-files">
            {legalDocuments().map((doc) => (
              <li key={doc.id}>
                <div className="os-data-file-text">
                  <strong>{doc.title}</strong>
                  <span className="os-faint os-small">{doc.summary} {doc.version ? `Version ${doc.version}.` : `In effect from ${doc.effective}.`}</span>
                </div>
                <button type="button" className="os-btn os-btn-sm" onClick={() => onOpen(doc.id)}>Read</button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
