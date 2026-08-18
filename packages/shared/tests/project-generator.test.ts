import test from "node:test";
import assert from "node:assert/strict";
import { planProject, extractEntityNames, detectFeatures, pluralize, singularize, isCollectionLabel, deriveTitle, slugify } from "../src/projectPlan.js";
import { generateProject } from "../src/projectGenerator.js";

test("derives the entity from the request rather than a fixed template", () => {
  assert.deepEqual(
    planProject("Build a minimal incident response tracker").entities.map((e) => e.name),
    ["incident"]
  );
  // "ticket escalation" is one compound; its head is the escalation.
  assert.equal(
    planProject("Build an internal ticket escalation service").entities[0].name,
    "escalation"
  );
});

test("compound nouns resolve to a single entity", () => {
  // English compounds are head-final: a gym membership is a membership, an
  // expense report is a report. Each run of adjacent nouns collapses to its last.
  assert.deepEqual(extractEntityNames("gym membership system"), ["membership"]);
  assert.deepEqual(extractEntityNames("expense report tracker"), ["report"]);
  assert.deepEqual(extractEntityNames("job application tracker"), ["application"]);
  // Words filtered as app-shape break the run, leaving the real record.
  assert.deepEqual(extractEntityNames("incident response tracker"), ["incident"]);
  assert.deepEqual(extractEntityNames("support ticket system"), ["ticket"]);
  assert.deepEqual(extractEntityNames("customer directory"), ["customer"]);
  assert.deepEqual(extractEntityNames("task kanban board"), ["task"]);
});

test("an app-kind word is a record only when a modifier precedes it", () => {
  // "application" names software on its own, so it must not become an entity.
  assert.deepEqual(extractEntityNames("build an application to manage things"), []);
  // With a modifier in front it is the thing being stored.
  assert.deepEqual(extractEntityNames("job application tracker"), ["application"]);
  assert.deepEqual(extractEntityNames("client project tracker"), ["project"]);
  // The compound ends at the head: a following noun starts a new run.
  assert.deepEqual(
    extractEntityNames("job application tracker storing companies"),
    ["application", "company"]
  );
});

test("the record the app is for outranks the word naming the app", () => {
  // Without this, "inventory" takes the primary slot and "part" is left an
  // empty stub carrying none of the named fields.
  const spec = planProject(
    "Build an inventory tracker for parts with name, unit price and quantity in stock"
  );

  assert.deepEqual(spec.entities.map((e) => e.name), ["part"]);
  assert.deepEqual(
    spec.entities[0].fields.map((f) => `${f.name}:${f.type}`),
    [
      "title:string",
      "description:text",
      "name:string",
      "unitPrice:number",
      "quantityStock:number"
    ]
  );
});

test("a container noun keeps the thing it contains, not itself", () => {
  // A recipe book stores recipes; the head-final rule would keep the book.
  assert.deepEqual(extractEntityNames("recipe book app"), ["recipe"]);
  assert.deepEqual(extractEntityNames("photo album system"), ["photo"]);
  // Leading, the same word is an ordinary record type.
  assert.deepEqual(extractEntityNames("book tracker"), ["book"]);
});

test("a separator keeps genuinely distinct entities apart", () => {
  // "and" breaks the run, so these stay separate rather than collapsing.
  assert.deepEqual(
    extractEntityNames("ticket system tracking customers and agents"),
    ["ticket", "customer", "agent"]
  );
});

test("ignores words that describe the kind of app, not the records", () => {
  const names = extractEntityNames("Build a minimal internal dashboard tool platform system");

  assert.deepEqual(names, []);
});

test("falls back to a generic entity rather than inventing one", () => {
  const spec = planProject("Build something useful");

  assert.equal(spec.entities.length, 1);
  assert.equal(spec.entities[0].name, "item");
});

test("detects only features the request actually mentions", () => {
  assert.deepEqual(
    detectFeatures("with role controls and an event timeline").sort(),
    ["roles", "timeline"]
  );
  assert.deepEqual(detectFeatures("a plain list of notes"), []);
});

test("keeps a three-word field label instead of dropping it", () => {
  // Regression: "quantity in stock" exceeded a two-word limit and vanished from
  // the spec silently — the field the user asked for simply never existed.
  const spec = planProject("Build an inventory tracker with SKU, quantity in stock and unit price");
  const byName = new Map(spec.entities[0].fields.map((field) => [field.name, field.type]));

  assert.ok(byName.has("quantityStock"), "three-word label should survive");
  assert.equal(byName.get("quantityStock"), "number");
  assert.equal(byName.get("unitPrice"), "number");
});

test("types a field from any word in its label, not just an exact match", () => {
  const spec = planProject("Build a tracker with applied date, unit price and reorder level");
  const byName = new Map(spec.entities[0].fields.map((field) => [field.name, field.type]));

  assert.equal(byName.get("appliedDate"), "date");
  assert.equal(byName.get("unitPrice"), "number");
  assert.equal(byName.get("reorderLevel"), "number");
});

test("a bare role field does not switch on access control", () => {
  // "with company, role and status" wants a field; enabling RBAC would put 403s
  // on every write the user never asked to protect.
  const spec = planProject("Build a job tracker with company, role and status");

  assert.ok(!spec.features.includes("roles"));
  assert.ok(spec.entities[0].fields.some((field) => field.name === "role"));
});

test("explicit access-control wording still switches roles on", () => {
  for (const request of [
    "Build a tracker with role-based access",
    "Build a tracker with role controls",
    "Build a tracker with roles and permissions"
  ]) {
    assert.ok(planProject(request).features.includes("roles"), request);
  }
});

test("captures fields the request actually names", () => {
  const spec = planProject("Build a customer tracker with email, phone and company");
  const names = spec.entities[0].fields.map((field) => field.name);

  assert.ok(names.includes("email"));
  assert.ok(names.includes("phone"));
  assert.ok(names.includes("company"));
});

test("infers a sensible type for each named field", () => {
  const spec = planProject(
    "Build a contact tracker with email, phone, website, notes, balance and active"
  );
  const byName = new Map(spec.entities[0].fields.map((field) => [field.name, field.type]));

  assert.equal(byName.get("email"), "email");
  assert.equal(byName.get("phone"), "phone");
  assert.equal(byName.get("website"), "url");
  assert.equal(byName.get("notes"), "text");
  assert.equal(byName.get("balance"), "number");
  assert.equal(byName.get("active"), "boolean");
});

test("camel-cases a two-word field label", () => {
  const spec = planProject("Build an invoice tracker with due date and total amount");
  const names = spec.entities[0].fields.map((field) => field.name);

  assert.ok(names.includes("dueDate"));
  assert.ok(names.includes("totalAmount"));
});

test("does not turn related entities into columns", () => {
  // "tracking customers and agents" names entities, not fields.
  const spec = planProject("Build a ticket system tracking customers and agents");
  const names = spec.entities[0].fields.map((field) => field.name);

  assert.ok(!names.includes("customer"));
  assert.ok(!names.includes("agent"));
  assert.deepEqual(spec.entities.map((entity) => entity.name), ["ticket", "customer", "agent"]);
});

test("does not invent fields from loose prose", () => {
  const spec = planProject("Build a really nice simple tracker");
  const names = spec.entities[0].fields.map((field) => field.name);

  assert.deepEqual(names, ["title", "description"]);
});

test("a feature named inside a field list does not become a column", () => {
  // "with amount, status and a dashboard" names one field and two features.
  const spec = planProject("Build an invoice tracker with amount, status and a dashboard");
  const names = spec.entities[0].fields.map((field) => field.name);

  assert.ok(names.includes("amount"));
  assert.ok(!names.includes("dashboard"), "dashboard is a feature, not a field");
  assert.equal(spec.entities[0].fields.find((f) => f.name === "status")?.type, "enum");
});

test("a named field is not duplicated by a feature field", () => {
  const spec = planProject("Build a task tracker with due date and deadlines");
  const dueDates = spec.entities[0].fields.filter((field) => field.name === "dueDate");

  assert.equal(dueDates.length, 1);
});

test("generated validation enforces the inferred formats", () => {
  const server = generateProject(planProject("Build a contact tracker with email and website"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.match(server.content, /is not a valid email/);
  assert.match(server.content, /is not a valid url/);
});

test("the UI uses native input types for inferred fields", () => {
  const html = generateProject(planProject("Build a contact tracker with email, phone, website and active"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /type="email" name="email"/);
  assert.match(html.content, /type="tel" name="phone"/);
  assert.match(html.content, /type="url" name="website"/);
  assert.match(html.content, /type="checkbox" name="active"/);
});

test("plans every entity the request mentions", () => {
  const spec = planProject("Build a support ticket system tracking customers and agents");

  assert.deepEqual(spec.entities.map((entity) => entity.name), ["ticket", "customer", "agent"]);
});

test("only the primary entity carries the workflow fields", () => {
  // A customer does not have a priority.
  const spec = planProject("Build a ticket system tracking customers with status and priority");
  const [primary, secondary] = spec.entities;

  assert.ok(primary.fields.some((field) => field.name === "priority"));
  assert.deepEqual(secondary.fields.map((field) => field.name), ["title", "description"]);
});

test("roles add enforcement, not a decorative field", () => {
  // A "visibility" dropdown looked like permissions while granting none.
  const spec = planProject("Build a tracker with role-based access");
  const server = generateProject(spec).find((file) => file.path === "server.js");

  assert.ok(!spec.entities[0].fields.some((field) => field.name === "visibility"));
  assert.ok(server);
  assert.match(server.content, /rolePermissions/);
  assert.match(server.content, /sendJson\(response, 403/);
});

test("no role enforcement is emitted when roles were not requested", () => {
  const server = generateProject(planProject("Build a plain note keeper"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.doesNotMatch(server.content, /rolePermissions/);
});

test("links the primary entity to each supporting one", () => {
  const spec = planProject("Build a ticket system tracking customers and agents");
  const refs = spec.entities[0].fields.filter((field) => field.type === "reference");

  assert.deepEqual(refs.map((field) => field.name), ["customerId", "agentId"]);
  assert.deepEqual(refs.map((field) => field.references), ["customers", "agents"]);
  // Optional: a ticket must be creatable before its customer record exists.
  assert.ok(refs.every((field) => !field.required));
});

test("a single-entity project has no reference fields", () => {
  const spec = planProject("Build a note keeper");

  assert.ok(!spec.entities[0].fields.some((field) => field.type === "reference"));
});

test("generated server validates references and protects deletes", () => {
  const spec = planProject("Build a ticket system tracking customers");
  const server = generateProject(spec).find((file) => file.path === "server.js");

  assert.ok(server);
  assert.match(server.content, /referenceMap/);
  assert.match(server.content, /blockingReferences/);
  assert.match(server.content, /sendJson\(response, 409/);
});

test("number fields accept the strings an HTML form submits", () => {
  // Regression: the create form posts "500", and requiring a JS number made
  // every generated app with a numeric field unable to save one.
  const server = generateProject(planProject("Build an invoice tracker with amount"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.match(server.content, /Number\(String\(raw\)\.trim\(\)\)/);
  assert.match(server.content, /Number\.isFinite\(parsed\)/);
});

test("boolean fields are not flipped by the string \"false\"", () => {
  const server = generateProject(planProject("Build a task tracker with active"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.match(server.content, /"false", "0", "off", "no"/);
});

test("a calendar request implies a date field to place records on", () => {
  const spec = planProject("Build a shift schedule");

  assert.ok(spec.features.includes("calendar"));
  assert.ok(spec.features.includes("dueDates"));
  assert.ok(spec.entities[0].fields.some((field) => field.type === "date"));
});

test("a calendar emits a month grid and navigation", () => {
  const html = generateProject(planProject("Build an appointment calendar"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /class="calendar-grid"/);
  assert.match(html.content, /renderCalendar/);
  assert.match(html.content, /data-month="-1"/);
  assert.match(html.content, /data-view="calendar"/);
});

test("calendar dates are compared as strings, not Date objects", () => {
  // Parsing "2026-03-01" as a Date and reading local parts shifts the day in
  // negative-offset timezones, landing records on the wrong square.
  const html = generateProject(planProject("Build an appointment calendar"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /value\.slice\(0, 10\) !== key/);
});

test("records with no date are reported rather than silently dropped", () => {
  const html = generateProject(planProject("Build an appointment calendar"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /have no ' \+ calendarField \+ ' and are not shown/);
});

test("board and calendar can coexist as separate views", () => {
  const spec = planProject("Build a task kanban board with a delivery schedule");
  const html = generateProject(spec).find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /data-view="board"/);
  assert.match(html.content, /data-view="calendar"/);
});

test("no calendar code is emitted when none was requested", () => {
  const html = generateProject(planProject("Build a plain note keeper"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.doesNotMatch(html.content, /renderCalendar/);
});

test("calendar words do not become fields or entities", () => {
  const spec = planProject("Build an appointment calendar with a schedule view");

  assert.deepEqual(spec.entities.map((entity) => entity.name), ["appointment"]);
  const names = spec.entities[0].fields.map((field) => field.name);
  assert.ok(!names.includes("calendar"));
  assert.ok(!names.includes("schedule"));
});

test("a board request implies a status field to form columns", () => {
  // "kanban board for tasks" never says status, but a board needs columns.
  const spec = planProject("Build a kanban board for tasks");

  assert.ok(spec.features.includes("board"));
  assert.ok(spec.features.includes("status"));
  assert.equal(spec.entities[0].fields.find((f) => f.name === "status")?.type, "enum");
});

test("a board emits columns and a view toggle", () => {
  const html = generateProject(planProject("Build a task kanban board"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /class="board"/);
  assert.match(html.content, /data-view="board"/);
  assert.match(html.content, /renderBoard/);
  assert.match(html.content, /moveCard/);
});

test("moving a card patches the record rather than only moving the DOM", () => {
  // If the board reordered locally, the list view would disagree with it.
  const html = generateProject(planProject("Build a task kanban board"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /method: 'PATCH'/);
  assert.match(html.content, /\[boardField\]: next/);
});

test("no board code is emitted when none was requested", () => {
  const html = generateProject(planProject("Build a plain note keeper"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.doesNotMatch(html.content, /renderBoard/);
  assert.doesNotMatch(html.content, /data-view="board"/);
});

test("board words do not become fields", () => {
  const spec = planProject("Build a task tracker with a kanban board and columns");
  const names = spec.entities[0].fields.map((field) => field.name);

  assert.ok(!names.includes("kanban"));
  assert.ok(!names.includes("board"));
  assert.ok(!names.includes("columns"));
});

test("detects a dashboard request", () => {
  assert.ok(planProject("Build a ticket tracker with a dashboard").features.includes("dashboard"));
  assert.ok(planProject("Build a sales report with status").features.includes("dashboard"));
  assert.ok(!planProject("Build a plain note keeper").features.includes("dashboard"));
});

test("a dashboard emits a summary endpoint and a UI panel", () => {
  const spec = planProject("Build a ticket tracker with status, priority and a dashboard");
  const files = generateProject(spec);
  const server = files.find((file) => file.path === "server.js");
  const html = files.find((file) => file.path === "public/index.html");

  assert.ok(server && html);
  assert.match(server.content, /buildSummary/);
  assert.match(server.content, /collection === "summary"/);
  assert.match(html.content, /id="summary"/);
  assert.match(html.content, /loadSummary/);
});

test("no summary code is emitted when no dashboard was asked for", () => {
  const server = generateProject(planProject("Build a plain note keeper"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.doesNotMatch(server.content, /buildSummary/);
});

test("the summary groups by every enum field and totals every number field", () => {
  const spec = planProject("Build an invoice tracker with amount, status, priority and a dashboard");
  const server = generateProject(spec).find((file) => file.path === "server.js");

  assert.ok(server);
  // Route metadata the summary depends on.
  assert.match(server.content, /enumFields: \[\{"name":"status"/);
  assert.match(server.content, /numberFields: \["amount"\]/);
  assert.match(server.content, /average: numbers\.length \? sum \/ numbers\.length : null/);
});

test("an average over no rows is null, not zero", () => {
  // Reporting 0 as the average of nothing is a lie the UI would render as fact.
  const server = generateProject(planProject("Build an invoice tracker with amount and a dashboard"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.match(server.content, /numbers\.length \? sum \/ numbers\.length : null/);
});

test("the README documents the summary endpoint", () => {
  const readme = generateProject(planProject("Build a ticket tracker with status and a dashboard"))
    .find((file) => file.path === "README.md");

  assert.ok(readme);
  assert.match(readme.content, /\/api\/summary/);
});

test("a detected search feature is reachable from the UI", () => {
  // Regression: the planner detected search and the server implemented ?q=, but
  // the UI had no control, so the feature was unreachable.
  const spec = planProject("Build a ticket tracker with search");
  const html = generateProject(spec).find((file) => file.path === "public/index.html");
  const server = generateProject(spec).find((file) => file.path === "server.js");

  assert.ok(spec.features.includes("search"));
  assert.ok(html && server);
  assert.match(html.content, /type="search"/);
  assert.match(html.content, /\?q=' \+ encodeURIComponent/);
  assert.match(server.content, /searchParams\.get\("q"\)/);
});

test("no search control is emitted when search was not requested", () => {
  const spec = planProject("Build a plain note keeper");
  const html = generateProject(spec).find((file) => file.path === "public/index.html");

  assert.ok(!spec.features.includes("search"));
  assert.ok(html);
  assert.doesNotMatch(html.content, /type="search"/);
});

test("the README documents the features that were generated", () => {
  const readme = generateProject(planProject("Build a ticket tracker with search and role-based access"))
    .find((file) => file.path === "README.md");

  assert.ok(readme);
  assert.match(readme.content, /\?q=/);
  assert.match(readme.content, /x-role/);
  assert.match(readme.content, /only admins can delete/i);
});

test("the UI can update records, not only create and delete", () => {
  const html = generateProject(planProject("Build a ticket tracker with status and priority"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /renderEditRow/);
  assert.match(html.content, /method: 'PATCH'/);
  assert.match(html.content, /'Save'/);
  assert.match(html.content, /'Cancel'/);
});

test("the client receives full field metadata, not just names", () => {
  // Inline editing needs the type, options and reference target to build the
  // right control for each field.
  const html = generateProject(planProject("Build a ticket tracker with status tracking customers"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /"type":\s*"enum"/);
  assert.match(html.content, /"options":/);
  assert.match(html.content, /"references":\s*"customers"/);
});

test("reference selects are populated after the edit row is in the document", () => {
  // Regression: fillReferences() scans the document, so calling it while the row
  // was still detached left the select empty and saving silently cleared the
  // reference — losing the link between records.
  const html = generateProject(planProject("Build a ticket tracker tracking customers"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  const insertIndex = html.content.indexOf("tr.replaceWith(editRow)");
  const fillIndex = html.content.indexOf("fillReferences();", insertIndex);
  assert.ok(insertIndex > -1, "edit row should be inserted before references are filled");
  assert.ok(fillIndex > insertIndex, "fillReferences must run after insertion");
});

test("a pending reference value is used when options have not loaded", () => {
  const html = generateProject(planProject("Build a ticket tracker tracking customers"))
    .find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /dataset\.pending/);
});

test("reference inputs render as a picker, not a raw id box", () => {
  const spec = planProject("Build a ticket system tracking customers");
  const html = generateProject(spec).find((file) => file.path === "public/index.html");

  assert.ok(html);
  assert.match(html.content, /select name="customerId" data-ref="customers"/);
  assert.match(html.content, /fillReferences/);
});

test("fields follow from detected features", () => {
  const plain = planProject("Build a note keeper");
  const rich = planProject("Build a ticket tracker with status, priority, assignee and due dates");

  assert.deepEqual(plain.entities[0].fields.map((f) => f.name), ["title", "description"]);
  const richFields = rich.entities[0].fields.map((f) => f.name);
  assert.ok(richFields.includes("status"));
  assert.ok(richFields.includes("priority"));
  assert.ok(richFields.includes("assignee"));
  assert.ok(richFields.includes("dueDate"));
});

test("pluralization handles the awkward cases", () => {
  assert.equal(pluralize("incident"), "incidents");
  assert.equal(pluralize("policy"), "policies");
  assert.equal(pluralize("class"), "classes");
  assert.equal(singularize("policies"), "policy");
  assert.equal(singularize("tickets"), "ticket");
});

test("generates a project with no npm dependencies", () => {
  const files = generateProject(planProject("Build an incident tracker"));
  const pkg = files.find((file) => file.path === "package.json");

  assert.ok(pkg);
  const parsed = JSON.parse(pkg.content);
  assert.equal(parsed.dependencies, undefined, "generated projects must install nothing");
  assert.equal(parsed.scripts.start, "node server.js");
});

test("never imports a package it does not declare", () => {
  // The previous generator imported express while declaring no dependencies, so
  // generated projects could not start at all.
  const files = generateProject(planProject("Build an incident tracker"));

  for (const file of files.filter((entry) => entry.path.endsWith(".js"))) {
    const imports = [...file.content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of imports) {
      const isBuiltin = specifier.startsWith("node:");
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      assert.ok(isBuiltin || isRelative, `${file.path} imports bare specifier: ${specifier}`);
    }
  }
});

test("emits routes and validation for every entity", () => {
  const spec = planProject("Build a ticket system tracking customers and agents");
  const server = generateProject(spec).find((file) => file.path === "server.js");

  assert.ok(server);
  for (const entity of spec.entities) {
    assert.match(server.content, new RegExp(`collection: "${entity.plural}"`));
    assert.match(server.content, new RegExp(`validate${entity.label}\\b`));
  }
});

test("the UI exposes a section per entity", () => {
  const spec = planProject("Build a ticket system tracking customers and agents");
  const html = generateProject(spec).find((file) => file.path === "public/index.html");

  assert.ok(html);
  for (const entity of spec.entities) {
    assert.ok(html.content.includes(`data-collection="${entity.plural}"`), `missing UI for ${entity.plural}`);
  }
});

test("wires timeline events only when the request asks for them", () => {
  const withTimeline = generateProject(planProject("Build an incident tracker with an event timeline"))
    .find((file) => file.path === "server.js");
  const without = generateProject(planProject("Build an incident tracker"))
    .find((file) => file.path === "server.js");

  assert.ok(withTimeline && without);
  assert.match(withTimeline.content, /recordEvent/);
  assert.doesNotMatch(without.content, /recordEvent/);
});

test("the UI form exposes exactly the derived fields", () => {
  const spec = planProject("Build a ticket tracker with status and priority");
  const html = generateProject(spec).find((file) => file.path === "public/index.html");

  assert.ok(html);
  for (const field of spec.entities[0].fields) {
    assert.ok(html.content.includes(`name="${field.name}"`), `missing input for ${field.name}`);
  }
});

test("generated JavaScript parses as a valid ES module", async () => {
  // Catches template-assembly mistakes that would otherwise only surface at runtime.
  // SourceTextModule compiles without executing, so this cannot start a server.
  const vm = await import("node:vm");
  const files = generateProject(planProject("Build a ticket tracker with status, priority and timeline"));

  for (const file of files.filter((entry) => entry.path.endsWith(".js"))) {
    assert.doesNotThrow(
      () => new vm.SourceTextModule(file.content),
      `${file.path} is not valid JavaScript`
    );
  }
});

test("every generated file has content", () => {
  const files = generateProject(planProject("Build an incident tracker with roles and timeline"));

  assert.ok(files.length >= 6);
  for (const file of files) {
    assert.ok(file.content.trim().length > 0, `${file.path} is empty`);
    assert.ok(!file.path.startsWith("/"), `${file.path} must be relative`);
  }
});

test("a 'have many' clause is a relationship, not a field", () => {
  // The regression: "projects have many tasks" was read as a field list, so the
  // task entity gained a literal `manyTasks: string` column beside the correct
  // projectId reference.
  const spec = planProject(
    "Build me a task tracker where projects have many tasks, tasks have a title, status and due date"
  );

  const task = spec.entities.find((entity) => entity.name === "task");
  assert.ok(task, "expected a task entity");

  const fieldNames = task.fields.map((field) => field.name);
  assert.ok(!fieldNames.includes("manyTasks"), `cardinality leaked into fields: ${fieldNames.join(", ")}`);

  // The relationship itself is still captured, and the real fields survive.
  assert.ok(fieldNames.includes("projectId"), "expected the relation to remain");
  assert.ok(fieldNames.includes("dueDate"), "expected the fields after the clause to survive");
});

test("cardinality words never become fields", () => {
  for (const request of [
    "Build a blog where posts have many comments, posts have a title and body",
    "Build a store where orders have multiple line items, orders have a total",
    "Build a team tool where teams have several members, members have a name"
  ]) {
    const spec = planProject(request);
    for (const entity of spec.entities) {
      for (const field of entity.fields) {
        assert.doesNotMatch(
          field.name,
          /^(many|multiple|several)/i,
          `"${request}" produced field ${entity.name}.${field.name}`
        );
      }
    }
  }
});

test("an ordinary 'with' field list is still read", () => {
  // The guard must not cost us the common case.
  const spec = planProject("Create a CRM with email, phone and company");
  const fieldNames = spec.entities[0].fields.map((field) => field.name);

  assert.ok(fieldNames.includes("email"));
  assert.ok(fieldNames.includes("phone"));
  assert.ok(fieldNames.includes("company"));
});

test("plurals ending in -ses singularize to the right stem", () => {
  // The regression: "exercises" became "exercis" and "houses" became "hous",
  // which then appeared verbatim in entity names, routes and generated code.
  assert.equal(singularize("exercises"), "exercise");
  assert.equal(singularize("houses"), "house");
  assert.equal(singularize("purchases"), "purchase");
  assert.equal(singularize("databases"), "database");
  assert.equal(singularize("responses"), "response");
  assert.equal(singularize("licenses"), "license");
});

test("the genuinely -s stems still take -es", () => {
  // "statuses" really does come from "status"; these are the exceptions the
  // -se default cannot detect on its own.
  assert.equal(singularize("statuses"), "status");
  assert.equal(singularize("buses"), "bus");
  assert.equal(singularize("gases"), "gas");
});

test("sibilant and double-s plurals are unaffected", () => {
  assert.equal(singularize("classes"), "class");
  assert.equal(singularize("addresses"), "address");
  assert.equal(singularize("boxes"), "box");
  assert.equal(singularize("matches"), "match");
  assert.equal(singularize("dishes"), "dish");
  assert.equal(singularize("categories"), "category");
});

test("a leading phrasal verb never becomes the entity", () => {
  // "Set up a habit tracker" was producing an entity literally named "set".
  const names = extractEntityNames("Set up a habit tracker with daily streaks");
  assert.ok(!names.includes("set"), `got ${names.join(", ")}`);
  assert.ok(names.includes("habit"), `got ${names.join(", ")}`);

  assert.deepEqual(extractEntityNames("Spin up a booking service for rooms"), ["booking", "room"]);
  // "set" is only stripped in the opening verb position; elsewhere it is a noun.
  assert.ok(extractEntityNames("Build a workout log where a set has reps").includes("set"));
});

test("interrogatives, pronouns and behaviour verbs are never entities", () => {
  const names = extractEntityNames("Create a plant care app that reminds me when to water each plant");

  for (const junk of ["remind", "reminds", "when", "me", "each", "that"]) {
    assert.ok(!names.includes(junk), `"${junk}" must not be an entity, got ${names.join(", ")}`);
  }
  assert.ok(names.includes("plant"), `expected plant among ${names.join(", ")}`);
});

test("a relationship verb is not mistaken for a record type", () => {
  // "students have many grades" was yielding an entity named "have".
  const names = extractEntityNames("Build a school gradebook where students have many grades");

  assert.ok(!names.includes("have"), `got ${names.join(", ")}`);
  assert.ok(names.includes("student"), `expected student among ${names.join(", ")}`);
  assert.ok(names.includes("grade"), `expected grade among ${names.join(", ")}`);
});

test("a container noun names the app, not the record", () => {
  // A recipe box stores recipes; the box is the app.
  assert.equal(planProject("Build a recipe box where recipes have a name and servings").entities[0].name, "recipe");
});

test("entity names never contain a mangled stem", () => {
  const requests = [
    "Build a gym log where workouts have many exercises, exercises have reps and weight",
    "Build a property site where houses have a price and address",
    "Create a shop where purchases have a total"
  ];

  for (const request of requests) {
    for (const entity of planProject(request).entities) {
      assert.doesNotMatch(
        entity.name,
        /(exercis|hous|purchas|databas|respons|licens)$/,
        `"${request}" produced a mangled entity name: ${entity.name}`
      );
    }
  }
});

test("a plural in a field list becomes a record type, not a string column", () => {
  // The regression: "with invoices and payments" produced client.invoices:string
  // and client.payments:string — fields that cannot hold what they name.
  const spec = planProject("I need a client portal with invoices and payments");
  const names = spec.entities.map((entity) => entity.name);

  assert.ok(names.includes("invoice"), `got ${names.join(", ")}`);
  assert.ok(names.includes("payment"), `got ${names.join(", ")}`);

  const client = spec.entities.find((entity) => entity.name === "client");
  assert.ok(client);
  for (const field of client.fields) {
    assert.ok(!/^(invoices|payments)$/.test(field.name), `${field.name} should be a relation`);
  }
  // And they are linked, not merely present.
  assert.ok(client.fields.some((field) => field.name === "invoiceId" && field.type === "reference"));
});

test("scalar plurals stay fields", () => {
  // "notes" and "comments" are a block of text on the record, not a collection.
  const expense = planProject("Create an expense tracker with amount, category, date and notes");
  const fields = expense.entities[0].fields.map((field) => field.name);

  assert.ok(fields.includes("notes"), `got ${fields.join(", ")}`);
  assert.ok(!expense.entities.some((entity) => entity.name === "note"));

  const blog = planProject("Build a blog with posts and comments");
  const blogFields = blog.entities[0].fields.map((field) => field.name);
  assert.ok(blogFields.includes("comments"));
  // ...while "posts" is plainly its own record.
  assert.ok(blog.entities.some((entity) => entity.name === "post"));
});

test("a multi-word label is an attribute, not a collection", () => {
  // "quantity in stock" describes the record; only bare plurals name records.
  const spec = planProject("Build an inventory system with products, quantity in stock and reorder level");
  const product = spec.entities.find((entity) => entity.name === "product");

  assert.ok(product, `expected a product entity, got ${spec.entities.map((e) => e.name).join(", ")}`);
  const fields = product.fields.map((field) => field.name);
  assert.ok(fields.includes("quantityStock"), `got ${fields.join(", ")}`);
  assert.ok(fields.includes("reorderLevel"), `got ${fields.join(", ")}`);
});

test("singular field lists are unchanged", () => {
  const fields = planProject("Create a CRM with email, phone and company").entities[0].fields.map((f) => f.name);

  for (const expected of ["email", "phone", "company"]) {
    assert.ok(fields.includes(expected), `got ${fields.join(", ")}`);
  }
});

test("collection labels are recognized precisely", () => {
  assert.equal(isCollectionLabel("invoices"), true);
  assert.equal(isCollectionLabel("payments"), true);
  assert.equal(isCollectionLabel("notes"), false);
  assert.equal(isCollectionLabel("comments"), false);
  assert.equal(isCollectionLabel("quantity in stock"), false);
  assert.equal(isCollectionLabel("email"), false);
  assert.equal(isCollectionLabel("status"), false);
});

test("a generated app gets a name, not the request sentence", () => {
  // The regression: the whole request became the browser title, the page
  // heading, the /health service name and the folder slug.
  assert.equal(deriveTitle("Build a support desk where tickets have a title, status and priority"), "Support Desk");
  assert.equal(deriveTitle("I need a client portal with invoices and payments"), "Client Portal");
  assert.equal(deriveTitle("Build me a task tracker where projects have many tasks"), "Task Tracker");
  assert.equal(deriveTitle("Create an expense tracker with amount, category and notes"), "Expense Tracker");
  assert.equal(deriveTitle("Make a reading list app"), "Reading List App");
});

test("the derived title produces a usable slug", () => {
  const spec = planProject("Build a support desk where tickets have a title, status and priority");

  assert.equal(spec.title, "Support Desk");
  assert.equal(spec.slug, "support-desk");
});

test("an explicit title still wins", () => {
  assert.equal(planProject("Build a support desk", "Helpdesk").title, "Helpdesk");
});

test("a title is never empty and never a whole sentence", () => {
  for (const request of [
    "Build something useful",
    "app",
    "Build a really long thing where many words follow on and on and on forever"
  ]) {
    const title = deriveTitle(request);
    assert.ok(title.length > 0, `empty title for "${request}"`);
    assert.ok(title.split(/\s+/).length <= 5, `title too long: "${title}"`);
  }
});

test("the display plural is not the label with an s stuck on", () => {
  // The generated UI showed "Deliverys" in its tabs and dashboard while the
  // search box beside it correctly said "deliveries".
  const spec = planProject("Build a delivery board where jobs have a title and status");
  const delivery = spec.entities.find((entity) => entity.name === "delivery");

  assert.ok(delivery);
  assert.equal(delivery.labelPlural, "Deliveries");
  assert.notEqual(delivery.labelPlural, `${delivery.label}s`);
});

test("every entity carries a display plural matching its collection", () => {
  for (const request of [
    "Build a delivery board where jobs have a title",
    "Build a class scheduler where classes have a room",
    "Build a company directory with an address"
  ]) {
    for (const entity of planProject(request).entities) {
      assert.equal(
        entity.labelPlural.toLowerCase(),
        entity.plural,
        `${entity.name}: labelPlural must match the route collection`
      );
    }
  }
});

test("the generated UI never builds its own plural", () => {
  // Guards the two sites that used to append "s": the tab buttons and the
  // dashboard summary heading.
  const files = generateProject(planProject("Build a delivery board where jobs have a title and status"));
  const html = files.find((file) => file.path.endsWith("index.html"));

  assert.ok(html);
  assert.ok(html.content.includes("Deliveries"), "tab should use the display plural");

  // No generated file may contain the hand-built plural, or the code that
  // produces one at runtime.
  for (const file of files) {
    assert.ok(!file.content.includes("Deliverys"), `${file.path} contains a hand-built plural`);
    assert.ok(!/label \+ 's'/.test(file.content), `${file.path} appends s to a label`);
  }
});

test("a second field list is not swallowed by the first lead-in", () => {
  // The regression: "with a calendar of appointments" ran to the end of the
  // sentence, so "have a patient, start date and status" was never matched and
  // "patient" appeared nowhere in the result — named by the user, silently lost.
  const spec = planProject(
    "Build a clinic booking app with a calendar of appointments where visits have a patient, start date and status"
  );
  const fields = spec.entities[0].fields.map((field) => field.name);

  assert.ok(fields.includes("patient"), `patient was dropped; got ${fields.join(", ")}`);
  assert.ok(fields.includes("startDate"), `got ${fields.join(", ")}`);
});

test("a view described in the request is not stored as a column", () => {
  // "a calendar of appointments" asks for a screen. It must not become a
  // calendarAppointments string beside the real fields.
  const spec = planProject(
    "Build a clinic booking app with a calendar of appointments where visits have a patient and start date"
  );

  for (const entity of spec.entities) {
    for (const field of entity.fields) {
      assert.doesNotMatch(field.name, /^calendar/i, `${entity.name}.${field.name} is a view, not a field`);
    }
  }
  // The view itself is still recognised.
  assert.ok(spec.features.includes("calendar"));
});

test("a slug never ends on a separator", () => {
  // The regression, shared by all four copies: the length cap was applied after
  // trimming, so a slice could land mid-separator and leave a trailing hyphen.
  const slug = slugify("a".repeat(59) + " beta gamma");

  assert.ok(!slug.endsWith("-"), `slug ended on a separator: "${slug}"`);
  assert.ok(!slug.startsWith("-"));
  assert.ok(slug.length <= 60);
});

test("slugify takes the caller's fallback and cap", () => {
  assert.equal(slugify("", "workspace"), "workspace");
  assert.equal(slugify("!!!", "custom-build"), "custom-build");
  assert.equal(slugify("Support Desk"), "support-desk");
  assert.equal(slugify("x".repeat(80), "workspace", 64).length, 64);
});

test("slugify is stable for ordinary names", () => {
  assert.equal(slugify("Ops Runbook v2"), "ops-runbook-v2");
  assert.equal(slugify("  Client   Portal  "), "client-portal");
});

test("a generated server caps the request body it will buffer", () => {
  // Every generated app buffers a body in memory before parsing it. Without a
  // ceiling a single large POST is enough to exhaust the process.
  const server = generateProject(planProject("Build a support desk where tickets have a title and status"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.match(server.content, /maxBodyBytes/);
  assert.match(server.content, /413/);
  assert.match(server.content, /Request body too large/);
});

test("an oversized body is drained rather than abandoned", () => {
  // Bailing out of the stream closes the socket, and the client sees a
  // connection reset instead of the 413 that explains the problem. The loop
  // must keep reading while it stops buffering.
  const server = generateProject(planProject("Build a support desk where tickets have a title and status"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  assert.doesNotMatch(server.content, /request\.destroy\(\)/);
  assert.match(server.content, /tooLarge = true/);
  assert.match(server.content, /continue;/);
});

test("both write paths check the size before the JSON", () => {
  // POST and PATCH both read a body, so both need the guard; checking the
  // JSON first would report "Invalid JSON body" for a body that was simply
  // too large to buffer.
  const server = generateProject(planProject("Build a support desk where tickets have a title and status"))
    .find((file) => file.path === "server.js");

  assert.ok(server);
  const tooLargeChecks = server.content.match(/body === bodyTooLarge/g) ?? [];
  assert.equal(tooLargeChecks.length, 2, "expected the guard on both POST and PATCH");

  const tooLargeIndex = server.content.indexOf("body === bodyTooLarge");
  const nullIndex = server.content.indexOf("body === null");
  assert.ok(tooLargeIndex < nullIndex, "size must be checked before JSON validity");
});

test("a container noun does not become the project name", () => {
  // "an app to track invoices" was titled "App": the article was dropped, the
  // container noun kept, and the scan stopped at "to" — a correct clause
  // boundary reached one word too early. Every project is an app, so the word
  // distinguishes nothing, and a folder of them called app, app-2, app-3 is
  // unusable.
  for (const request of [
    "Build me an app to track invoices with a client name, amount and due date.",
    "Build an app to track invoices",
    "an app to track invoices",
    "a tool to track invoices",
    "a system for tracking invoices"
  ]) {
    const title = deriveTitle(request);
    assert.notEqual(title, "App", request);
    assert.notEqual(title, "Tool", request);
    assert.notEqual(title, "System", request);
    assert.match(title.toLowerCase(), /invoice/, request);
  }
});

test("a request that is only a container noun keeps it", () => {
  // There is nothing better to offer here, and "App" beats "Generated Project".
  assert.equal(deriveTitle("build an app"), "App");
  assert.equal(deriveTitle("build me a tool"), "Tool");
});

test("the scaffold folder follows the title, not the container noun", () => {
  const spec = planProject("Build me an app to track invoices with a client name and amount");
  assert.match(slugify(spec.title, "app", 60), /invoice/);
});
