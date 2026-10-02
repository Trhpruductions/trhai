import type { ReactNode } from "react";
import { viewById, type ViewId } from "../views";

/**
 * A workspace's frame: its name, what it is for, its own actions, then the work.
 * A workspace showing one thing of many (a conversation) can name that instead.
 */
export function ViewFrame({ id, actions, children, className, title, blurb }: {
  id: ViewId;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  blurb?: ReactNode;
}) {
  const view = viewById(id);
  return (
    <div className={`os-view${className ? ` ${className}` : ""}`}>
      <header className="os-view-head">
        <div className="os-view-title">
          <h1>{title ?? view.label}</h1>
          <p>{blurb ?? view.blurb}</p>
        </div>
        {actions ? <div className="os-view-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
