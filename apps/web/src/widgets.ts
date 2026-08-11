// Dashboard widgets (vision §16).
//
// Widgets are draggable, resizable and personalizable, and the layout persists.
// The rule that shapes this file is §22's: live features show real outputs, not
// simulated ones. Several widgets in the vision's initial library have no data
// source in this build — there is no GPU sensor, no brokerage, no weather feed,
// no connected GitHub or Discord or mailbox. Those widgets declare `source:
// "unavailable"` with a reason and render an honest empty state.
//
// The alternative — plausible-looking numbers — is worse than an empty panel,
// because a dashboard is believed at a glance.

export type WidgetSize = "small" | "medium" | "large";

/**
 * Where a widget's numbers come from.
 * - `telemetry`: the desktop bridge's real host readings.
 * - `workspace`: files and projects on disk.
 * - `runtime`: this session's own activity (jobs, automations, suggestions).
 * - `unavailable`: nothing to read from; the widget says so.
 */
export type WidgetSource = "telemetry" | "workspace" | "runtime" | "unavailable";

export type WidgetDefinition = {
  id: string;
  label: string;
  source: WidgetSource;
  /** Why the widget has no data. Required when source is "unavailable". */
  unavailableReason?: string;
  defaultSize: WidgetSize;
};

export type WidgetPlacement = {
  id: string;
  size: WidgetSize;
};

/** The initial widget library, in the order the vision lists it. */
const definitions: WidgetDefinition[] = [
  {
    id: "gpu",
    label: "GPU",
    source: "unavailable",
    unavailableReason: "No GPU sensor is exposed to the app; Node reports CPU and memory only.",
    defaultSize: "small"
  },
  { id: "cpu", label: "CPU", source: "telemetry", defaultSize: "small" },
  { id: "ram", label: "RAM", source: "telemetry", defaultSize: "small" },
  { id: "network", label: "Network", source: "telemetry", defaultSize: "small" },
  { id: "recent-files", label: "Recent files", source: "workspace", defaultSize: "medium" },
  {
    id: "calendar",
    label: "Calendar",
    source: "unavailable",
    unavailableReason: "No calendar account is connected.",
    defaultSize: "medium"
  },
  {
    id: "stocks",
    label: "Stocks",
    source: "unavailable",
    unavailableReason: "Market data needs a paid feed, which this build does not carry.",
    defaultSize: "small"
  },
  {
    id: "weather",
    label: "Weather",
    source: "unavailable",
    unavailableReason: "Weather needs a location and a forecast provider; neither is configured.",
    defaultSize: "small"
  },
  {
    id: "github",
    label: "GitHub activity",
    source: "unavailable",
    unavailableReason: "No GitHub account is connected.",
    defaultSize: "medium"
  },
  {
    id: "discord",
    label: "Discord activity",
    source: "unavailable",
    unavailableReason: "No Discord account is connected.",
    defaultSize: "medium"
  },
  {
    id: "email",
    label: "Email",
    source: "unavailable",
    unavailableReason: "No mailbox is connected.",
    defaultSize: "medium"
  },
  { id: "automations", label: "Running automations", source: "runtime", defaultSize: "medium" },
  { id: "suggestions", label: "AI suggestions", source: "runtime", defaultSize: "medium" },
  { id: "goals", label: "Goals", source: "runtime", defaultSize: "medium" },
  { id: "daily-focus", label: "Daily focus", source: "runtime", defaultSize: "medium" }
];

const byId = new Map<string, WidgetDefinition>(definitions.map((entry) => [entry.id, entry]));

export function allWidgets(): WidgetDefinition[] {
  return [...definitions];
}

export function widgetById(id: string): WidgetDefinition | undefined {
  return byId.get(id);
}

/** Widgets shown before the user customizes anything: the ones with real data. */
export function defaultLayout(): WidgetPlacement[] {
  return definitions
    .filter((entry) => entry.source !== "unavailable")
    .map((entry) => ({ id: entry.id, size: entry.defaultSize }));
}

const sizeCycle: WidgetSize[] = ["small", "medium", "large"];

/** Column span for the dashboard grid. */
export function widgetSpan(size: WidgetSize): number {
  if (size === "large") return 4;
  if (size === "medium") return 2;
  return 1;
}

export function nextSize(size: WidgetSize): WidgetSize {
  const index = sizeCycle.indexOf(size);
  return sizeCycle[(index + 1) % sizeCycle.length];
}

export function resizeWidget(layout: WidgetPlacement[], id: string): WidgetPlacement[] {
  return layout.map((entry) => (entry.id === id ? { ...entry, size: nextSize(entry.size) } : entry));
}

/**
 * Move `draggedId` to the position of `targetId`.
 *
 * Returns the layout unchanged when either id is missing or they are the same,
 * so a drop on itself or on a stale element cannot corrupt the order.
 */
export function moveWidget(
  layout: WidgetPlacement[],
  draggedId: string,
  targetId: string
): WidgetPlacement[] {
  if (draggedId === targetId) return layout;

  const from = layout.findIndex((entry) => entry.id === draggedId);
  const to = layout.findIndex((entry) => entry.id === targetId);
  if (from === -1 || to === -1) return layout;

  const next = [...layout];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function addWidget(layout: WidgetPlacement[], id: string): WidgetPlacement[] {
  const definition = byId.get(id);
  if (!definition) return layout;
  if (layout.some((entry) => entry.id === id)) return layout;
  return [...layout, { id, size: definition.defaultSize }];
}

export function removeWidget(layout: WidgetPlacement[], id: string): WidgetPlacement[] {
  return layout.filter((entry) => entry.id !== id);
}

/**
 * Narrow a stored layout back to something renderable.
 *
 * Persisted layouts outlive the code that wrote them: a widget can be renamed
 * or dropped between versions, and a hand-edited entry can be any shape at all.
 * Unknown ids and bad sizes are discarded rather than thrown, so a stale
 * localStorage value degrades to a smaller dashboard instead of a blank screen.
 */
export function parseLayout(value: unknown): WidgetPlacement[] | null {
  if (!Array.isArray(value)) return null;

  const seen = new Set<string>();
  const layout: WidgetPlacement[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const size = (entry as { size?: unknown }).size;
    if (typeof id !== "string" || !byId.has(id) || seen.has(id)) continue;
    if (size !== "small" && size !== "medium" && size !== "large") continue;
    seen.add(id);
    layout.push({ id, size });
  }

  return layout.length > 0 ? layout : null;
}

export function readLayout(storage: Storage | undefined, key: string): WidgetPlacement[] {
  if (!storage) return defaultLayout();

  try {
    const raw = storage.getItem(key);
    if (!raw) return defaultLayout();
    return parseLayout(JSON.parse(raw)) ?? defaultLayout();
  } catch {
    return defaultLayout();
  }
}

export function writeLayout(storage: Storage | undefined, key: string, layout: WidgetPlacement[]): void {
  try {
    storage?.setItem(key, JSON.stringify(layout));
  } catch {
    // A full or blocked storage must not break the dashboard.
  }
}
