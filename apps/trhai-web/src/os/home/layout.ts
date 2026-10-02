// The Home widgets' arrangement: which side each sits on, in what order,
// whether it is hidden, pinned to the top, or expanded. Pure, so the rules can
// be tested without a browser; HomeView keeps it in localStorage.

export type WidgetId = "vitals" | "health" | "modules" | "activity" | "tasks" | "upcoming" | "voice";
export type Zone = "left" | "right";
export type WidgetPlacement = { id: WidgetId; zone: Zone; hidden: boolean; pinned: boolean; expanded: boolean };
export type HomeLayout = { version: 1; widgets: WidgetPlacement[] };

export const widgetIds: WidgetId[] = ["vitals", "health", "modules", "activity", "tasks", "upcoming", "voice"];

export function defaultLayout(): HomeLayout {
  const place = (id: WidgetId, zone: Zone): WidgetPlacement => ({ id, zone, hidden: false, pinned: false, expanded: false });
  return {
    version: 1,
    widgets: [
      place("vitals", "left"), place("health", "left"), place("modules", "left"),
      place("activity", "right"), place("tasks", "right"), place("upcoming", "right"), place("voice", "right")
    ]
  };
}

/** A stored layout, repaired: unknown widgets dropped, missing ones added back where they belong by default. */
export function normalizeLayout(value: unknown): HomeLayout {
  const fallback = defaultLayout();
  const stored = value as { version?: unknown; widgets?: unknown } | null;
  if (!stored || stored.version !== 1 || !Array.isArray(stored.widgets)) return fallback;
  const seen = new Set<WidgetId>();
  const widgets: WidgetPlacement[] = [];
  for (const entry of stored.widgets as Array<Partial<WidgetPlacement>>) {
    if (!entry || !widgetIds.includes(entry.id as WidgetId) || seen.has(entry.id as WidgetId)) continue;
    seen.add(entry.id as WidgetId);
    widgets.push({
      id: entry.id as WidgetId,
      zone: entry.zone === "right" ? "right" : "left",
      hidden: entry.hidden === true,
      pinned: entry.pinned === true,
      expanded: entry.expanded === true
    });
  }
  for (const missing of fallback.widgets.filter((widget) => !seen.has(widget.id))) widgets.push(missing);
  return { version: 1, widgets };
}

/** The visible widgets of one side, pinned ones first, otherwise in their saved order. */
export function inZone(layout: HomeLayout, zone: Zone): WidgetPlacement[] {
  const visible = layout.widgets.filter((widget) => widget.zone === zone && !widget.hidden);
  return [...visible.filter((widget) => widget.pinned), ...visible.filter((widget) => !widget.pinned)];
}

function update(layout: HomeLayout, id: WidgetId, change: (widget: WidgetPlacement) => WidgetPlacement): HomeLayout {
  return { ...layout, widgets: layout.widgets.map((widget) => (widget.id === id ? change(widget) : widget)) };
}

export const toggleHidden = (layout: HomeLayout, id: WidgetId) => update(layout, id, (widget) => ({ ...widget, hidden: !widget.hidden }));
export const togglePinned = (layout: HomeLayout, id: WidgetId) => update(layout, id, (widget) => ({ ...widget, pinned: !widget.pinned }));
export const toggleExpanded = (layout: HomeLayout, id: WidgetId) => update(layout, id, (widget) => ({ ...widget, expanded: !widget.expanded }));

/** One step up or down among the visible widgets of its own side. */
export function moveWithinZone(layout: HomeLayout, id: WidgetId, direction: -1 | 1): HomeLayout {
  const target = layout.widgets.find((widget) => widget.id === id);
  if (!target) return layout;
  const order = inZone(layout, target.zone).map((widget) => widget.id);
  const index = order.indexOf(id);
  const swapWith = order[index + direction];
  if (index === -1 || !swapWith) return layout;
  const widgets = [...layout.widgets];
  const a = widgets.findIndex((widget) => widget.id === id);
  const b = widgets.findIndex((widget) => widget.id === swapWith);
  [widgets[a], widgets[b]] = [widgets[b], widgets[a]];
  return { ...layout, widgets };
}

/** Put a widget on a side, before another widget there - or at the end of that side. */
export function placeWidget(layout: HomeLayout, id: WidgetId, zone: Zone, before: WidgetId | null): HomeLayout {
  const moving = layout.widgets.find((widget) => widget.id === id);
  if (!moving || id === before) return layout;
  const rest = layout.widgets.filter((widget) => widget.id !== id);
  const placed = { ...moving, zone, hidden: false };
  const index = before ? rest.findIndex((widget) => widget.id === before) : -1;
  if (index === -1) return { ...layout, widgets: [...rest, placed] };
  return { ...layout, widgets: [...rest.slice(0, index), placed, ...rest.slice(index)] };
}
