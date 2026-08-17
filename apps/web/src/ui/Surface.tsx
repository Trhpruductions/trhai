import type { ReactNode } from "react";

// The frame every non-chat screen shares.
//
// Having one wrapper is what keeps the screens from drifting apart: the old
// shell had each panel invent its own header, padding and scroll behaviour, so
// no two lined up and adding a screen meant copying whichever neighbour looked
// closest.

type Props = {
  title: string;
  /** One line saying what the screen is for. Shown under the title, always. */
  summary: string;
  /** Short status, e.g. "3 documents". Sits beside the title. */
  count?: string;
  /** Actions for the screen as a whole. */
  actions?: ReactNode;
  /** Caps line length for text-heavy screens; off for boards and tables. */
  readable?: boolean;
  children: ReactNode;
};

export function Surface({ title, summary, count, actions, readable = true, children }: Props) {
  return (
    <section className="surface" aria-label={title}>
      <header className="surface-head">
        <div className="surface-title">
          <h2>{title}</h2>
          {count ? <span className="chip">{count}</span> : null}
        </div>
        {actions ? <div className="row">{actions}</div> : null}
      </header>

      <div className={`surface-body${readable ? " readable" : ""}`}>
        <p className="muted surface-summary">{summary}</p>
        {children}
      </div>
    </section>
  );
}

/**
 * Nothing to show, and why.
 *
 * Always takes a reason. An empty panel with no explanation is the single most
 * common way a working feature looks broken — the user cannot tell "you have
 * not added anything yet" from "this is not implemented".
 */
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
