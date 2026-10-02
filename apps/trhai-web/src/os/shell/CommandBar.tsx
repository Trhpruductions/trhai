"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useAssistantState, useLevels, useVoice } from "../state/assistant";
import { useNav } from "../state/nav";
import { views } from "../views";

// One command bar for the whole system: ask a question, give an order, speak,
// attach a picture or share the screen - from any workspace. Typing "/" turns
// it into a command line for TRH AI itself.

type SlashCommand = { id: string; label: string; hint: string; icon?: IconName; iconPath?: string; run: () => void };

export function CommandBar() {
  const assistant = useAssistantState();
  const { draft, setDraft, attachments, attachNote, busy, sharing, ask, stop, agent } = assistant;
  const voice = useVoice();
  const { go, setPaletteOpen } = useNav();
  const field = useRef<HTMLTextAreaElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [selected, setSelected] = useState(0);

  // "/" focuses the bar from anywhere that is not already a text field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      setDraft((prior) => (prior.startsWith("/") ? prior : `/${prior}`));
      field.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDraft]);

  // The field grows with what is typed, up to a few lines.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`;
  }, [draft]);

  const commands = useMemo<SlashCommand[]>(() => [
    ...views.map((view) => ({
      id: view.id, label: `/${view.id}`, hint: `Open ${view.label}`, iconPath: view.icon, run: () => go(view.id)
    })),
    { id: "listen", label: "/listen", hint: voice.mic.listening ? "Stop listening and send" : "Start listening", icon: "mic", run: () => void voice.toggleMic() },
    {
      id: "handsfree", label: "/handsfree", hint: voice.handsFree ? "Turn hands-free listening off" : "Turn hands-free listening on",
      icon: "wave", run: () => voice.setHandsFree(!voice.handsFree)
    },
    {
      id: "speak", label: "/speak", hint: voice.speech.enabled ? "Stop reading replies aloud" : "Read replies aloud",
      icon: voice.speech.enabled ? "speakerOff" : "speaker", run: () => voice.speech.setEnabled(!voice.speech.enabled)
    },
    { id: "image", label: "/image", hint: "Attach an image", icon: "image", run: () => assistant.openImagePicker() },
    { id: "screen", label: "/screen", hint: "Share the screen with the next message", icon: "screen", run: () => assistant.attachScreen() },
    { id: "palette", label: "/commands", hint: "Open the command palette", icon: "command", run: () => setPaletteOpen(true) }
  ], [go, voice, assistant, setPaletteOpen]);

  const slashing = draft.startsWith("/") && !draft.includes(" ");
  const matches = slashing
    ? commands.filter((command) => command.label.startsWith(draft.toLowerCase()) || command.hint.toLowerCase().includes(draft.slice(1).toLowerCase()))
    : [];
  const pick = Math.min(selected, Math.max(0, matches.length - 1));

  const runCommand = (command: SlashCommand) => {
    setDraft("");
    setSelected(0);
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashing && matches.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSelected((pick + 1) % matches.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelected((pick - 1 + matches.length) % matches.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); runCommand(matches[pick]); return; }
      if (event.key === "Escape") { event.preventDefault(); setDraft(""); return; }
    }
    if (event.key === "Escape" && busy) { event.preventDefault(); stop(); return; }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!busy) ask(draft);
    }
  };

  const canSend = !busy && !sharing && (draft.trim().length > 0 || attachments.length > 0);

  return (
    <div className="os-commandbar-wrap">
      {slashing && matches.length > 0 ? (
        <ul className="os-slash" role="listbox" aria-label="Commands">
          {matches.slice(0, 8).map((command, index) => (
            <li key={command.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === pick}
                className={index === pick ? "active" : ""}
                onMouseEnter={() => setSelected(index)}
                onClick={() => runCommand(command)}
              >
                <Icon name={command.icon} path={command.iconPath} size={16} />
                <span className="os-mono">{command.label}</span>
                <span className="os-dim">{command.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={`os-commandbar${busy ? " busy" : ""}`}>
        {attachments.length > 0 || attachNote ? (
          <div className="os-attachments">
            {attachments.map((attachment) => (
              <figure key={attachment.id} className="os-attachment">
                {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset */}
                <img src={attachment.previewUrl} alt={attachment.name} />
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => assistant.removeAttachment(attachment.id)}>
                  <Icon name="close" size={12} />
                </button>
              </figure>
            ))}
            {attachNote ? <p className="os-attach-note" role="status">{attachNote}</p> : null}
          </div>
        ) : null}

        <div className="os-commandbar-row">
          <div className="os-plus">
            <button
              type="button"
              className={`os-btn os-btn-ghost os-btn-icon${plusOpen ? " on" : ""}`}
              aria-label="More ways to ask"
              aria-expanded={plusOpen}
              data-tip="Attach, share, commands"
              data-tip-pos="below"
              onClick={() => setPlusOpen(!plusOpen)}
            >
              <Icon name="plus" size={18} />
            </button>
            {plusOpen ? (
              <div className="os-menu os-plus-menu" role="menu" onClick={() => setPlusOpen(false)}>
                <button type="button" role="menuitem" onClick={() => assistant.openImagePicker()}><Icon name="image" size={16} />Attach an image</button>
                <button type="button" role="menuitem" disabled={!assistant.screenShareable} onClick={() => assistant.attachScreen()}>
                  <Icon name="screen" size={16} />Share the screen
                </button>
                <button type="button" role="menuitem" onClick={() => voice.setHandsFree(!voice.handsFree)}>
                  <Icon name="wave" size={16} />{voice.handsFree ? "Turn hands-free off" : "Hands-free listening"}
                </button>
                <button type="button" role="menuitem" onClick={() => setPaletteOpen(true)}><Icon name="command" size={16} />Command palette</button>
              </div>
            ) : null}
          </div>

          <textarea
            ref={field}
            className="os-commandbar-field"
            rows={1}
            value={draft}
            placeholder={busy ? "TRH AI is working… (Esc to stop)" : agent ? `Ask ${agent.name} (${agent.role.toLowerCase()})…` : "Ask TRH AI, or type / for commands…"}
            aria-label="Ask TRH AI"
            onChange={(event) => { setDraft(event.target.value); setSelected(0); }}
            onKeyDown={onKeyDown}
            onFocus={() => assistant.setAttentive(true)}
            onBlur={() => assistant.setAttentive(false)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
              if (files.length === 0) return;
              event.preventDefault();
              void assistant.addImages(files);
            }}
          />

          <MicButton />
          <button type="button" className="os-btn os-btn-ghost os-btn-icon os-attach" aria-label="Attach an image" data-tip="Attach an image" data-tip-pos="below" onClick={() => assistant.openImagePicker()}>
            <Icon name="clip" size={18} />
          </button>
          {busy ? (
            <button type="button" className="os-btn os-btn-danger os-send" onClick={stop} aria-label="Stop">
              <Icon name="stop" size={16} /><span className="os-send-label">Stop</span>
            </button>
          ) : (
            <button type="button" className="os-btn os-btn-primary os-send" disabled={!canSend} onClick={() => ask(draft)} aria-label="Send">
              <Icon name="send" size={16} /><span className="os-send-label">Send</span>
            </button>
          )}
        </div>
      </div>
      <div className="os-hints" aria-hidden="true">
        <span><kbd className="os-kbd">Enter</kbd> send</span>
        <span><kbd className="os-kbd">Shift</kbd>+<kbd className="os-kbd">Enter</kbd> new line</span>
        <span><kbd className="os-kbd">/</kbd> commands</span>
        <span><kbd className="os-kbd">Ctrl</kbd>+<kbd className="os-kbd">K</kbd> palette</span>
        <span><kbd className="os-kbd">Alt</kbd>+<kbd className="os-kbd">M</kbd> microphone</span>
      </div>
    </div>
  );
}

/** The microphone, ringed by the room's real loudness while it listens. */
function MicButton() {
  const { mic, toggleMic, handsFree } = useVoice();
  const { micAmplitude } = useLevels();
  const ring = mic.listening ? Math.min(1, micAmplitude * 2.2) : 0;
  const title = !mic.supported
    ? "This browser exposes no microphone"
    : mic.transcribing ? "Transcribing on this PC…"
      : mic.listening ? (handsFree ? "Hands-free: listening for your next request" : "Stop and send what you said")
        : "Speak your request - transcribed on this PC, never uploaded";
  return (
    <button
      type="button"
      className={`os-mic${mic.listening ? " live" : ""}${mic.transcribing ? " busy" : ""}`}
      style={{ "--ring": ring.toFixed(3) } as CSSProperties}
      disabled={!mic.supported || mic.transcribing}
      aria-pressed={mic.listening}
      aria-label={mic.listening ? "Stop listening" : "Speak"}
      data-tip={title}
      data-tip-pos="below"
      onClick={() => void toggleMic()}
    >
      <Icon name="mic" size={18} />
    </button>
  );
}
