"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { draftNotice, legalDocIds, legalDocument, legalShortTitle, legalTextsReady, type LegalDocId } from "@ascend/shared";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { LegalDocumentView } from "./LegalDocumentView";
import "./legal.css";

// The legal texts, opened over whatever is on screen - the sign-in form, the paywall, a
// settings panel - from any link that names one. One provider at the root holds which text
// is open, so the sign-in screen (outside the app shell) and the shell share the dialog.

type LegalControls = {
  /** Opens a text over the screen. */
  openLegal: (id: LegalDocId) => void;
  closeLegal: () => void;
  openDoc: LegalDocId | null;
};

const LegalContext = createContext<LegalControls>({ openLegal: () => {}, closeLegal: () => {}, openDoc: null });

export function useLegal(): LegalControls {
  return useContext(LegalContext);
}

export function LegalProvider({ children }: { children: ReactNode }) {
  const [openDoc, setOpenDoc] = useState<LegalDocId | null>(null);
  const openLegal = useCallback((id: LegalDocId) => setOpenDoc(id), []);
  const closeLegal = useCallback(() => setOpenDoc(null), []);
  const controls = useMemo(() => ({ openLegal, closeLegal, openDoc }), [openLegal, closeLegal, openDoc]);
  return (
    <LegalContext.Provider value={controls}>
      {children}
      {openDoc ? <LegalDialog id={openDoc} onPick={setOpenDoc} onClose={closeLegal} /> : null}
    </LegalContext.Provider>
  );
}

/** A link in running text that opens one of the texts. */
export function LegalLink({ id, children }: { id: LegalDocId; children?: ReactNode }) {
  const { openLegal } = useLegal();
  return (
    <button type="button" className="legal-inline-link" onClick={() => openLegal(id)}>
      {children ?? legalShortTitle(id)}
    </button>
  );
}

export function LegalDialog({ id, onPick, onClose }: { id: LegalDocId; onPick: (id: LegalDocId) => void; onClose: () => void }) {
  const ref = useDialogFocus<HTMLElement>(true, onClose);
  const doc = legalDocument(id);
  const draft = !legalTextsReady();
  return (
    <div className="legal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={ref} className="legal-dialog" role="dialog" aria-modal="true" aria-labelledby="legal-dialog-title" tabIndex={-1}>
        <header className="legal-dialog-head">
          <nav className="legal-dialog-tabs" aria-label="Legal texts">
            {legalDocIds.map((docId) => (
              <button key={docId} type="button" aria-current={docId === id ? "page" : undefined} onClick={() => onPick(docId)}>
                {legalShortTitle(docId)}
              </button>
            ))}
          </nav>
          <button type="button" className="legal-dialog-close" onClick={onClose}>Close</button>
        </header>
        <div className="legal-dialog-body">
          {draft ? <p className="legal-draft" role="note">{draftNotice}</p> : null}
          <LegalDocumentView doc={doc} onOpenDoc={onPick} showReviewNotes={draft} headingId="legal-dialog-title" />
        </div>
      </section>
    </div>
  );
}
