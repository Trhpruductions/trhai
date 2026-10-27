"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../os/ui/Icon";
import { useEntitlements } from "../hooks/useEntitlements";
import {
  auditLine, endUserSessions, listUsers, mayManage, readAudit, roleLabel, setUserRole, setUserStatus,
  type AdminUser, type AuditView
} from "../lib/access";
import { useAccount } from "./AppGate";
import "./access.css";

// People and access, in settings - shown only to the owner and the administrators.
//
// The accounts this copy holds, who each one is, and what an owner or
// administrator may do to them: suspend or reactivate, sign out everywhere, and
// (for the owner) make or remove an administrator. The record underneath is the
// audit log of every such change. Which buttons show follows the same rule the
// service applies, but the service decides on every request: a button that
// should not have been offered is refused, not obeyed. No password, hash or
// token is ever sent to this screen.

function when(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "never" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function AdminPanel() {
  const { account } = useAccount();
  const me = useEntitlements(account?.id ?? null);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    const [found, trail] = await Promise.all([listUsers(query), readAudit()]);
    if (found.ok) {
      setUsers(found.data.users);
      setTotal(found.data.total);
    } else {
      setNote({ tone: "bad", text: found.reason });
    }
    if (trail.ok) setAudit(trail.data);
  }, [query]);

  // A short pause after typing, so a search is not sent for every letter.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const act = async (run: () => Promise<{ ok: true } | { ok: false; reason: string }>, done: string) => {
    setBusy(true);
    setNote(null);
    const result = await run();
    setBusy(false);
    setNote(result.ok ? { tone: "ok", text: done } : { tone: "bad", text: result.reason });
    await load();
  };

  const suspend = (user: AdminUser) => {
    const suspending = user.status === "active";
    if (suspending && !window.confirm(`Suspend ${user.email}? They are signed out at once and cannot sign in until you reactivate them.`)) return;
    void act(() => setUserStatus(user.id, suspending ? "suspended" : "active"), suspending ? `${user.email} is suspended.` : `${user.email} is active again.`);
  };

  const signOut = (user: AdminUser) => {
    if (!window.confirm(`Sign ${user.email} out on every device?`)) return;
    void act(() => endUserSessions(user.id), `${user.email} is signed out everywhere.`);
  };

  const changeRole = (user: AdminUser) => {
    const making = user.role !== "admin";
    if (!window.confirm(making ? `Make ${user.email} an administrator? They get everything, free, and can look after other accounts.` : `Remove ${user.email} as an administrator?`)) return;
    void act(() => setUserRole(user.id, making ? "admin" : "user"), making ? `${user.email} is an administrator.` : `${user.email} is no longer an administrator.`);
  };

  if (!me) return <section className="os-panel"><div className="os-panel-body"><p className="os-faint">Reading...</p></div></section>;

  const myRole = me.role;
  const canMakeAdmins = myRole === "owner";

  return (
    <>
      <section className="os-panel access-panel">
        <header className="os-panel-head"><h3 className="os-panel-title">Accounts</h3><span className="os-chip">{total} on this copy</span></header>
        <div className="os-panel-body">
          <label className="os-field">
            <span className="os-label">Find an account</span>
            <input className="os-input" value={query} placeholder="Part of an email or a name" onChange={(event) => setQuery(event.target.value)} />
          </label>

          {note ? <p className={`access-note ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</p> : null}

          {users.length === 0 ? <p className="os-faint">{query ? "No account matches." : "No accounts yet."}</p> : (
            <ul className="access-users">
              {users.map((user) => {
                const self = user.id === account?.id;
                const manageable = mayManage(myRole, user.role) && !self;
                return (
                  <li key={user.id}>
                    <div className="access-user-main">
                      <strong>{user.email}</strong>
                      <span className="os-faint os-small">{user.displayName} - joined {when(user.createdAt)} - last in {when(user.lastLoginAt)} - {user.sessionCount} signed in</span>
                    </div>
                    <div className="access-user-tags">
                      <span className={`os-chip ${user.role === "owner" ? "violet" : user.role === "admin" ? "accent" : ""}`}>{roleLabel(user.role)}</span>
                      {user.status === "suspended" ? <span className="os-chip danger">Suspended</span> : null}
                      {self ? <span className="os-chip ok">You</span> : null}
                    </div>
                    <div className="access-user-actions">
                      {manageable ? (
                        <button type="button" className={`os-btn os-btn-sm ${user.status === "active" ? "os-btn-danger" : ""}`} disabled={busy} onClick={() => suspend(user)}>
                          {user.status === "active" ? "Suspend" : "Reactivate"}
                        </button>
                      ) : null}
                      {manageable || self ? (
                        <button type="button" className="os-btn os-btn-sm os-btn-ghost" disabled={busy} onClick={() => signOut(user)}>Sign out everywhere</button>
                      ) : null}
                      {canMakeAdmins && manageable && me.authority ? (
                        <button type="button" className="os-btn os-btn-sm os-btn-ghost" disabled={busy} onClick={() => changeRole(user)}>
                          {user.role === "admin" ? "Remove administrator" : "Make administrator"}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {canMakeAdmins && !me.authority ? (
            <p className="os-faint os-small">
              On this copy an administrator is made with a signed key, not a setting: the owner issues one for the person&rsquo;s email
              (<span className="os-mono">scripts/licensing/issue.mjs --role admin</span>) and they enter it under Plan and billing.
            </p>
          ) : null}
        </div>
      </section>

      <section className="os-panel access-panel">
        <header className="os-panel-head">
          <h3 className="os-panel-title">Record of changes</h3>
          {audit ? (audit.chain.ok
            ? <span className="os-chip ok"><Icon name="ok" size={13} />Intact</span>
            : <span className="os-chip danger"><Icon name="alert" size={13} />Altered at entry {audit.chain.brokenAtSeq}</span>) : null}
        </header>
        <div className="os-panel-body">
          {!audit || audit.entries.length === 0 ? <p className="os-faint">Nothing has been changed yet. Every suspension, sign-out and change of role is written here, with who did it.</p> : (
            <ul className="access-audit">
              {audit.entries.map((entry) => (
                <li key={entry.seq}>
                  <span className="os-mono os-faint">{new Date(entry.at).toLocaleString()}</span>
                  <span>{auditLine(entry)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
