"use client";

import { useEffect, useState, type DragEvent } from "react";
import { Icon } from "../ui/Icon";
import { Stage } from "./Stage";
import { widgetBody, widgetTitles } from "./widgets";
import {
  defaultLayout, inZone, moveWithinZone, normalizeLayout, placeWidget, toggleExpanded, toggleHidden, togglePinned,
  type HomeLayout, type WidgetId, type WidgetPlacement, type Zone
} from "./layout";
import "./home.css";

// Home: the command center. The core in the middle; widgets either side that
// you can rearrange, pin, expand or hide (Customize), remembered on this PC.

const storageKey = "trhai.home.layout.v1";

function Widget({ placement, editing, onLayout }: {
  placement: WidgetPlacement;
  editing: boolean;
  onLayout: (change: (layout: HomeLayout) => HomeLayout) => void;
}) {
  const { id, zone, pinned, expanded } = placement;
  const title = widgetTitles[id];
  return (
    <section
      className={`os-panel os-widget${expanded ? " expanded" : ""}${pinned ? " pinned" : ""}${editing ? " editing" : ""}`}
      data-widget={id}
      draggable={editing}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/x-trhai-widget", id);
        event.dataTransfer.effectAllowed = "move";
      }}
      aria-label={title}
    >
      <header className="os-panel-head">
        <h3 className="os-panel-title">
          {editing ? <Icon name="grip" size={14} className="os-grip" /> : null}
          {pinned ? <Icon name="pin" size={13} /> : null}
          {title}
        </h3>
        <div className="os-widget-tools">
          {editing ? (
            <>
              <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label={`Move ${title} up`} data-tip="Move up" data-tip-pos="below"
                onClick={() => onLayout((layout) => moveWithinZone(layout, id, -1))}><Icon name="up" size={14} /></button>
              <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label={`Move ${title} down`} data-tip="Move down" data-tip-pos="below"
                onClick={() => onLayout((layout) => moveWithinZone(layout, id, 1))}><Icon name="down" size={14} /></button>
              <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label={`Move ${title} to the ${zone === "left" ? "right" : "left"}`}
                data-tip={zone === "left" ? "Move to the right" : "Move to the left"} data-tip-pos="below"
                onClick={() => onLayout((layout) => placeWidget(layout, id, zone === "left" ? "right" : "left", null))}>
                <Icon name={zone === "left" ? "chevronRight" : "chevronLeft"} size={14} />
              </button>
              <button type="button" className={`os-btn os-btn-sm os-btn-ghost os-btn-icon${pinned ? " on" : ""}`} aria-pressed={pinned}
                aria-label={pinned ? `Unpin ${title}` : `Pin ${title} to the top`} data-tip={pinned ? "Unpin" : "Pin to top"} data-tip-pos="below"
                onClick={() => onLayout((layout) => togglePinned(layout, id))}><Icon name="pin" size={14} /></button>
              <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-label={`Hide ${title}`} data-tip="Hide" data-tip-pos="below"
                onClick={() => onLayout((layout) => toggleHidden(layout, id))}><Icon name="eyeOff" size={14} /></button>
            </>
          ) : null}
          <button type="button" className="os-btn os-btn-sm os-btn-ghost os-btn-icon" aria-pressed={expanded}
            aria-label={expanded ? `Show less of ${title}` : `Show more of ${title}`} data-tip={expanded ? "Show less" : "Show more"} data-tip-pos="below"
            onClick={() => onLayout((layout) => toggleExpanded(layout, id))}>
            <Icon name={expanded ? "shrink" : "expand"} size={14} />
          </button>
        </div>
      </header>
      <div className="os-panel-body">{widgetBody(id, expanded)}</div>
    </section>
  );
}

export function HomeView() {
  const [layout, setLayout] = useState<HomeLayout>(defaultLayout);
  const [editing, setEditing] = useState(false);

  // The saved arrangement, read after mount - storage is not there on the server.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a stored preference, unknowable on the server
      if (stored) setLayout(normalizeLayout(JSON.parse(stored)));
    } catch {
      // A broken saved layout falls back to the default rather than failing Home.
    }
  }, []);

  const changeLayout = (change: (prior: HomeLayout) => HomeLayout) => {
    setLayout((prior) => {
      const next = change(prior);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Not remembered, still applied.
      }
      return next;
    });
  };

  // Dropped on a zone: before the widget under the pointer, or at the end.
  const onDrop = (zone: Zone) => (event: DragEvent<HTMLDivElement>) => {
    const id = event.dataTransfer.getData("text/x-trhai-widget") as WidgetId;
    if (!id) return;
    event.preventDefault();
    const over = (event.target as HTMLElement).closest("[data-widget]")?.getAttribute("data-widget") as WidgetId | null;
    changeLayout((prior) => placeWidget(prior, id, zone, over && over !== id ? over : null));
  };
  const zoneProps = (zone: Zone) => editing ? {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (event.dataTransfer.types.includes("text/x-trhai-widget")) event.preventDefault();
    },
    onDrop: onDrop(zone)
  } : {};

  const hidden = layout.widgets.filter((widget) => widget.hidden);

  return (
    <div className={`os-view os-home${editing ? " editing" : ""}`}>
      <div className="os-home-tools">
        {editing ? (
          <>
            <span className="os-faint os-small">Drag widgets between sides, or use their buttons. Changes are saved on this PC.</span>
            <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => changeLayout(() => defaultLayout())}>Reset</button>
            <button type="button" className="os-btn os-btn-sm os-btn-primary" onClick={() => setEditing(false)}><Icon name="check" size={14} />Done</button>
          </>
        ) : (
          <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => setEditing(true)}><Icon name="sliders" size={14} />Customize</button>
        )}
      </div>

      {editing && hidden.length > 0 ? (
        <div className="os-hidden-tray" aria-label="Hidden widgets">
          <span className="os-label">Hidden</span>
          {hidden.map((widget) => (
            <button key={widget.id} type="button" className="os-btn os-btn-sm" onClick={() => changeLayout((prior) => toggleHidden(prior, widget.id))}>
              <Icon name="eye" size={14} />{widgetTitles[widget.id]}
            </button>
          ))}
        </div>
      ) : null}

      <div className="os-home-grid">
        <div className="os-home-zone left" {...zoneProps("left")}>
          {inZone(layout, "left").map((placement) => <Widget key={placement.id} placement={placement} editing={editing} onLayout={changeLayout} />)}
          {editing && inZone(layout, "left").length === 0 ? <div className="os-drop-hint">Drop a widget here</div> : null}
        </div>
        <Stage />
        <div className="os-home-zone right" {...zoneProps("right")}>
          {inZone(layout, "right").map((placement) => <Widget key={placement.id} placement={placement} editing={editing} onLayout={changeLayout} />)}
          {editing && inZone(layout, "right").length === 0 ? <div className="os-drop-hint">Drop a widget here</div> : null}
        </div>
      </div>
    </div>
  );
}
