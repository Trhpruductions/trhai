// Deterministic project planning.
//
// Turns a build request into a concrete data model. No language model is involved:
// entities come from the nouns in the request, and fields come from the features
// the request actually mentions. Anything not mentioned is not invented — a
// request with no recognizable entity yields a single generic "item", which is
// honest about what was understood rather than guessing.

export type FieldType =
  | "string" | "text" | "number" | "boolean" | "date" | "enum" | "reference"
  | "email" | "phone" | "url";

export type EntityField = {
  name: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  /** For `reference` fields: the plural collection this points at. */
  references?: string;
};

export type Entity = {
  /** Singular, lower-case: "incident". */
  name: string;
  /** Plural, used for routes and collections: "incidents". */
  plural: string;
  /** Capitalized for display: "Incident". */
  label: string;
  fields: EntityField[];
};

export type ProjectFeature =
  | "roles" | "timeline" | "search" | "status" | "priority" | "assignment" | "dueDates"
  | "dashboard" | "board" | "calendar";

export type ProjectSpec = {
  title: string;
  slug: string;
  summary: string;
  entities: Entity[];
  features: ProjectFeature[];
};

/** Words that describe the *kind* of app, never the thing it stores. */
const structuralWords = new Set([
  "tracker", "tracking", "service", "system", "app", "application", "platform", "tool",
  "dashboard", "portal", "site", "website", "manager", "management", "api", "backend",
  "frontend", "ui", "interface", "page", "module", "feature", "project", "product",
  "solution", "software", "program", "suite", "console", "panel", "board", "hub",
  "minimal", "simple", "internal", "external", "basic", "small", "quick", "new", "modern",
  "control", "controls", "access", "based", "with", "and", "for", "the", "that", "build",
  "create", "make", "generate", "need", "want", "help", "please", "full", "complete",
  "support", "supports", "including", "include", "manage", "handle", "track", "store",
  "have", "has", "had", "having", "contain", "contains", "belong", "belongs",
  // Interrogatives, pronouns and determiners. Prose describing behaviour is full
  // of them — "an app that reminds me when to water each plant" was producing
  // entities named "remind" and "when" — and none can ever name a record type.
  "when", "where", "why", "how", "who", "whom", "whose", "which", "what",
  "each", "every", "some", "any", "all", "both", "either", "neither",
  "me", "my", "mine", "you", "your", "yours", "our", "ours", "us", "they",
  "them", "their", "theirs", "its", "this", "these", "those", "there", "here",
  "then", "than", "about", "into", "onto", "from", "upon", "while", "whether",
  "also", "just", "only", "very", "more", "most", "less", "least", "much",
  "many", "few", "several", "multiple", "other", "another", "same", "such",
  // Verbs that describe what the app does rather than what it stores.
  "remind", "reminds", "let", "lets", "allow", "allows", "show", "shows",
  "send", "sends", "keep", "keeps", "record", "records", "list", "lists",
  "view", "views", "see", "sees", "get", "gets", "put", "puts", "use", "uses",
  "log", "logs", "save", "saves", "share", "shares", "find", "finds",
  // Placeholders and adjectives that are never the thing being stored.
  "something", "anything", "everything", "thing", "things", "stuff", "useful", "nice",
  "good", "great", "better", "best", "cool", "awesome", "proper", "real", "little",
  // Modifiers inside compound nouns. "incident response tracker" and "support
  // ticket system" name one record type each; without these the compound splits
  // into a spurious second entity.
  "support", "response", "operations", "ops", "helpdesk", "desk", "center", "centre",
  // Words naming the *shape* of the app, as "tracker" does.
  "directory", "registry", "catalog", "catalogue", "roster", "ledger", "index",
  // "inventory tracker for parts" tracks parts. Left in, "inventory" wins the
  // primary slot and the real record becomes an empty stub entity.
  "inventory",
  // Words naming a *view* of the data rather than the data itself. "report" and
  // "pipeline" are deliberately absent: an expense report or a deployment
  // pipeline is a legitimate record type.
  "kanban", "board", "swimlane", "dashboard", "overview", "analytics",
  "statistics", "metrics", "chart", "charts", "graph", "graphs",
  "calendar", "timetable", "agenda", "planner",
  // Categories of software, not record types. A CRM stores customers; an ERP
  // stores orders and stock. Treating the acronym as the entity produces a
  // "crm tracker" that keeps track of crms.
  "crm", "erp", "cms", "lms", "ats", "pos", "saas", "mvp", "poc", "portal",
  "intranet", "extranet", "backoffice", "helpdesk"
]);

/**
 * Words that name a *kind of app* on their own, but are the stored record when
 * a modifier precedes them. "Build an application" is a request for software;
 * "job application tracker" stores applications. Membership of this set only
 * changes what happens mid-compound — standing alone these stay structural.
 */
const compoundHeadWords = new Set(["application", "project", "product"]);

/**
 * Container nouns, which invert the head-final rule.
 *
 * A recipe book stores recipes and a photo album stores photos — the container
 * is the app, the modifier is the record. Only their *trailing* position carries
 * that sense, so a run ending in one of these drops it and keeps the modifier.
 * Leading, they are ordinary nouns: a "book tracker" really does track books.
 */
const containerTailWords = new Set([
  "book", "binder", "album", "collection", "library", "box", "shelf", "folder", "bin"
]);

/** Nouns that are features of an app rather than stored records. */
const featureNouns = new Set([
  "role", "roles", "permission", "permissions", "auth", "authentication", "login",
  "timeline", "history", "audit", "log", "logs", "event", "events", "activity",
  "search", "filter", "status", "state", "priority", "severity", "assignment",
  "assignee", "owner", "deadline", "due", "date", "dates", "comment", "comments", "note", "notes"
]);

const featurePatterns: Array<{ feature: ProjectFeature; pattern: RegExp }> = [
  // Deliberately excludes a bare singular "role": in "a job tracker with
  // company, role and status" the user wants a field, not 403s on every write.
  // Turning on access control they never asked for is the costlier mistake.
  { feature: "roles", pattern: /\b(roles|permissions?|rbac|access control|role[- ](?:based|controls?|access|permissions?))\b/i },
  { feature: "timeline", pattern: /\b(timeline|history|audit|activity|event log|events)\b/i },
  { feature: "status", pattern: /\b(status|state|workflow|open|closed|resolve|escalat)\w*\b/i },
  { feature: "priority", pattern: /\b(priority|severity|urgent|critical|triage)\w*\b/i },
  { feature: "assignment", pattern: /\b(assign|assignee|owner|responsible)\w*\b/i },
  { feature: "dueDates", pattern: /\b(due|deadline|sla|schedule|calendar)\w*\b/i },
  { feature: "search", pattern: /\b(search|filter|query|find|lookup)\w*\b/i },
  { feature: "dashboard", pattern: /\b(dashboard|summary|overview|report|reporting|analytics|stats|statistics|metrics|breakdown)\w*\b/i },
  { feature: "board", pattern: /\b(kanban|board|swimlane|pipeline|columns?)\w*\b/i },
  { feature: "calendar", pattern: /\b(calendar|schedule|scheduling|timetable|agenda|planner|booking|appointments?)\w*\b/i }
];

/** Singulars that already end in "s", so their plural really does add "es". */
const sStemPlurals = new Set([
  "buses", "statuses", "gases", "lenses", "campuses", "viruses", "bonuses",
  "focuses", "aliases", "atlases", "canvases", "biases", "surpluses"
]);

export function singularize(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;

  // "class/classes", "address/addresses": the stem already ends in a double s.
  if (word.length > 5 && word.endsWith("sses")) return word.slice(0, -2);

  // Sibilant plurals genuinely add "es": box/boxes, match/matches, dish/dishes.
  if (word.length > 4 && (word.endsWith("xes") || word.endsWith("ches") || word.endsWith("shes") || word.endsWith("zes"))) {
    return word.slice(0, -2);
  }

  // "-ses" is genuinely ambiguous: "statuses" comes from "status" but
  // "exercises" comes from "exercise", and the two are structurally identical.
  // No rule separates them, so the rarer "-s" stems are listed and everything
  // else takes the far more common "-se" reading. Resolving it the other way
  // round is what produced "exercis", "hous", "databas" and "respons".
  if (word.length > 4 && word.endsWith("ses") && sStemPlurals.has(word)) {
    return word.slice(0, -2);
  }

  // Singular words that simply end in "s". Without this the generic rule below
  // strips the last letter of a word that was never plural: "status" became
  // "statu", "analysis" became "analysi".
  if (word.endsWith("us") || word.endsWith("is") || word.endsWith("ss")) return word;

  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function pluralize(word: string): string {
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "generated-project";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Field names whose type is obvious from what they are called. Everything else
// falls back to a plain string rather than guessing.
/**
 * Type hints, matched against the whole label.
 *
 * These match on word boundaries rather than the entire string: real requests
 * say "unit price", "applied date" and "reorder level", not the bare noun. An
 * exact-match list types all of those as plain text, which then renders as a
 * free-text box where a number or date picker belongs.
 */
const fieldTypeHints: Array<{ pattern: RegExp; type: FieldType }> = [
  { pattern: /\b(e?mail|email address)\b/i, type: "email" },
  { pattern: /\b(phone|mobile|telephone|fax)\b/i, type: "phone" },
  { pattern: /\b(url|website|homepage|web ?site)\b/i, type: "url" },
  // Date before number: "due date" must not be caught by a numeric hint.
  { pattern: /\b(date|deadline|birthday|joined|expiry|expires?)\b/i, type: "date" },
  { pattern: /\b(price|cost|amount|total|salary|budget|rate|fee|balance|revenue)\b/i, type: "number" },
  { pattern: /\b(quantity|qty|count|stock|level|units?|servings?|score|rating|age|weight|calories)\b/i, type: "number" },
  { pattern: /\b(notes?|comments?|summary|details?|description|body|content|address|bio|ingredients?)\b/i, type: "text" },
  { pattern: /^(is |has )?(active|enabled|archived|paid|done|complete[d]?|verified|published|available)$/i, type: "boolean" }
];

/**
 * Words that can follow a field lead-in but are not custom fields.
 *
 * Deliberately NOT the whole of `structuralWords` or `featureNouns`: those lists
 * exist to stop a word becoming an *entity*, and a word that makes a poor entity
 * can still be a fine field. "website" is an app kind but also a contact field;
 * "notes" sounds feature-ish but no notes feature exists. Only words that would
 * either duplicate a generated feature field, or are pure filler, belong here.
 */
const fieldListStopWords = new Set([
  // Each already drives its own typed field, so a plain column would shadow it.
  // "role" (singular) is absent on purpose: it is a legitimate field name, and
  // only the plural/RBAC forms indicate the access-control feature.
  "roles", "role-based", "permission", "permissions", "rbac",
  "status", "state", "priority", "severity",
  "assignment", "assignee", "owner",
  "deadline", "due", "dates",
  "timeline", "history", "audit", "activity", "event", "events", "log", "logs",
  "search", "filter",
  "dashboard", "summary", "overview", "report", "reporting", "analytics",
  "stats", "statistics", "metrics", "breakdown",
  "kanban", "board", "swimlane", "pipeline", "column", "columns", "view", "views",
  "calendar", "schedule", "scheduling", "timetable", "agenda", "planner",
  // Meta-words describing the list itself.
  "field", "fields", "column", "columns", "attribute", "attributes",
  "property", "properties", "record", "records", "data",
  // Filler.
  "based", "control", "controls", "access", "support", "tracking",
  "everything", "anything", "them", "it", "that", "this"
]);

/**
 * Lead-ins that introduce *attributes*. Deliberately excludes "tracking" and
 * "storing", which introduce *records*: "tracking customers and agents" names
 * entities, while "with email and phone" names fields. Without this split the
 * two collapse and related entities turn into columns.
 *
 * A cardinality word after the lead-in means the clause describes a
 * *relationship*, not attributes: "projects have many tasks" states how two
 * records relate, and reading it as a field list produced a literal
 * `manyTasks: string` column alongside the correct `projectId` reference.
 * Refusing the match here lets the scan continue to the next lead-in, so the
 * genuine fields later in the sentence are still picked up.
 */
const fieldListLeadIn =
  /\b(?:with|having|has|have|including|containing|fields?)\s+(?!many\b|multiple\b|several\b|lots\s+of\b)([^.;!?]+)/gi;

/** Lead-ins that switch back from listing attributes to naming records. */
const entityLeadIn = /\s+(?:tracking|storing|linked\s+to|related\s+to)\s+/i;

/**
 * A field list ends where an entity clause begins: in "with status tracking
 * customers", only "status" is a field — "customers" is a second record type.
 */
function fieldPortionOf(segment: string): string {
  return segment.split(entityLeadIn)[0] ?? segment;
}

function inferFieldType(name: string): FieldType {
  for (const hint of fieldTypeHints) {
    if (hint.pattern.test(name)) return hint.type;
  }
  return "string";
}

/** Prepositions inside a field label add nothing to the identifier. */
const labelFillerWords = new Set(["in", "of", "on", "at", "to", "per"]);

/** camelCase a multi-word field label: "quantity in stock" -> "quantityStock". */
function toFieldName(label: string): string {
  const parts = label.trim().toLowerCase().split(/\s+/)
    .filter(Boolean)
    .filter((word, index) => index === 0 || !labelFillerWords.has(word));
  if (parts.length === 0) return "";
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

const maxInferredFields = 8;

/**
 * Pull an explicit field list out of the request.
 *
 * Matches the shape people actually write: "customers with email, phone and
 * company" or "tracking name, price and quantity". Only comma/and-separated
 * lists are read — inventing fields from loose prose would produce a data model
 * the user never asked for.
 */
/**
 * Plurals that really are one scalar value rather than a collection of records.
 * "notes" and "comments" are a block of text on the record; "invoices" are not.
 */
const scalarPlurals = new Set([
  "notes", "comments", "details", "instructions", "remarks", "contents",
  "directions", "credentials", "settings", "preferences"
]);

/**
 * A label naming a collection of records rather than a value on this record.
 *
 * "a client portal with invoices and payments" was producing
 * `invoices: string` — a field that cannot hold what its name promises. A
 * single-word plural is the signal: one client has many invoices, and an
 * invoice is plainly its own record with its own fields.
 *
 * Multi-word labels are excluded because they are almost always genuine
 * attributes — "quantity in stock" and "reorder level" describe the record.
 */
export function isCollectionLabel(label: string): boolean {
  const trimmed = label.trim().toLowerCase();
  if (!trimmed || trimmed.includes(" ")) return false;
  if (scalarPlurals.has(trimmed)) return false;

  return singularize(trimmed) !== trimmed;
}

export function extractFieldLabels(request: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const match of request.matchAll(new RegExp(fieldListLeadIn))) {
    const segment = fieldPortionOf(match[1]);
    // Split on commas and the final "and"/"or".
    for (const rawPart of segment.split(/\s*,\s*|\s+and\s+|\s+or\s+/i)) {
      const part = rawPart.trim().replace(/^(a|an|the|its|their)\s+/i, "");
      if (!part) continue;

      // Up to three words: "quantity in stock" and "unit price" are real field
      // names people write. Two was too strict and dropped them silently, which
      // is the worst outcome — the spec loses a field with no warning.
      const words = part.split(/\s+/);
      if (words.length > 3) continue;
      if (words.some((word) => !/^[a-z][a-z0-9-]*$/i.test(word))) continue;
      if (words.every((word) => fieldListStopWords.has(word.toLowerCase()))) continue;
      // A single stop word on its own is never a field.
      if (words.length === 1 && fieldListStopWords.has(words[0].toLowerCase())) continue;

      const name = toFieldName(part);
      if (!name || name.length < 2 || seen.has(name)) continue;
      seen.add(name);
      labels.push(part.toLowerCase());
      if (labels.length >= maxInferredFields) return labels;
    }
  }

  return labels;
}

export function detectFeatures(request: string): ProjectFeature[] {
  const found = featurePatterns
    .filter((candidate) => candidate.pattern.test(request))
    .map((candidate) => candidate.feature);

  // A board groups records into columns, which requires something to group by.
  // Asking for a kanban board without saying "status" still implies one.
  if (found.includes("board") && !found.includes("status")) {
    found.push("status");
  }

  // A calendar places records on days, so it needs a date to place them on.
  // The caller may still name their own date field, which takes precedence.
  if (found.includes("calendar") && !found.includes("dueDates")) {
    found.push("dueDates");
  }

  return found;
}

const maxEntities = 3;

/** Candidate record nouns, in the order the user mentioned them. */
/**
 * Verbs that open a request. Handled by position rather than by adding them to
 * the structural stop list, because several are ordinary nouns elsewhere: a
 * workout has a "set", a release has a "build", a game has a "design".
 */
const openingVerbs = new Set([
  "build", "create", "make", "generate", "add", "write", "implement", "design",
  "set", "setup", "configure", "scaffold", "draft", "plan", "start", "spin", "put", "give"
]);

function stripLeadingVerb(words: string[]): string[] {
  if (words.length < 2 || !openingVerbs.has(words[0])) return words;

  const rest = words.slice(1);
  // "set up", "spin up", "put together" leave a particle behind.
  if (rest.length > 1 && /^(up|out|together|off|on)$/.test(rest[0])) {
    return rest.slice(1);
  }
  return rest;
}

export function extractEntityNames(request: string): string[] {
  const words = stripLeadingVerb(
    request
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );

  // Consecutive candidate nouns form one compound. English compounds are
  // head-final — "gym membership" is a membership, "job application" is an
  // application — so each run collapses to its last word. Anything rejected
  // (a structural word, "and", a comma) breaks the run, which is what keeps
  // "tracking customers and agents" as two separate entities.
  const groups: string[][] = [];
  let current: string[] = [];

  const closeGroup = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };

  for (const [index, word] of words.entries()) {
    const singular = singularize(word);
    // "projects have many tasks": whatever owns a relationship is a record type,
    // whatever else the word usually means. Without this, a word like "project"
    // that normally names a kind of app is dropped even when the request is
    // plainly describing it as a thing being stored.
    const ownsRelationship = /^(have|has|own|owns|contain|contains|hold|holds)$/.test(words[index + 1] ?? "");

    const usable = word.length >= 3
      && singular.length >= 3
      && (ownsRelationship || (
        !structuralWords.has(word)
        && !structuralWords.has(singular)
        && !featureNouns.has(word)
        && !featureNouns.has(singular)
      ));

    if (usable && current.length > 0 && containerTailWords.has(singular)) {
      // "recipe book": the container ends the compound without becoming it.
      closeGroup();
    } else if (usable) {
      current.push(singular);
    } else if (current.length > 0 && compoundHeadWords.has(singular)) {
      // The modifier before it settles the ambiguity: this is the head of the
      // compound, and nothing after it belongs to the same run.
      current.push(singular);
      closeGroup();
    } else {
      closeGroup();
    }
  }
  closeGroup();

  const found: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const head = group[group.length - 1];
    if (seen.has(head)) continue;
    seen.add(head);
    found.push(head);
    if (found.length >= maxEntities) break;
  }

  return found;
}

/**
 * Only the primary entity takes the workflow fields. "status" and "priority" in a
 * request describe the thing being tracked, not every supporting record — a
 * customer does not have a priority.
 */
function fieldsFor(features: ProjectFeature[], primary: boolean, requested: string[] = []): EntityField[] {
  const fields: EntityField[] = [
    { name: "title", type: "string", required: true },
    { name: "description", type: "text", required: false }
  ];

  if (!primary) {
    return fields;
  }

  // Fields the user actually named, before the feature-driven ones. A stated
  // field is a stronger signal than anything inferred from a keyword.
  const taken = new Set(fields.map((field) => field.name));
  for (const label of requested) {
    const name = toFieldName(label);
    if (!name || taken.has(name)) continue;
    taken.add(name);
    fields.push({ name, type: inferFieldType(label), required: false });
  }

  if (features.includes("status")) {
    fields.push({
      name: "status",
      type: "enum",
      required: true,
      options: ["open", "in_progress", "resolved", "closed"]
    });
  }
  if (features.includes("priority")) {
    fields.push({
      name: "priority",
      type: "enum",
      required: true,
      options: ["low", "medium", "high", "critical"]
    });
  }
  if (features.includes("assignment") && !taken.has("assignee")) {
    fields.push({ name: "assignee", type: "string", required: false });
  }
  if (features.includes("dueDates") && !taken.has("dueDate")) {
    fields.push({ name: "dueDate", type: "date", required: false });
  }
  // Roles deliberately add no field here. Access control is enforced by the
  // server on every write; a "visibility" dropdown would look like permissions
  // while granting none.

  return fields;
}

/** Framing that opens a request without being part of what is being built. */
const requestOpeners = [
  /^(?:i|we)\s+(?:need|want|would\s+like)\s+(?:you\s+to\s+)?/i,
  /^(?:can|could|would)\s+you\s+(?:please\s+)?/i,
  /^help\s+(?:me|us)\s+(?:to\s+)?/i,
  /^let'?s\s+/i,
  /^please\s+/i
];

/** "build me a ...", "make us a ..." — who it is for, not what it is. */
const beneficiaryPronouns = new Set(["me", "us"]);

/** Words that begin a describing clause, so the name has ended. */
const titleClauseWords = new Set([
  "where", "with", "that", "which", "for", "tracking", "storing", "containing",
  "including", "having", "has", "have", "so", "to", "and", "plus"
]);

const maxTitleWords = 5;

/**
 * A name for the generated app.
 *
 * Without this the whole request became the title, so a support desk was called
 * "Build a support desk where tickets have a title, status, priority and due
 * date, tracking customers" — in the browser tab, the page heading, the health
 * endpoint and the folder name. The name is the first thing anyone sees of the
 * generated app, and a sentence is not a name.
 */
export function deriveTitle(request: string): string {
  let text = request.trim().replace(/[.!?]+$/, "");
  for (const opener of requestOpeners) text = text.replace(opener, "");

  // Commas survive the clean: they end a name just as a clause word does.
  let words = stripLeadingVerb(
    text.toLowerCase().replace(/[^a-z0-9\s,]/g, " ").split(/\s+/).filter(Boolean)
  );

  if (words.length > 1 && beneficiaryPronouns.has(words[0])) words = words.slice(1);
  if (words.length > 1 && /^(a|an|the)$/.test(words[0])) words = words.slice(1);

  const kept: string[] = [];
  for (const word of words) {
    const bare = word.replace(/,+$/, "");
    if (titleClauseWords.has(bare)) break;
    if (bare) kept.push(bare);
    if (word.endsWith(",") || kept.length >= maxTitleWords) break;
  }

  if (kept.length === 0) return "Generated Project";
  return kept.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function planProject(request: string, title?: string): ProjectSpec {
  const trimmed = request.trim();
  const features = detectFeatures(trimmed);

  // Entities are read from the request with the field lists removed, so
  // "customers with email and phone" yields the customer entity and three
  // fields, not four entities.
  const labels = extractFieldLabels(trimmed);
  // A plural in the list names records, not a value, so it has to survive into
  // entity extraction instead of being stripped with the rest of the segment.
  const collectionLabels = labels.filter(isCollectionLabel);

  const withoutFieldLists = trimmed.replace(new RegExp(fieldListLeadIn), (_full, segment: string) => {
    // Drop only the attribute portion; anything after a "tracking" clause names
    // records and must survive for entity extraction.
    const remainder = segment.slice(fieldPortionOf(segment).length);
    return remainder ? ` ${remainder}` : " ";
  });

  // Collections join the entity list directly rather than being fed back through
  // the text. Re-inserting them let the compound rule read "invoices payments"
  // as one noun and collapse it to a single "payment"; and a word like "product"
  // sits in the structural list, so it would be dropped on the way back in even
  // though the request plainly names it as something the app holds.
  const names = extractEntityNames(withoutFieldLists);
  for (const label of collectionLabels) {
    const singular = singularize(label.trim().toLowerCase());
    if (singular.length >= 3 && !names.includes(singular)) names.push(singular);
  }

  const entityNames = names.length > 0 ? names : ["item"];

  // Fields the request named explicitly, e.g. "customers with email and phone".
  const entityNameSet = new Set(entityNames);
  const requestedFields = labels
    .filter((label) => !isCollectionLabel(label))
    .filter((label) => !entityNameSet.has(singularize(label)));

  const entities: Entity[] = entityNames.map((name, index) => ({
    name,
    plural: pluralize(name),
    label: capitalize(name),
    fields: fieldsFor(features, index === 0, requestedFields)
  }));

  // Link the primary record to each supporting one, so the entities form a data
  // model rather than a set of unrelated lists. References are optional: a ticket
  // should be creatable before its customer record exists.
  if (entities.length > 1) {
    for (const related of entities.slice(1)) {
      entities[0].fields.push({
        name: `${related.name}Id`,
        type: "reference",
        required: false,
        references: related.plural
      });
    }
  }

  const resolvedTitle = title?.trim() || deriveTitle(trimmed);

  return {
    title: resolvedTitle,
    slug: slugify(resolvedTitle),
    summary: trimmed,
    entities,
    features
  };
}
