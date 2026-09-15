// Changing an app that was built here, from a description of the change.
//
// "add a 'notes' text field to the plants", said right after building a
// houseplant tracker, built a second app called "Notes Text Field". The
// tracker is generated from a spec, so the honest way to change it is to
// change the spec and generate it again - which is what this does. The
// original request is the README's first paragraph and every change made
// since is listed under "## Changes"; the plan of the request has the
// changes applied in order, and the same folder is regenerated with its
// data left alone. Deterministic, like the generator: a change either maps
// onto the spec or is refused with what would.

import { detectFeatures, planProject, type EntityField, type FieldType, type ProjectFeature, type ProjectSpec } from "./projectPlan.js";

export type AppChange = {
  spec: ProjectSpec;
  /** What the latest change did, in words, one line each. */
  changes: string[];
};

const typeWords: Array<{ pattern: RegExp; type: FieldType }> = [
  { pattern: /^(?:text|long text|multiline|multi-line|paragraph|textarea)$/i, type: "text" },
  { pattern: /^(?:number|numeric|integer|decimal|amount)$/i, type: "number" },
  { pattern: /^(?:date|day|calendar)$/i, type: "date" },
  { pattern: /^(?:email|e-mail)$/i, type: "email" },
  { pattern: /^(?:phone|telephone|mobile)$/i, type: "phone" },
  { pattern: /^(?:url|link|website)$/i, type: "url" },
  { pattern: /^(?:boolean|checkbox|yes\/no|yes-no|true\/false|toggle|flag)$/i, type: "boolean" },
  { pattern: /^(?:string|short text|single-line|word)$/i, type: "string" }
];

/** Type words that are as often the tail of a field's name: "purchase date", "contact email". */
const typeWordsThatName = /^(?:date|day|email|e-mail|phone|url|website|link)$/i;

const typeWord = "text|long text|multiline|paragraph|textarea|number|numeric|integer|decimal|amount|date|day|email|e-mail|phone|telephone|mobile|url|link|website|boolean|checkbox|yes\\/no|toggle|flag|string|short text";
const fieldNoun = "field|column|property|attribute|input|box|entry";
const article = "(?:a |an |the |another |new |a new |one more )?";
const onEntity = "(?:\\s+(?:to|on|for|in)\\s+(?:the |each |every |all |my )?([a-z][a-z-]*))?";
const name = "['\"`]?([a-z][a-z0-9 _-]{0,40}?)['\"`]?";

/** "add a field called notes", "add a text field named notes to the plants". */
const addNamedField = new RegExp(
  "\\b(?:add|include|put|create)\\s+" + article + "(?:(" + typeWord + ")\\s+)?(?:" + fieldNoun + ")\\s+(?:called|named|for|labelled|labeled)\\s+"
  + name + onEntity + "(?=[\\s.,;!]|$)",
  "i"
);

/** "add a 'notes' text field to the plants", "add a purchase date field", "add notes". */
const addField = new RegExp(
  "\\b(?:add|include|put|create)\\s+" + article + name + "(?:\\s+(" + typeWord + "))?\\s+(?:" + fieldNoun + ")\\b" + onEntity,
  "i"
);

/** "remove the notes field", "drop the species column". */
const removeField = new RegExp(
  "\\b(?:remove|delete|drop|get rid of)\\s+(?:the |its |their )?" + name + "\\s+(?:" + fieldNoun + ")\\b",
  "i"
);

const featureWords: Array<{ pattern: RegExp; feature: ProjectFeature }> = [
  { pattern: /\b(?:dashboard|summary (?:page|screen|view)|stats page)\b/i, feature: "dashboard" },
  { pattern: /\b(?:calendar|month view)\b/i, feature: "calendar" },
  { pattern: /\b(?:board|kanban)\b/i, feature: "board" },
  { pattern: /\bsearch\b/i, feature: "search" },
  { pattern: /\btimeline\b/i, feature: "timeline" },
  { pattern: /\b(?:roles?|role-based|permissions?|rbac)\b/i, feature: "roles" },
  { pattern: /\bpriority\b/i, feature: "priority" },
  { pattern: /\bstatus(?:es)?\b/i, feature: "status" },
  { pattern: /\b(?:due dates?|deadlines?)\b/i, feature: "dueDates" },
  { pattern: /\b(?:assignment|assignees?|assign(?:ed)? to)\b/i, feature: "assignment" }
];

/** camelCase, the same way the planner names fields. */
export function toFieldName(label: string): string {
  const parts = label.trim().toLowerCase().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "";
  return parts[0] + parts.slice(1).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function typeOf(word: string | undefined, label: string): FieldType {
  if (word) {
    for (const entry of typeWords) {
      if (entry.pattern.test(word.trim())) return entry.type;
    }
  }
  // The planner's own inference, via a one-field plan of the label.
  const planned = planProject(`things with ${label}`);
  const field = planned.entities[0]?.fields.find((candidate) => candidate.name === toFieldName(label));
  return field?.type ?? "string";
}

function entityFor(spec: ProjectSpec, named: string | undefined) {
  if (named) {
    const wanted = named.toLowerCase();
    const found = spec.entities.find((entity) =>
      entity.name === wanted || entity.plural === wanted
      || entity.label.toLowerCase() === wanted || entity.labelPlural.toLowerCase() === wanted);
    if (found) return found;
  }
  return spec.entities[0];
}

/** Apply one change to a spec in place; the lines say what happened. */
function applyChange(spec: ProjectSpec, change: string): string[] {
  const notes: string[] = [];
  const text = change.trim();

  // Removals first, so "remove the old notes field and add a comments field"
  // reads as two changes in order.
  const removal = text.match(removeField);
  if (removal) {
    const wanted = toFieldName(removal[1]);
    const label = removal[1].trim().toLowerCase();
    // A reference field is named after the entity it points at, in the
    // planner's own singular ("specyId" for species), so it is matched by
    // what it references as well as by name.
    const matches = (field: EntityField) => field.name !== "title"
      && (field.name === wanted
        || field.name === `${wanted}Id`
        || (field.type === "reference" && (field.references === label || field.references === `${label}s`)));
    for (const entity of spec.entities) {
      const index = entity.fields.findIndex(matches);
      if (index !== -1) {
        const [gone] = entity.fields.splice(index, 1);
        notes.push(`removed the ${gone.name} field from ${entity.name}`);
      }
    }
    if (!notes.length) notes.push(`there is no ${wanted} field to remove`);
  }

  const named = text.match(addNamedField);
  const positional = named ? null : text.match(addField);
  const addition = named
    ? { label: named[2], type: named[1], entity: named[3] }
    : positional
      ? { label: positional[1], type: positional[2], entity: positional[3] }
      : null;
  if (addition) {
    let label = addition.label.trim();
    let type: string | undefined = addition.type;
    // "purchase date field": the type word is the tail of the name.
    if (type && typeWordsThatName.test(type)) {
      label = `${label} ${type}`;
      type = undefined;
    }
    const fieldName = toFieldName(label);
    const entity = entityFor(spec, addition.entity);
    if (fieldName && entity) {
      if (entity.fields.some((field) => field.name === fieldName)) {
        notes.push(`${entity.name} already has a ${fieldName} field`);
      } else {
        const field: EntityField = { name: fieldName, type: typeOf(type, label), required: false };
        entity.fields.push(field);
        notes.push(`added a ${field.type} field "${fieldName}" to ${entity.name}`);
      }
    }
  }

  // Features: the planner's own detection on the change, plus the plain
  // words for the ones it names.
  const wanted = new Set<ProjectFeature>(detectFeatures(text));
  for (const entry of featureWords) {
    if (entry.pattern.test(text)) wanted.add(entry.feature);
  }
  const primary = spec.entities[0];
  const has = (fieldName: string) => Boolean(primary?.fields.some((field) => field.name === fieldName));
  const statusField = (): EntityField =>
    ({ name: "status", type: "enum", required: true, options: ["open", "in_progress", "resolved", "closed"] });
  for (const feature of wanted) {
    if (spec.features.includes(feature)) continue;
    spec.features.push(feature);
    notes.push(`added ${describeFeature(feature)}`);
    if (!primary) continue;
    // The workflow fields a feature implies, the way the planner adds them.
    if (feature === "status" && !has("status")) primary.fields.push(statusField());
    if (feature === "priority" && !has("priority")) {
      primary.fields.push({ name: "priority", type: "enum", required: true, options: ["low", "medium", "high", "critical"] });
    }
    if (feature === "assignment" && !has("assignee")) primary.fields.push({ name: "assignee", type: "string", required: false });
    if ((feature === "dueDates" || feature === "calendar") && !has("dueDate")) {
      primary.fields.push({ name: "dueDate", type: "date", required: false });
    }
    if (feature === "calendar" && !spec.features.includes("dueDates")) spec.features.push("dueDates");
    if (feature === "board") {
      if (!has("status")) primary.fields.push(statusField());
      if (!spec.features.includes("status")) spec.features.push("status");
    }
  }

  return notes;
}

/**
 * The app's plan with every change applied in order, or null when the last
 * change maps onto nothing the generator knows.
 *
 * `original` is the request the app was built from; `earlier` the changes
 * already recorded in its README; `change` the new one. The spec's summary
 * stays the original request, so the README's first paragraph is always the
 * request and never a sentence the planner would read entities out of -
 * "add a notes field" replanned as entities called "add" and "field".
 */
export function amendProject(original: string, earlier: string[], change: string, title?: string): AppChange | null {
  const base = planProject(original, title);
  if (base.kind === "calculator") return null;

  const spec = JSON.parse(JSON.stringify(base)) as ProjectSpec;
  for (const previous of earlier) applyChange(spec, previous);

  const notes = applyChange(spec, change);
  if (notes.length === 0) return null;
  return { spec: { ...spec, summary: original.trim() }, changes: notes };
}

function describeFeature(feature: ProjectFeature): string {
  switch (feature) {
    case "dashboard": return "a dashboard";
    case "calendar": return "a calendar view";
    case "board": return "a board view";
    case "search": return "search";
    case "timeline": return "a timeline";
    case "roles": return "role-based access";
    case "priority": return "a priority field";
    case "status": return "a status field";
    case "dueDates": return "due dates";
    case "assignment": return "assignment";
  }
}

/** The request an app was built from: the README's first paragraph after its heading. */
export function originalRequestFrom(readme: string): string | null {
  const lines = readme.split(/\r?\n/);
  let pastHeading = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!pastHeading) {
      if (trimmed.startsWith("# ")) pastHeading = true;
      continue;
    }
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) return null;
    return trimmed;
  }
  return null;
}

/** The app's title: the README's heading. */
export function titleFrom(readme: string): string | null {
  const match = readme.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

const changesHeading = "## Changes";

/** The changes already made to the app, from its README, oldest first. */
export function changesFrom(readme: string): string[] {
  const at = readme.indexOf(changesHeading);
  if (at === -1) return [];
  const section = readme.slice(at + changesHeading.length);
  const end = section.search(/^##\s/m);
  const body = end === -1 ? section : section.slice(0, end);
  return body.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

/** The README with the change list carried on it, so the next change starts from all of them. */
export function withChanges(readme: string, changes: string[]): string {
  const at = readme.indexOf(changesHeading);
  const base = at === -1 ? readme.trimEnd() : readme.slice(0, at).trimEnd();
  if (changes.length === 0) return `${base}\n`;
  return `${base}\n\n${changesHeading}\n\n${changes.map((change) => `- ${change}`).join("\n")}\n`;
}
