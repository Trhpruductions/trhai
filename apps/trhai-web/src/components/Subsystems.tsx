"use client";

import "./subsystems.css";

// The callouts flanking the core.
//
// In the reference these read "NLP ENGINE v4.2.1 ACTIVE", "VISION SYSTEM
// v3.8.7 ACTIVE" and so on — every one green, every one with a version
// number. Those are the shape of the design, and the shape is right: a ring
// of named subsystems around the core is exactly what this screen should
// show. The names and versions are not, because this build has no vision
// system, nothing is at v3.8.7, and a row that says ACTIVE when nothing was
// checked is the one thing this interface must never do.
//
// So the layout is kept and the contents are real. Each row names a part that
// genuinely exists, shows the version or model it is genuinely running, and
// reports ACTIVE or OFFLINE from an actual check. A subsystem that is not
// installed says so — which is more useful than a green light, because it
// tells you what to go and fix.

export type Subsystem = {
  name: string;
  /** The real model, voice or version — never a decorative number. */
  detail: string | null;
  /** Null while the first check is still in flight. */
  online: boolean | null;
  /** Why it is off, when it is. */
  reason?: string | null;
  /** 0–1, when this subsystem has a live signal worth showing. */
  level?: number;
};

function StateWord({ online }: { online: boolean | null }) {
  if (online === null) return <span className="sub-state">CHECKING</span>;
  return <span className={`sub-state${online ? " on" : " off"}`}>{online ? "ACTIVE" : "OFFLINE"}</span>;
}

/**
 * A live bar, for subsystems that actually produce a signal.
 *
 * Only speech has one — the neural voice exposes its audio, so the bar is
 * the real amplitude. Every other row omits it rather than animating for
 * decoration, which is why this returns null instead of a resting waveform.
 */
function Level({ level }: { level: number }) {
  const bars = 14;
  return (
    <div className="sub-level" aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => {
        // A fixed shape scaled by the real level, so the bar's height is the
        // measurement and only its profile is styling.
        const profile = 0.35 + 0.65 * Math.abs(Math.sin((index / bars) * Math.PI));
        const height = Math.max(1, Math.round(level * profile * 14));
        return <span key={index} style={{ height: `${height}px` }} />;
      })}
    </div>
  );
}

export function Subsystems({ items, side }: { items: Subsystem[]; side: "left" | "right" }) {
  return (
    <div className={`subs subs-${side}`}>
      {items.map((item) => (
        <div key={item.name} className={`sub${item.online === false ? " sub-off" : ""}`}>
          <div className="sub-head">
            <span className="sub-dot" aria-hidden="true" />
            <span className="sub-name">{item.name}</span>
          </div>
          {item.detail ? <span className="sub-detail" title={item.detail}>{item.detail}</span> : null}
          {item.online === false && item.reason ? (
            <span className="sub-reason">{item.reason}</span>
          ) : null}
          {item.level !== undefined && item.online ? <Level level={item.level} /> : null}
          <StateWord online={item.online} />
        </div>
      ))}
    </div>
  );
}
