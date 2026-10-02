"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Icon } from "./Icon";

// What a failure looks like: what went wrong, what to do about it, and no
// stack traces or paths a stranger looking over the shoulder should not see.

export function SystemAlert({ title, detail, onRetry, retryLabel = "Retry", extra }: {
  title: string;
  detail: string;
  onRetry?: () => void;
  retryLabel?: string;
  extra?: ReactNode;
}) {
  return (
    <section className="os-alert" role="alert">
      <span className="os-alert-icon" aria-hidden="true"><Icon name="alert" size={22} /></span>
      <div className="os-alert-text">
        <span className="os-label">TRH AI system alert</span>
        <h3>{title}</h3>
        <p>{detail}</p>
        <div className="os-view-actions">
          {onRetry ? <button type="button" className="os-btn" onClick={onRetry}><Icon name="refresh" size={15} />{retryLabel}</button> : null}
          {extra}
        </div>
      </div>
    </section>
  );
}

/** Keeps one workspace's failure inside that workspace. */
export class ViewBoundary extends Component<{ children: ReactNode; name: string }, { failed: string | null }> {
  state = { failed: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { failed: error instanceof Error ? error.message : "Something went wrong." };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // For the developer console only; the screen says it plainly.
    console.error(`[${this.props.name}]`, error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="os-view">
          <SystemAlert
            title={`${this.props.name} stopped working`}
            detail="This workspace hit an error and was stopped so the rest of TRH AI keeps running. Retrying usually clears it; if it does not, the details are in the developer console."
            onRetry={() => this.setState({ failed: null })}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
