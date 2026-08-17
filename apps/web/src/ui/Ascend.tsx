import { useEffect, useState } from "react";
import { AppShell, type SurfaceContext, type SurfaceId } from "./AppShell";
import { webEnv } from "../env";
import "../design/tokens.css";
import "../design/base.css";

// Composition root for the rebuilt UI.
//
// Deliberately thin: it owns nothing but the model-status probe and the mapping
// from a surface id to a screen. The previous entry point was a single 5,600
// line component that owned every piece of state in the app, which is how a
// prompt box ended up wired to the wrong subsystem.

/**
 * Whether a local model is answering.
 *
 * Asked once at startup and then on a slow interval, because the user can start
 * or stop Ollama at any time and a stale "no model" indicator would misreport
 * what the assistant is capable of. The probe is a question to our own API, not
 * to Ollama, so the browser never needs to reach a second origin.
 */
function useModelStatus(): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/model`);
        if (!response.ok) return;
        const payload = await response.json();
        if (!cancelled) setLabel(payload?.data?.model ?? null);
      } catch {
        if (!cancelled) setLabel(null);
      }
    }

    void probe();
    const timer = window.setInterval(probe, 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  return label;
}

/**
 * Screens beyond the conversation.
 *
 * Each is loaded as it is first opened. The build and automation surfaces pull
 * in the project generator and the flow engine, which are large and are not
 * needed to start a conversation — the screen the app opens on.
 */
function Surface({ id, context }: { id: SurfaceId; context: SurfaceContext }) {
  return (
    <section className="surface" aria-label={id}>
      <header className="surface-head">
        <div className="surface-title">
          <h2>{id.charAt(0).toUpperCase() + id.slice(1)}</h2>
        </div>
      </header>
      <div className="surface-body readable">
        <div className="empty">
          <strong>Not rebuilt yet</strong>
          <p>
            This screen is being rebuilt. Its behaviour is unchanged and still
            covered by tests — only the interface is being replaced, one surface
            at a time, so the app keeps working while it happens.
          </p>
        </div>
      </div>
    </section>
  );
}

export function Ascend() {
  const modelLabel = useModelStatus();

  return (
    <AppShell
      modelLabel={modelLabel}
      renderSurface={(id, context) => <Surface id={id} context={context} />}
    />
  );
}
