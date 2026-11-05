"use client";

import { useEffect, useState } from "react";
import { setSingleKeyShortcut, shortcutsEvent, singleKeyShortcutOn } from "../lib/shortcuts";

// Every shortcut the app has, in one place, and the switch for the only one made of a
// single printable key. The list is kept here by hand: the shortcuts themselves live in
// AppShell.tsx (the system ones), CommandBar.tsx ("/" and Enter) and the dialogs (Esc).

const shortcuts: Array<{ keys: string[]; does: string }> = [
  { keys: ["Ctrl", "K"], does: "Open the command palette: search everything TRH AI keeps, or run a command." },
  { keys: ["Ctrl", "B"], does: "Collapse the sidebar to its icons, or open it again." },
  { keys: ["Alt", "M"], does: "Start or stop listening." },
  { keys: ["Alt", "1"], does: "Go to a workspace, in the sidebar's order: Alt+1 is Home, Alt+0 the tenth." },
  { keys: ["Esc"], does: "Close what is open - the palette, a menu, a dialog - or stop a reply that is being written." },
  { keys: ["Enter"], does: "Send what is in the command bar. Shift+Enter starts a new line instead." },
  { keys: ["/"], does: "Put the keyboard in the command bar from anywhere that is not a text field. The switch below turns this off." }
];

export function KeyboardPanel() {
  const [single, setSingle] = useState(true);
  useEffect(() => {
    const read = () => setSingle(singleKeyShortcutOn());
    read();
    window.addEventListener(shortcutsEvent, read);
    return () => window.removeEventListener(shortcutsEvent, read);
  }, []);

  return (
    <section className="os-panel">
      <header className="os-panel-head"><h3 className="os-panel-title">Keyboard</h3></header>
      <div className="os-panel-body os-stack">
        <table className="os-keys-table">
          <caption className="sr-only">Keyboard shortcuts</caption>
          <thead>
            <tr><th scope="col">Keys</th><th scope="col">What it does</th></tr>
          </thead>
          <tbody>
            {shortcuts.map((shortcut) => (
              <tr key={shortcut.keys.join("+")}>
                <th scope="row">{shortcut.keys.map((key) => <kbd key={key} className="os-kbd">{key}</kbd>)}</th>
                <td>{shortcut.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="os-keys-switch">
          <span>
            <strong>Single-key shortcut</strong>
            <span id="single-key-note" className="os-small os-dim">
              &ldquo;/&rdquo; moves the keyboard to the command bar. Turn it off if stray keys reach the app - from speech recognition, for instance.
            </span>
          </span>
          <button type="button" role="switch" className="os-switch" aria-checked={single} aria-label="Single-key shortcut" aria-describedby="single-key-note" onClick={() => setSingleKeyShortcut(!single)}>
            <span className="os-switch-knob" />
          </button>
        </div>
      </div>
    </section>
  );
}
