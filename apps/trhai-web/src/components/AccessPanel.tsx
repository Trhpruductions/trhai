"use client";

import { Icon } from "../os/ui/Icon";
import { useEntitlements } from "../hooks/useEntitlements";
import { describeAccess, featureStatus, roleLabel } from "../lib/access";
import { useAccount } from "./AppGate";
import "./access.css";

// What the person may use, in settings: their role, their plan, and each part of
// TRH AI marked open or shut with the reason. Read from the same rules the API
// applies to every request, so the list cannot say something the app would not
// do. Owners and administrators see everything open, and are told why.

export function AccessPanel() {
  const { account } = useAccount();
  const view = useEntitlements(account?.id ?? null);

  return (
    <section className="os-panel access-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">What you can use</h3></header>
      <div className="os-panel-body">
        {!view ? <p className="os-faint">Reading what this account may use...</p> : (
          <>
            <div className="access-who">
              <span className={`os-chip ${view.role === "owner" ? "violet" : view.role === "admin" ? "accent" : ""}`}>{roleLabel(view.role)}</span>
              <span className="os-chip">{view.planLabel}</span>
              {view.status === "suspended" ? <span className="os-chip danger">Suspended</span> : null}
            </div>
            <p>{describeAccess(view)}</p>
            <ul className="access-features">
              {view.features.map((feature) => (
                <li key={feature.id} className={feature.allowed ? "on" : "off"}>
                  <Icon name={feature.allowed ? "ok" : "alert"} size={15} />
                  <div>
                    <strong>{feature.label}</strong>
                    <span>{featureStatus(feature)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
