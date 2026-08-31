// Deterministic code generation.
//
// Emits a project that actually runs. Two rules make that guarantee hold:
//
//  1. Zero npm dependencies. The output uses only the Node standard library, so
//     `node server.js` works with no install step and no network.
//  2. Nothing is emitted that is not derived from the spec. Every route, field and
//     form input traces back to an entity or feature the planner actually found.
//
// The previous generator wrote a fixed skeleton that imported express while
// declaring no dependencies, so generated projects could not start at all.

import type { Entity, EntityField, ProjectSpec } from "./projectPlan.js";

export type GeneratedFile = {
  /** Path relative to the project root, using forward slashes. */
  path: string;
  content: string;
};

function defaultValueFor(field: EntityField): string {
  if (field.type === "enum") return JSON.stringify(field.options?.[0] ?? "");
  if (field.type === "number") return "0";
  if (field.type === "boolean") return "false";
  return '""';
}

function validationFor(entity: Entity): string {
  const lines: string[] = [];
  lines.push("function validate" + entity.label + "(input) {");
  lines.push("  const errors = [];");
  lines.push("  const value = {};");

  for (const field of entity.fields) {
    const key = JSON.stringify(field.name);
    lines.push("");
    lines.push("  // " + field.name + " (" + field.type + (field.required ? ", required" : "") + ")");

    if (field.type === "number") {
      // HTML forms submit strings, so a numeric string is coerced rather than
      // rejected — otherwise the generated create form could never save a number.
      lines.push("  {");
      lines.push("    const raw = input[" + key + "];");
      lines.push("    if (raw === undefined || raw === null || raw === \"\") {");
      lines.push(field.required
        ? "      errors.push(" + JSON.stringify(field.name + " is required") + ");"
        : "      value[" + key + "] = 0;");
      lines.push("    } else {");
      lines.push("      const parsed = typeof raw === \"number\" ? raw : Number(String(raw).trim());");
      lines.push("      if (!Number.isFinite(parsed)) {");
      lines.push("        errors.push(" + JSON.stringify(field.name + " must be a number") + ");");
      lines.push("      } else {");
      lines.push("        value[" + key + "] = parsed;");
      lines.push("      }");
      lines.push("    }");
      lines.push("  }");
      continue;
    }

    if (field.type === "boolean") {
      // A checkbox posts "on"; JSON may send a real boolean or the string
      // "false", which is truthy and would otherwise flip the value.
      lines.push("  {");
      lines.push("    const raw = input[" + key + "];");
      lines.push("    value[" + key + "] = typeof raw === \"string\"");
      lines.push("      ? !([\"\", \"false\", \"0\", \"off\", \"no\"].includes(raw.trim().toLowerCase()))");
      lines.push("      : Boolean(raw);");
      lines.push("  }");
      continue;
    }

    if (field.type === "enum") {
      const options = JSON.stringify(field.options ?? []);
      lines.push("  const allowed" + field.name + " = " + options + ";");
      lines.push("  if (input[" + key + "] === undefined) {");
      lines.push("    value[" + key + "] = allowed" + field.name + "[0];");
      lines.push("  } else if (!allowed" + field.name + ".includes(input[" + key + "])) {");
      lines.push("    errors.push(" + JSON.stringify(field.name + " must be one of: ")
        + " + allowed" + field.name + ".join(\", \"));");
      lines.push("  } else {");
      lines.push("    value[" + key + "] = input[" + key + "];");
      lines.push("  }");
      continue;
    }

    if (field.type === "reference") {
      const target = JSON.stringify(field.references ?? "");
      lines.push("  if (input[" + key + "] === undefined || input[" + key + "] === null || input[" + key + "] === \"\") {");
      lines.push(field.required
        ? "    errors.push(" + JSON.stringify(field.name + " is required") + ");"
        : "    value[" + key + "] = null;");
      lines.push("  } else if (typeof input[" + key + "] !== \"string\") {");
      lines.push("    errors.push(" + JSON.stringify(field.name + " must be an id") + ");");
      lines.push("  } else if (!store.get(" + target + ", input[" + key + "])) {");
      // Referential integrity: a dangling id is worse than a rejected write.
      lines.push("    errors.push(" + JSON.stringify(field.name + " does not match any record in ")
        + " + " + target + ");");
      lines.push("  } else {");
      lines.push("    value[" + key + "] = input[" + key + "];");
      lines.push("  }");
      continue;
    }

    if (field.type === "email" || field.type === "url" || field.type === "phone") {
      // Format-checked so bad contact data is caught at the edge, not discovered
      // later by whoever tries to use it.
      const shape = field.type === "email"
        ? "/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/"
        : field.type === "url"
          ? "/^https?:\\/\\/[^\\s]+$/i"
          : "/^[+()\\d][\\d\\s().-]{5,}$/";
      lines.push("  if (typeof input[" + key + "] === \"string\" && input[" + key + "].trim()) {");
      lines.push("    const candidate = input[" + key + "].trim();");
      lines.push("    if (" + shape + ".test(candidate)) {");
      lines.push("      value[" + key + "] = candidate;");
      lines.push("    } else {");
      lines.push("      errors.push(" + JSON.stringify(field.name + " is not a valid " + field.type) + ");");
      lines.push("    }");
      lines.push("  } else if (" + String(field.required) + ") {");
      lines.push("    errors.push(" + JSON.stringify(field.name + " is required") + ");");
      lines.push("  } else {");
      lines.push("    value[" + key + "] = \"\";");
      lines.push("  }");
      continue;
    }

    // string, text and date all arrive as strings over JSON.
    lines.push("  if (typeof input[" + key + "] === \"string\" && input[" + key + "].trim()) {");
    lines.push("    value[" + key + "] = input[" + key + "].trim();");
    lines.push("  } else if (" + String(field.required) + ") {");
    lines.push("    errors.push(" + JSON.stringify(field.name + " is required") + ");");
    lines.push("  } else {");
    lines.push("    value[" + key + "] = " + defaultValueFor(field) + ";");
    lines.push("  }");
  }

  lines.push("");
  lines.push("  return { errors, value };");
  lines.push("}");
  return lines.join("\n");
}

function storeFile(): string {
  return [
    "import { readFileSync, writeFileSync, existsSync, mkdirSync } from \"node:fs\";",
    "import path from \"node:path\";",
    "",
    "// Records persist to a JSON file so data survives a restart. No database and no",
    "// dependencies — swap this module for a real driver when you outgrow it.",
    "export function createStore(dataDir, collections) {",
    "  if (!existsSync(dataDir)) {",
    "    mkdirSync(dataDir, { recursive: true });",
    "  }",
    "",
    "  const filePath = path.join(dataDir, \"data.json\");",
    "",
    "  function readAll() {",
    "    if (!existsSync(filePath)) {",
    "      const empty = {};",
    "      for (const name of collections) empty[name] = [];",
    "      return empty;",
    "    }",
    "    try {",
    "      const parsed = JSON.parse(readFileSync(filePath, \"utf8\"));",
    "      for (const name of collections) {",
    "        if (!Array.isArray(parsed[name])) parsed[name] = [];",
    "      }",
    "      return parsed;",
    "    } catch {",
    "      // A corrupt file must not take the server down.",
    "      const empty = {};",
    "      for (const name of collections) empty[name] = [];",
    "      return empty;",
    "    }",
    "  }",
    "",
    "  function writeAll(data) {",
    "    writeFileSync(filePath, JSON.stringify(data, null, 2), \"utf8\");",
    "  }",
    "",
    "  return {",
    "    list(collection) {",
    "      return readAll()[collection] ?? [];",
    "    },",
    "    get(collection, id) {",
    "      return (readAll()[collection] ?? []).find((row) => row.id === id) ?? null;",
    "    },",
    "    create(collection, record) {",
    "      const data = readAll();",
    "      data[collection] = data[collection] ?? [];",
    "      data[collection].push(record);",
    "      writeAll(data);",
    "      return record;",
    "    },",
    "    update(collection, id, patch) {",
    "      const data = readAll();",
    "      const rows = data[collection] ?? [];",
    "      const index = rows.findIndex((row) => row.id === id);",
    "      if (index === -1) return null;",
    "      rows[index] = { ...rows[index], ...patch, id, updatedAt: new Date().toISOString() };",
    "      data[collection] = rows;",
    "      writeAll(data);",
    "      return rows[index];",
    "    },",
    "    remove(collection, id) {",
    "      const data = readAll();",
    "      const rows = data[collection] ?? [];",
    "      const index = rows.findIndex((row) => row.id === id);",
    "      if (index === -1) return false;",
    "      rows.splice(index, 1);",
    "      data[collection] = rows;",
    "      writeAll(data);",
    "      return true;",
    "    }",
    "  };",
    "}",
    ""
  ].join("\n");
}

function serverFile(spec: ProjectSpec): string {
  const collections = JSON.stringify(spec.entities.map((entity) => entity.plural));
  const hasTimeline = spec.features.includes("timeline");
  const hasSearch = spec.features.includes("search");

  const lines: string[] = [
    "import { createServer } from \"node:http\";",
    "import { readFile } from \"node:fs/promises\";",
    "import { fileURLToPath } from \"node:url\";",
    "import path from \"node:path\";",
    "import { randomUUID } from \"node:crypto\";",
    "import { createStore } from \"./store.js\";",
    "",
    "const rootDir = path.dirname(fileURLToPath(import.meta.url));",
    "const collections = " + collections + ";",
    "const store = createStore(path.join(rootDir, \"data\"), collections);",
    ""
  ];

  if (spec.features.includes("roles")) {
    lines.push("// Role-based access control.");
    lines.push("// The caller's role arrives in the x-role header. This is real");
    lines.push("// enforcement, not a label: a viewer cannot write and only an admin");
    lines.push("// can delete. Wire the header to your auth layer when you add one.");
    lines.push("const rolePermissions = {");
    lines.push("  viewer: [\"read\"],");
    lines.push("  member: [\"read\", \"write\"],");
    lines.push("  admin: [\"read\", \"write\", \"delete\"]");
    lines.push("};");
    lines.push("const defaultRole = \"member\";");
    lines.push("");
    lines.push("function permissionFor(method) {");
    lines.push("  if (method === \"GET\") return \"read\";");
    lines.push("  if (method === \"DELETE\") return \"delete\";");
    lines.push("  return \"write\";");
    lines.push("}");
    lines.push("");
    lines.push("function roleAllows(request) {");
    lines.push("  const role = String(request.headers[\"x-role\"] ?? defaultRole).toLowerCase();");
    lines.push("  const granted = rolePermissions[role];");
    lines.push("  if (!granted) return { ok: false, role, reason: \"Unknown role: \" + role };");
    lines.push("  const needed = permissionFor(request.method);");
    lines.push("  if (!granted.includes(needed)) {");
    lines.push("    return { ok: false, role, reason: role + \" cannot \" + needed };");
    lines.push("  }");
    lines.push("  return { ok: true, role };");
    lines.push("}");
    lines.push("");
  }

  if (hasTimeline) {
    lines.push("// Timeline: every write records an immutable event.");
    lines.push("function recordEvent(collection, recordId, action, detail) {");
    lines.push("  store.create(\"events\", {");
    lines.push("    id: randomUUID(),");
    lines.push("    collection,");
    lines.push("    recordId,");
    lines.push("    action,");
    lines.push("    detail: detail ?? \"\",");
    lines.push("    createdAt: new Date().toISOString()");
    lines.push("  });");
    lines.push("}");
    lines.push("");
  }

  for (const entity of spec.entities) {
    lines.push(validationFor(entity));
    lines.push("");
  }

  lines.push(...[
    "function sendJson(response, status, payload) {",
    "  const body = JSON.stringify(payload, null, 2);",
    "  response.writeHead(status, {",
    "    \"Content-Type\": \"application/json; charset=utf-8\",",
    "    \"Content-Length\": Buffer.byteLength(body)",
    "  });",
    "  response.end(body);",
    "}",
    "",
    "// A body is buffered in memory before it is parsed, so it needs a ceiling.",
    "// Without one a single large POST is enough to exhaust the process.",
    "const maxBodyBytes = 1024 * 1024;",
    "const bodyTooLarge = Symbol(\"body-too-large\");",
    "",
    "async function readBody(request) {",
    "  const chunks = [];",
    "  let size = 0;",
    "  let tooLarge = false;",
    "  for await (const chunk of request) {",
    "    size += chunk.length;",
    "    if (size > maxBodyBytes) {",
    "      // Keep reading but stop buffering. Abandoning the stream here closes",
    "      // the socket, and the client gets a connection reset instead of the",
    "      // 413 telling it what went wrong. Discarding keeps memory bounded and",
    "      // still lets the response be delivered.",
    "      tooLarge = true;",
    "      continue;",
    "    }",
    "    chunks.push(chunk);",
    "  }",
    "  if (tooLarge) return bodyTooLarge;",
    "  if (chunks.length === 0) return {};",
    "  try {",
    "    return JSON.parse(Buffer.concat(chunks).toString(\"utf8\"));",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    ""
  ]);

  // Route handling per entity.
  lines.push("const routes = [");
  for (const entity of spec.entities) {
    lines.push("  {");
    lines.push("    collection: " + JSON.stringify(entity.plural) + ",");
    lines.push("    label: " + JSON.stringify(entity.label) + ",");
    lines.push("    labelPlural: " + JSON.stringify(entity.labelPlural) + ",");
    lines.push("    validate: validate" + entity.label + ",");
    lines.push("    fields: " + JSON.stringify(entity.fields.map((field) => field.name)) + ",");
    // Typed subsets, so the summary can group and total without re-deriving them.
    lines.push("    enumFields: " + JSON.stringify(
      entity.fields.filter((field) => field.type === "enum")
        .map((field) => ({ name: field.name, options: field.options ?? [] }))
    ) + ",");
    lines.push("    numberFields: " + JSON.stringify(
      entity.fields.filter((field) => field.type === "number").map((field) => field.name)
    ));
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");

  // Which collections point at which, used to protect referential integrity.
  const referenceMap = spec.entities.flatMap((entity) =>
    entity.fields
      .filter((field) => field.type === "reference" && field.references)
      .map((field) => ({ from: entity.plural, field: field.name, to: field.references as string }))
  );

  if (referenceMap.length > 0) {
    lines.push("const referenceMap = " + JSON.stringify(referenceMap) + ";");
    lines.push("");
    lines.push("// Refuse to orphan a record that something else still points at.");
    lines.push("function blockingReferences(collection, id) {");
    lines.push("  const blockers = [];");
    lines.push("  for (const link of referenceMap.filter((entry) => entry.to === collection)) {");
    lines.push("    const count = store.list(link.from).filter((row) => row[link.field] === id).length;");
    lines.push("    if (count > 0) blockers.push(count + \" \" + link.from);");
    lines.push("  }");
    lines.push("  return blockers;");
    lines.push("}");
    lines.push("");
  }

  lines.push(...[
    spec.features.includes("dashboard")
      ? [
        "// Aggregates computed from the stored records on request. No cached",
        "// counters to drift out of sync with the data they describe.",
        "function buildSummary() {",
        "  return {",
        "    generatedAt: new Date().toISOString(),",
        "    collections: routes.map((route) => {",
        "      const rows = store.list(route.collection);",
        "      return {",
        "        collection: route.collection,",
        "        label: route.label,",
        "        labelPlural: route.labelPlural,",
        "        total: rows.length,",
        "        breakdowns: route.enumFields.map((field) => ({",
        "          field: field.name,",
        "          counts: field.options.map((option) => ({",
        "            option,",
        "            count: rows.filter((row) => row[field.name] === option).length",
        "          }))",
        "        })),",
        "        totals: route.numberFields.map((name) => {",
        "          const numbers = rows.map((row) => Number(row[name])).filter((n) => Number.isFinite(n));",
        "          const sum = numbers.reduce((a, b) => a + b, 0);",
        "          return {",
        "            field: name,",
        "            sum,",
        "            // Guarded: an average over no rows is not zero, it is undefined.",
        "            average: numbers.length ? sum / numbers.length : null",
        "          };",
        "        })",
        "      };",
        "    })",
        "  };",
        "}",
        ""
      ].join("\n")
      : "",
    "async function handleApi(request, response, url) {",
    spec.features.includes("roles")
      ? "  const access = roleAllows(request);\n"
        + "  if (!access.ok) { sendJson(response, 403, { error: access.reason }); return true; }"
      : "",
    "  const segments = url.pathname.split(\"/\").filter(Boolean);",
    "  // /api/<collection>[/<id>]",
    "  const collection = segments[1];",
    spec.features.includes("dashboard")
      ? "  if (collection === \"summary\") { sendJson(response, 200, buildSummary()); return true; }"
      : "",
    "  const id = segments[2];",
    "  const route = routes.find((entry) => entry.collection === collection);",
    "",
    "  if (!route) {",
    hasTimeline
      ? "    if (collection === \"events\") { sendJson(response, 200, store.list(\"events\")); return true; }"
      : "    // no such collection",
    "    sendJson(response, 404, { error: \"Unknown collection: \" + collection });",
    "    return true;",
    "  }",
    "",
    "  if (request.method === \"GET\" && !id) {",
    hasSearch
      ? "    const query = (url.searchParams.get(\"q\") ?? \"\").trim().toLowerCase();\n"
        + "    const rows = store.list(collection);\n"
        + "    const filtered = query\n"
        + "      ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query))\n"
        + "      : rows;\n"
        + "    sendJson(response, 200, filtered);"
      : "    sendJson(response, 200, store.list(collection));",
    "    return true;",
    "  }",
    "",
    "  if (request.method === \"GET\" && id) {",
    "    const found = store.get(collection, id);",
    "    if (!found) { sendJson(response, 404, { error: route.label + \" not found\" }); return true; }",
    "    sendJson(response, 200, found);",
    "    return true;",
    "  }",
    "",
    "  if (request.method === \"POST\" && !id) {",
    "    const body = await readBody(request);",
    "    if (body === bodyTooLarge) { sendJson(response, 413, { error: \"Request body too large\" }); return true; }",
    "    if (body === null) { sendJson(response, 400, { error: \"Invalid JSON body\" }); return true; }",
    "    const { errors, value } = route.validate(body);",
    "    if (errors.length) { sendJson(response, 400, { errors }); return true; }",
    "    const now = new Date().toISOString();",
    "    const record = { id: randomUUID(), ...value, createdAt: now, updatedAt: now };",
    "    store.create(collection, record);",
    hasTimeline ? "    recordEvent(collection, record.id, \"created\", record.title ?? \"\");" : "",
    "    sendJson(response, 201, record);",
    "    return true;",
    "  }",
    "",
    "  if ((request.method === \"PATCH\" || request.method === \"PUT\") && id) {",
    "    const body = await readBody(request);",
    "    if (body === bodyTooLarge) { sendJson(response, 413, { error: \"Request body too large\" }); return true; }",
    "    if (body === null) { sendJson(response, 400, { error: \"Invalid JSON body\" }); return true; }",
    "    const existing = store.get(collection, id);",
    "    if (!existing) { sendJson(response, 404, { error: route.label + \" not found\" }); return true; }",
    "    const merged = { ...existing, ...body };",
    "    const { errors, value } = route.validate(merged);",
    "    if (errors.length) { sendJson(response, 400, { errors }); return true; }",
    "    const updated = store.update(collection, id, value);",
    hasTimeline ? "    recordEvent(collection, id, \"updated\", updated?.title ?? \"\");" : "",
    "    sendJson(response, 200, updated);",
    "    return true;",
    "  }",
    "",
    "  if (request.method === \"DELETE\" && id) {",
    spec.entities.some((entity) => entity.fields.some((field) => field.type === "reference"))
      ? "    const blockers = blockingReferences(collection, id);\n"
        + "    if (blockers.length) {\n"
        + "      sendJson(response, 409, { error: \"Still referenced by \" + blockers.join(\", \") });\n"
        + "      return true;\n"
        + "    }"
      : "",
    "    const removed = store.remove(collection, id);",
    "    if (!removed) { sendJson(response, 404, { error: route.label + \" not found\" }); return true; }",
    hasTimeline ? "    recordEvent(collection, id, \"deleted\", \"\");" : "",
    "    sendJson(response, 204, {});",
    "    return true;",
    "  }",
    "",
    "  sendJson(response, 405, { error: \"Method not allowed\" });",
    "  return true;",
    "}",
    "",
    "const server = createServer(async (request, response) => {",
    "  const url = new URL(request.url ?? \"/\", \"http://\" + (request.headers.host ?? \"localhost\"));",
    "",
    "  if (url.pathname === \"/health\") {",
    "    sendJson(response, 200, { ok: true, service: " + JSON.stringify(spec.slug) + " });",
    "    return;",
    "  }",
    "",
    "  if (url.pathname.startsWith(\"/api/\")) {",
    "    try {",
    "      await handleApi(request, response, url);",
    "    } catch (error) {",
    "      sendJson(response, 500, { error: error instanceof Error ? error.message : \"Server error\" });",
    "    }",
    "    return;",
    "  }",
    "",
    "  // Static UI.",
    "  const file = url.pathname === \"/\" ? \"index.html\" : url.pathname.slice(1);",
    "  const safe = path.normalize(file).replace(/^([.][.][/\\\\])+/, \"\");",
    "  try {",
    "    const content = await readFile(path.join(rootDir, \"public\", safe));",
    "    const type = safe.endsWith(\".html\") ? \"text/html\" : safe.endsWith(\".css\") ? \"text/css\" : \"text/plain\";",
    "    response.writeHead(200, { \"Content-Type\": type + \"; charset=utf-8\" });",
    "    response.end(content);",
    "  } catch {",
    "    sendJson(response, 404, { error: \"Not found\" });",
    "  }",
    "});",
    "",
    "const port = Number(process.env.PORT ?? 4400);",
    "server.listen(port, () => {",
    "  console.log(\"[\" + " + JSON.stringify(spec.slug) + " + \"] listening on http://localhost:\" + port);",
    "});",
    ""
  ]);

  return lines.filter((line) => line !== "").join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

function inputsFor(entity: Entity): string {
  return entity.fields.map((field) => {
    if (field.type === "reference") {
      // Options are filled in at load time from the referenced collection.
      return [
        "      <label>" + field.name,
        '        <select name="' + field.name + '" data-ref="' + (field.references ?? "") + '">',
        '          <option value="">— none —</option>',
        "        </select>",
        "      </label>"
      ].join("\n");
    }
    if (field.type === "enum") {
      const options = (field.options ?? [])
        .map((option) => '        <option value="' + option + '">' + option + "</option>")
        .join("\n");
      return [
        '      <label>' + field.name,
        '        <select name="' + field.name + '">',
        options,
        "        </select>",
        "      </label>"
      ].join("\n");
    }
    if (field.type === "text") {
      return '      <label>' + field.name + '\n        <textarea name="' + field.name + '" rows="3"></textarea>\n      </label>';
    }
    if (field.type === "boolean") {
      return '      <label class="checkbox">' + field.name
        + '\n        <input type="checkbox" name="' + field.name + '" />\n      </label>';
    }
    // Native input types give mobile keyboards and browser validation for free.
    const inputType = field.type === "date" ? "date"
      : field.type === "number" ? "number"
        : field.type === "email" ? "email"
          : field.type === "phone" ? "tel"
            : field.type === "url" ? "url"
              : "text";
    return '      <label>' + field.name + '\n        <input type="' + inputType + '" name="' + field.name + '"'
      + (field.required ? " required" : "") + " />\n      </label>";
  }).join("\n");
}

function uiFile(spec: ProjectSpec): string {
  const hasRoles = spec.features.includes("roles");
  const hasSearch = spec.features.includes("search");
  const hasDashboard = spec.features.includes("dashboard");
  // A board needs an enum to form columns; without one there is nothing to group.
  const boardEntity = spec.features.includes("board")
    ? spec.entities.find((entity) => entity.fields.some((field) => field.type === "enum"))
    : undefined;
  const boardField = boardEntity?.fields.find((field) => field.type === "enum");
  const hasBoard = Boolean(boardEntity && boardField);

  // A calendar needs a date to place records on, same dependency as the board.
  const calendarEntity = spec.features.includes("calendar")
    ? spec.entities.find((entity) => entity.fields.some((field) => field.type === "date"))
    : undefined;
  const calendarField = calendarEntity?.fields.find((field) => field.type === "date");
  const hasCalendar = Boolean(calendarEntity && calendarField);
  const viewEntity = boardEntity ?? calendarEntity;

  const sections = spec.entities.map((entity, index) => [
    '  <section class="entity" data-collection="' + entity.plural + '"'
      + (index === 0 ? "" : ' hidden') + ">",
    "    <form>",
    inputsFor(entity),
    '      <div><button type="submit">Add ' + entity.label + "</button></div>",
    '      <div class="error"></div>',
    "    </form>",
    hasSearch
      ? '    <input class="search" type="search" placeholder="Search ' + entity.plural + '" aria-label="Search '
        + entity.plural + '" />'
      : "",
    (hasBoard || hasCalendar) && entity.plural === viewEntity?.plural
      ? [
        '    <div class="viewtabs">',
        '      <button data-view="list" class="active">List</button>',
        hasBoard ? '      <button data-view="board">Board</button>' : "",
        hasCalendar ? '      <button data-view="calendar">Calendar</button>' : "",
        "    </div>",
        hasBoard ? '    <div class="board" hidden></div>' : "",
        hasCalendar
          ? [
            '    <div class="calendar" hidden>',
            '      <div class="calendar-nav">',
            '        <button data-month="-1">‹</button>',
            '        <strong class="calendar-title"></strong>',
            '        <button data-month="1">›</button>',
            "      </div>",
            '      <div class="calendar-grid"></div>',
            "    </div>"
          ].join("\n")
          : ""
      ].filter(Boolean).join("\n")
      : "",
    "    <table><thead><tr>"
      + entity.fields.map((field) => "<th>" + field.name + "</th>").join("")
      + "<th></th></tr></thead><tbody></tbody></table>",
    '    <div class="empty">No ' + entity.plural + " yet.</div>",
    "  </section>"
  ].join("\n")).join("\n");

  const tabs = spec.entities.length > 1
    ? [
      '  <nav class="tabs">',
      ...spec.entities.map((entity, index) =>
        '    <button data-tab="' + entity.plural + '"' + (index === 0 ? ' class="active"' : "")
        + ">" + entity.labelPlural + "</button>"),
      "  </nav>"
    ].join("\n")
    : "";

  const roleBar = hasRoles
    ? [
      '  <div class="rolebar">',
      "    <label>Acting as",
      '      <select id="role"><option value="admin">admin</option>'
        + '<option value="member" selected>member</option>'
        + '<option value="viewer">viewer</option></select>',
      "    </label>",
      '    <span class="hint">viewer: read only &middot; member: can add &middot; admin: can delete</span>',
      "  </div>"
    ].join("\n")
    : "";

  // Full field descriptors, not just names: inline editing has to rebuild the
  // right control per field, including enum selects and reference pickers.
  const fieldMap = JSON.stringify(
    Object.fromEntries(spec.entities.map((entity) => [
      entity.plural,
      entity.fields.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
        ...(field.options ? { options: field.options } : {}),
        ...(field.references ? { references: field.references } : {})
      }))
    ]))
  );

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>" + spec.title + "</title>",
    "  <style>",
    "    :root { color-scheme: light dark; }",
    "    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; max-width: 900px; }",
    "    h1 { font-size: 1.4rem; margin-bottom: 4px; }",
    "    p.sub { margin-top: 0; opacity: 0.7; font-size: 0.9rem; }",
    "    form { display: grid; gap: 10px; margin: 20px 0; padding: 16px; border: 1px solid #8884; border-radius: 8px; }",
    "    label { display: grid; gap: 4px; font-size: 0.85rem; }",
    "    input, select, textarea { padding: 6px 8px; font: inherit; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; }",
    "    button { padding: 8px 14px; font: inherit; cursor: pointer; border-radius: 4px; border: 1px solid #8886; background: #8882; color: inherit; }",
    "    table { width: 100%; border-collapse: collapse; margin-top: 16px; }",
    "    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #8884; font-size: 0.85rem; }",
    "    .empty { opacity: 0.6; font-style: italic; padding: 16px 0; }",
    "    .error { color: #c0392b; font-size: 0.85rem; }",
    "    .tabs { display: flex; gap: 6px; margin-top: 16px; }",
    "    .tabs button { opacity: 0.6; }",
    "    .tabs button.active { opacity: 1; border-color: currentColor; }",
    "    .rolebar { margin-top: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }",
    "    .rolebar label { display: flex; align-items: center; gap: 6px; }",
    "    .hint { font-size: 0.75rem; opacity: 0.6; }",
    "    .search { width: 100%; margin-top: 8px; }",
    "    label.checkbox { grid-auto-flow: column; justify-content: start; align-items: center; gap: 8px; }",
    "    label.checkbox input { width: auto; }",
    "    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }",
    "    .summary-card { border: 1px solid #8884; border-radius: 8px; padding: 12px 14px; }",
    "    .summary-card h3 { margin: 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; }",
    "    .summary-total { font-size: 1.9rem; font-weight: 600; line-height: 1.2; }",
    "    .summary-breakdown { margin-top: 10px; display: grid; gap: 3px; }",
    "    .summary-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; }",
    "    .summary-row { display: grid; grid-template-columns: 5.5rem 1fr auto; align-items: center; gap: 8px; font-size: 0.8rem; }",
    "    .summary-bar { height: 6px; border-radius: 3px; background: currentColor; opacity: 0.35; min-width: 2px; }",
    "    .summary-metric { margin-top: 8px; font-size: 0.78rem; opacity: 0.8; }",
    "    .viewtabs { display: flex; gap: 6px; margin-top: 12px; }",
    "    .viewtabs button { opacity: 0.6; }",
    "    .viewtabs button.active { opacity: 1; border-color: currentColor; }",
    "    .board { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 14px; align-items: start; }",
    "    .board-column { border: 1px solid #8884; border-radius: 8px; padding: 10px; min-height: 80px; }",
    "    .board-column h4 { margin: 0 0 8px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; }",
    "    .board-card { border: 1px solid #8886; border-radius: 6px; padding: 8px; margin-bottom: 6px; display: grid; gap: 6px; font-size: 0.82rem; }",
    "    .board-controls { display: flex; gap: 4px; }",
    "    .board-controls button { padding: 2px 8px; font-size: 0.8rem; }",
    "    .board-controls button:disabled { opacity: 0.3; cursor: default; }",
    "    .calendar { margin-top: 14px; }",
    "    .calendar-nav { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }",
    "    .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }",
    "    .calendar-head { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; padding: 4px; }",
    "    .calendar-cell { border: 1px solid #8884; border-radius: 6px; min-height: 68px; padding: 4px; font-size: 0.78rem; }",
    "    .calendar-cell.empty { border: none; }",
    "    .calendar-cell.today { border-color: currentColor; }",
    "    .calendar-day { opacity: 0.6; font-size: 0.7rem; }",
    "    .calendar-entry { margin-top: 3px; padding: 2px 4px; border-radius: 4px; background: #8883; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    "    .calendar-note { grid-column: 1 / -1; margin-top: 8px; font-size: 0.75rem; opacity: 0.65; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <h1>" + spec.title + "</h1>",
    '  <p class="sub">' + spec.summary + "</p>",
    roleBar,
    hasDashboard ? '  <section id="summary" class="summary"></section>' : "",
    tabs,
    "",
    sections,
    "",
    "  <script>",
    "    const fieldMap = " + fieldMap + ";",
    hasRoles
      ? "    const roleHeaders = () => ({ 'x-role': document.getElementById('role').value });"
      : "    const roleHeaders = () => ({});",
    "",
    "    async function load(section) {",
    "      const collection = section.dataset.collection;",
    hasSearch
      ? "      const term = section.querySelector('.search')?.value.trim() ?? '';\n"
        + "      const url = '/api/' + collection + (term ? '?q=' + encodeURIComponent(term) : '');"
      : "      const url = '/api/' + collection;",
    "      const response = await fetch(url, { headers: roleHeaders() });",
    "      const body = section.querySelector('tbody');",
    "      const empty = section.querySelector('.empty');",
    "      body.innerHTML = '';",
    "      if (!response.ok) {",
    "        empty.textContent = 'Not permitted to read ' + collection + '.';",
    "        empty.style.display = 'block';",
    "        return;",
    "      }",
    "      const rows = await response.json();",
    hasSearch
      ? "      empty.textContent = term ? 'No ' + collection + ' match \"' + term + '\".' : 'No ' + collection + ' yet.';"
      : "      empty.textContent = 'No ' + collection + ' yet.';",
    "      empty.style.display = rows.length ? 'none' : 'block';",
    "      for (const row of rows) {",
    "        body.appendChild(renderRow(section, collection, row));",
    "      }",
    hasBoard ? "      if (collection === boardCollection) renderBoard(section, rows);" : "",
    hasCalendar ? "      if (collection === calendarCollection) renderCalendar(section, rows);" : "",
    hasDashboard ? "      scheduleSummary();" : "",
    "    }",
    "",
    hasDashboard
      ? [
        "    // Aggregates come from the server so the figures always match the",
        "    // stored data, rather than being recounted from a filtered page.",
        "    async function loadSummary() {",
        "      const target = document.getElementById('summary');",
        "      const response = await fetch('/api/summary', { headers: roleHeaders() });",
        "      if (!response.ok) { target.innerHTML = ''; return; }",
        "      const data = await response.json();",
        "      target.innerHTML = '';",
        "      for (const entry of data.collections) {",
        "        const card = document.createElement('div');",
        "        card.className = 'summary-card';",
        "        const heading = document.createElement('h3');",
        "        heading.textContent = entry.labelPlural;",
        "        const total = document.createElement('div');",
        "        total.className = 'summary-total';",
        "        total.textContent = entry.total;",
        "        card.append(heading, total);",
        "",
        "        for (const breakdown of entry.breakdowns) {",
        "          const wrap = document.createElement('div');",
        "          wrap.className = 'summary-breakdown';",
        "          const label = document.createElement('span');",
        "          label.className = 'summary-label';",
        "          label.textContent = breakdown.field;",
        "          wrap.appendChild(label);",
        "          for (const item of breakdown.counts) {",
        "            const row = document.createElement('div');",
        "            row.className = 'summary-row';",
        "            const name = document.createElement('span');",
        "            name.textContent = item.option;",
        "            const bar = document.createElement('span');",
        "            bar.className = 'summary-bar';",
        "            const share = entry.total ? Math.round((item.count / entry.total) * 100) : 0;",
        "            bar.style.width = share + '%';",
        "            const count = document.createElement('strong');",
        "            count.textContent = item.count;",
        "            row.append(name, bar, count);",
        "            wrap.appendChild(row);",
        "          }",
        "          card.appendChild(wrap);",
        "        }",
        "",
        "        for (const totals of entry.totals) {",
        "          const row = document.createElement('div');",
        "          row.className = 'summary-metric';",
        "          const average = totals.average === null ? '—' : (Math.round(totals.average * 100) / 100);",
        "          row.textContent = totals.field + ': ' + totals.sum + ' total, ' + average + ' average';",
        "          card.appendChild(row);",
        "        }",
        "        target.appendChild(card);",
        "      }",
        "    }",
        "",
        "    // Debounced: every refresh path calls this, and with several entities",
        "    // that would otherwise fire one identical request per section.",
        "    let summaryTimer;",
        "    function scheduleSummary() {",
        "      clearTimeout(summaryTimer);",
        "      summaryTimer = setTimeout(loadSummary, 50);",
        "    }",
        ""
      ].join("\n")
      : "",
    hasBoard
      ? [
        "    // Board view: the same records as the table, grouped into columns by",
        "    // " + (boardField?.name ?? "status") + ". Moving a card is a PATCH, so the board and the",
        "    // list can never disagree about state.",
        "    const boardCollection = " + JSON.stringify(boardEntity?.plural ?? "") + ";",
        "    const boardField = " + JSON.stringify(boardField?.name ?? "") + ";",
        "    const boardOptions = " + JSON.stringify(boardField?.options ?? []) + ";",
        "",
        "    async function moveCard(row, direction) {",
        "      const index = boardOptions.indexOf(row[boardField]);",
        "      const next = boardOptions[index + direction];",
        "      if (next === undefined) return;",
        "      const response = await fetch('/api/' + boardCollection + '/' + row.id, {",
        "        method: 'PATCH',",
        "        headers: { 'Content-Type': 'application/json', ...roleHeaders() },",
        "        body: JSON.stringify({ [boardField]: next })",
        "      });",
        "      const section = document.querySelector('[data-collection=\"' + boardCollection + '\"]');",
        "      if (!response.ok) {",
        "        const payload = await response.json();",
        "        section.querySelector('.error').textContent = (payload.errors || [payload.error]).join(', ');",
        "        return;",
        "      }",
        "      section.querySelector('.error').textContent = '';",
        "      load(section);",
        "    }",
        "",
        "    function renderBoard(section, rows) {",
        "      const target = section.querySelector('.board');",
        "      if (!target) return;",
        "      target.innerHTML = '';",
        "      for (const option of boardOptions) {",
        "        const column = document.createElement('div');",
        "        column.className = 'board-column';",
        "        column.dataset.option = option;",
        "        const heading = document.createElement('h4');",
        "        const inColumn = rows.filter((row) => row[boardField] === option);",
        "        heading.textContent = option + ' (' + inColumn.length + ')';",
        "        column.appendChild(heading);",
        "",
        "        for (const row of inColumn) {",
        "          const card = document.createElement('div');",
        "          card.className = 'board-card';",
        "          const title = document.createElement('span');",
        "          title.textContent = row.title || '(untitled)';",
        "          const controls = document.createElement('div');",
        "          controls.className = 'board-controls';",
        "          const index = boardOptions.indexOf(row[boardField]);",
        "          const back = document.createElement('button');",
        "          back.textContent = '←';",
        "          back.title = 'Move to ' + (boardOptions[index - 1] ?? '');",
        "          back.disabled = index <= 0;",
        "          back.onclick = () => moveCard(row, -1);",
        "          const forward = document.createElement('button');",
        "          forward.textContent = '→';",
        "          forward.title = 'Move to ' + (boardOptions[index + 1] ?? '');",
        "          forward.disabled = index === -1 || index >= boardOptions.length - 1;",
        "          forward.onclick = () => moveCard(row, 1);",
        "          controls.append(back, forward);",
        "          card.append(title, controls);",
        "          column.appendChild(card);",
        "        }",
        "        target.appendChild(column);",
        "      }",
        "    }",
        ""
      ].join("\n")
      : "",
    hasCalendar
      ? [
        "    // Calendar view: records placed on the day named by their",
        "    // " + (calendarField?.name ?? "date") + ". Dates are compared as YYYY-MM-DD strings rather than",
        "    // Date objects, so a record never lands on the wrong day because the",
        "    // browser's timezone shifted a midnight timestamp.",
        "    const calendarCollection = " + JSON.stringify(calendarEntity?.plural ?? "") + ";",
        "    const calendarField = " + JSON.stringify(calendarField?.name ?? "") + ";",
        "    let calendarCursor = new Date();",
        "    let calendarRows = [];",
        "",
        "    function dayKey(year, month, day) {",
        "      return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');",
        "    }",
        "",
        "    function renderCalendar(section, rows) {",
        "      if (rows) calendarRows = rows;",
        "      const grid = section.querySelector('.calendar-grid');",
        "      const title = section.querySelector('.calendar-title');",
        "      if (!grid) return;",
        "",
        "      const year = calendarCursor.getFullYear();",
        "      const month = calendarCursor.getMonth();",
        "      title.textContent = calendarCursor.toLocaleString(undefined, { month: 'long', year: 'numeric' });",
        "",
        "      grid.innerHTML = '';",
        "      for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {",
        "        const head = document.createElement('div');",
        "        head.className = 'calendar-head';",
        "        head.textContent = name;",
        "        grid.appendChild(head);",
        "      }",
        "",
        "      // Monday-first offset; getDay() is Sunday-first.",
        "      const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;",
        "      const daysInMonth = new Date(year, month + 1, 0).getDate();",
        "      for (let blank = 0; blank < firstWeekday; blank += 1) {",
        "        const filler = document.createElement('div');",
        "        filler.className = 'calendar-cell empty';",
        "        grid.appendChild(filler);",
        "      }",
        "",
        "      const todayKey = dayKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());",
        "      for (let day = 1; day <= daysInMonth; day += 1) {",
        "        const key = dayKey(year, month, day);",
        "        const cell = document.createElement('div');",
        "        cell.className = 'calendar-cell' + (key === todayKey ? ' today' : '');",
        "        const number = document.createElement('span');",
        "        number.className = 'calendar-day';",
        "        number.textContent = day;",
        "        cell.appendChild(number);",
        "",
        "        for (const row of calendarRows) {",
        "          const value = row[calendarField];",
        "          if (typeof value !== 'string' || value.slice(0, 10) !== key) continue;",
        "          const entry = document.createElement('div');",
        "          entry.className = 'calendar-entry';",
        "          entry.textContent = row.title || '(untitled)';",
        "          entry.title = row.title || '';",
        "          cell.appendChild(entry);",
        "        }",
        "        grid.appendChild(cell);",
        "      }",
        "",
        "      const undated = calendarRows.filter((row) => !row[calendarField]).length;",
        "      if (undated > 0) {",
        "        const note = document.createElement('div');",
        "        note.className = 'calendar-note';",
        "        note.textContent = undated + ' record(s) have no ' + calendarField + ' and are not shown.';",
        "        grid.appendChild(note);",
        "      }",
        "    }",
        ""
      ].join("\n")
      : "",
    "    // Reference values are ids; show the referenced record's title instead.",
    "    const labelCache = {};",
    "    async function labelFor(target, id) {",
    "      if (!id) return '';",
    "      if (!labelCache[target]) {",
    "        const response = await fetch('/api/' + target, { headers: roleHeaders() });",
    "        labelCache[target] = response.ok",
    "          ? Object.fromEntries((await response.json()).map((r) => [r.id, r.title || r.id]))",
    "          : {};",
    "      }",
    "      return labelCache[target][id] ?? id;",
    "    }",
    "",
    "    function renderRow(section, collection, row) {",
    "      const tr = document.createElement('tr');",
    "      for (const field of fieldMap[collection]) {",
    "        const td = document.createElement('td');",
    "        const value = row[field.name];",
    "        if (field.type === 'reference') {",
    "          td.textContent = value ? '…' : '';",
    "          if (value) labelFor(field.references, value).then((text) => { td.textContent = text; });",
    "        } else {",
    "          td.textContent = value ?? '';",
    "        }",
    "        tr.appendChild(td);",
    "      }",
    "",
    "      const actions = document.createElement('td');",
    "      const edit = document.createElement('button');",
    "      edit.textContent = 'Edit';",
    "      edit.onclick = () => {",
    "        const editRow = renderEditRow(section, collection, row);",
    "        tr.replaceWith(editRow);",
    "        // Must run after insertion: fillReferences scans the document, so a",
    "        // detached row's selects would never be populated and saving would",
    "        // silently clear the reference.",
    "        fillReferences();",
    "      };",
    "      const del = document.createElement('button');",
    "      del.textContent = 'Delete';",
    "      del.onclick = async () => {",
    "        const result = await fetch('/api/' + collection + '/' + row.id, { method: 'DELETE', headers: roleHeaders() });",
    "        if (!result.ok) {",
    "          const payload = await result.json();",
    "          section.querySelector('.error').textContent = payload.error || 'Delete failed';",
    "          return;",
    "        }",
    "        load(section);",
    "      };",
    "      actions.append(edit, del);",
    "      tr.appendChild(actions);",
    "      return tr;",
    "    }",
    "",
    "    // Inline editing. The server already supports PATCH; without this the UI",
    "    // could create and delete but never change a status or priority.",
    "    function buildEditor(field, value) {",
    "      if (field.type === 'enum') {",
    "        const select = document.createElement('select');",
    "        for (const option of field.options ?? []) {",
    "          const el = document.createElement('option');",
    "          el.value = option; el.textContent = option;",
    "          select.appendChild(el);",
    "        }",
    "        select.value = value ?? (field.options ?? [])[0];",
    "        return select;",
    "      }",
    "      if (field.type === 'reference') {",
    "        const select = document.createElement('select');",
    "        select.dataset.ref = field.references;",
    "        const none = document.createElement('option');",
    "        none.value = ''; none.textContent = '— none —';",
    "        select.appendChild(none);",
    "        select.dataset.pending = value ?? '';",
    "        return select;",
    "      }",
    "      if (field.type === 'text') {",
    "        const area = document.createElement('textarea');",
    "        area.rows = 2; area.value = value ?? '';",
    "        return area;",
    "      }",
    "      const input = document.createElement('input');",
    "      if (field.type === 'boolean') {",
    "        input.type = 'checkbox';",
    "        input.checked = Boolean(value);",
    "        return input;",
    "      }",
    "      const types = { date: 'date', number: 'number', email: 'email', phone: 'tel', url: 'url' };",
    "      input.type = types[field.type] ?? 'text';",
    "      input.value = value ?? '';",
    "      return input;",
    "    }",
    "",
    "    function renderEditRow(section, collection, row) {",
    "      const tr = document.createElement('tr');",
    "      const editors = {};",
    "      for (const field of fieldMap[collection]) {",
    "        const td = document.createElement('td');",
    "        const editor = buildEditor(field, row[field.name]);",
    "        editors[field.name] = editor;",
    "        td.appendChild(editor);",
    "        tr.appendChild(td);",
    "      }",
    "",
    "      const actions = document.createElement('td');",
    "      const save = document.createElement('button');",
    "      save.textContent = 'Save';",
    "      save.onclick = async () => {",
    "        const patch = {};",
    "        for (const [name, editor] of Object.entries(editors)) {",
    "          // A reference select still carrying `pending` has not finished",
    "          // loading its options; trusting its empty value would drop the link.",
    "          if (editor.type === 'checkbox') { patch[name] = editor.checked; continue; }",
    "          patch[name] = editor.dataset && editor.dataset.pending",
    "            ? editor.dataset.pending",
    "            : editor.value;",
    "        }",
    "        const result = await fetch('/api/' + collection + '/' + row.id, {",
    "          method: 'PATCH',",
    "          headers: { 'Content-Type': 'application/json', ...roleHeaders() },",
    "          body: JSON.stringify(patch)",
    "        });",
    "        if (!result.ok) {",
    "          const payload = await result.json();",
    "          section.querySelector('.error').textContent = (payload.errors || [payload.error]).join(', ');",
    "          return;",
    "        }",
    "        section.querySelector('.error').textContent = '';",
    "        labelCache[collection] = undefined;",
    "        load(section);",
    "      };",
    "      const cancel = document.createElement('button');",
    "      cancel.textContent = 'Cancel';",
    "      cancel.onclick = () => tr.replaceWith(renderRow(section, collection, row));",
    "      actions.append(save, cancel);",
    "      tr.appendChild(actions);",
    "      return tr;",
    "    }",
    "",
    "    // Reference dropdowns are populated from the collection they point at,",
    "    "
      + "// so you pick a real record instead of pasting an id.",
    "    async function fillReferences() {",
    "      for (const select of document.querySelectorAll('select[data-ref]')) {",
    "        const target = select.dataset.ref;",
    "        const response = await fetch('/api/' + target, { headers: roleHeaders() });",
    "        if (!response.ok) continue;",
    "        const rows = await response.json();",
    "        // An edit row carries the record's existing id until options exist.",
    "        const current = select.dataset.pending || select.value;",
    "        select.innerHTML = '<option value=\"\">— none —</option>';",
    "        for (const row of rows) {",
    "          const option = document.createElement('option');",
    "          option.value = row.id;",
    "          option.textContent = row.title || row.id;",
    "          select.appendChild(option);",
    "        }",
    "        select.value = current;",
    "        delete select.dataset.pending;",
    "      }",
    "    }",
    "",
    "    for (const section of document.querySelectorAll('.entity')) {",
    "      section.querySelector('form').addEventListener('submit', async (event) => {",
    "        event.preventDefault();",
    "        const data = Object.fromEntries(new FormData(event.target).entries());",
    "        const response = await fetch('/api/' + section.dataset.collection, {",
    "          method: 'POST',",
    "          headers: { 'Content-Type': 'application/json', ...roleHeaders() },",
    "          body: JSON.stringify(data)",
    "        });",
    "        const error = section.querySelector('.error');",
    "        if (!response.ok) {",
    "          const payload = await response.json();",
    "          error.textContent = (payload.errors || [payload.error]).join(', ');",
    "          return;",
    "        }",
    "        error.textContent = '';",
    "        event.target.reset();",
    "        load(section);",
    "        fillReferences();",
    "      });",
    "      load(section);",
    hasSearch
      ? "      // Debounced so typing does not fire a request per keystroke.\n"
        + "      const search = section.querySelector('.search');\n"
        + "      let searchTimer;\n"
        + "      search.addEventListener('input', () => {\n"
        + "        clearTimeout(searchTimer);\n"
        + "        searchTimer = setTimeout(() => load(section), 200);\n"
        + "      });"
      : "",
    "    }",
    "    fillReferences();",
    "",
    hasBoard || hasCalendar
      ? [
        "    for (const button of document.querySelectorAll('.viewtabs button')) {",
        "      button.onclick = () => {",
        "        const section = button.closest('.entity');",
        "        const view = button.dataset.view;",
        "        for (const other of section.querySelectorAll('.viewtabs button')) other.classList.remove('active');",
        "        button.classList.add('active');",
        "        section.querySelector('table').hidden = view !== 'list';",
        "        // The empty-state message belongs to the table, not the other views.",
        "        section.querySelector('.empty').hidden = view !== 'list';",
        "        const board = section.querySelector('.board');",
        "        if (board) board.hidden = view !== 'board';",
        "        const calendar = section.querySelector('.calendar');",
        "        if (calendar) calendar.hidden = view !== 'calendar';",
        "      };",
        "    }",
        ""
      ].join("\n")
      : "",
    hasCalendar
      ? [
        "    for (const button of document.querySelectorAll('.calendar-nav button')) {",
        "      button.onclick = () => {",
        "        const section = button.closest('.entity');",
        "        calendarCursor = new Date(",
        "          calendarCursor.getFullYear(),",
        "          calendarCursor.getMonth() + Number(button.dataset.month),",
        "          1",
        "        );",
        "        // Re-render from the rows already loaded; changing month is not",
        "        // a reason to refetch.",
        "        renderCalendar(section);",
        "      };",
        "    }",
        ""
      ].join("\n")
      : "",
    "    for (const tab of document.querySelectorAll('.tabs button')) {",
    "      tab.onclick = () => {",
    "        for (const other of document.querySelectorAll('.tabs button')) other.classList.remove('active');",
    "        tab.classList.add('active');",
    "        for (const section of document.querySelectorAll('.entity')) {",
    "          section.hidden = section.dataset.collection !== tab.dataset.tab;",
    "        }",
    "      };",
    "    }",
    hasRoles
      ? "    document.getElementById('role').onchange = () => {\n"
        + "      for (const section of document.querySelectorAll('.entity')) load(section);\n"
        + "    };"
      : "",
    "  </script>",
    "</body>",
    "</html>",
    ""
  ].filter((line) => line !== "").join("\n");
}

function readmeFile(spec: ProjectSpec): string {
  const entity = spec.entities[0];
  const lines = [
    "# " + spec.title,
    "",
    spec.summary,
    "",
    "## Run it",
    "",
    "```bash",
    "node server.js",
    "```",
    "",
    "Then open http://localhost:4400",
    "",
    "No dependencies and no install step — this runs on the Node standard library alone.",
    "",
    "## API",
    "",
    "| Method | Path | Purpose |",
    "| --- | --- | --- |",
    "| GET | `/health` | Liveness check |"
  ];

  for (const item of spec.entities) {
    lines.push("| GET | `/api/" + item.plural + "` | List all " + item.plural + " |");
    lines.push("| POST | `/api/" + item.plural + "` | Create a " + item.name + " |");
    lines.push("| GET | `/api/" + item.plural + "/:id` | Fetch one " + item.name + " |");
    lines.push("| PATCH | `/api/" + item.plural + "/:id` | Update a " + item.name + " |");
    lines.push("| DELETE | `/api/" + item.plural + "/:id` | Delete a " + item.name + " |");
  }
  if (spec.features.includes("timeline")) {
    lines.push("| GET | `/api/events` | Immutable activity timeline |");
  }
  if (spec.features.includes("dashboard")) {
    lines.push("| GET | `/api/summary` | Totals, per-status breakdowns and numeric averages |");
  }
  if (spec.features.includes("board")) {
    lines.push("");
    lines.push("The UI offers a **Board** view alongside the list, grouping records into "
      + "columns by their status. Moving a card issues a `PATCH`, so both views always agree.");
  }
  if (spec.features.includes("calendar")) {
    lines.push("");
    lines.push("A **Calendar** view places records on the month grid by their date field. "
      + "Records without a date are counted below the grid rather than silently omitted.");
  }
  if (spec.features.includes("search")) {
    lines.push("");
    lines.push("Any list endpoint accepts `?q=` to filter, e.g. `/api/"
      + spec.entities[0].plural + "?q=urgent`. The search box in the UI uses it.");
  }
  if (spec.features.includes("roles")) {
    lines.push("");
    lines.push("### Permissions");
    lines.push("");
    lines.push("Send an `x-role` header of `viewer`, `member`, or `admin`. "
      + "Viewers can read, members can write, only admins can delete. "
      + "Requests without the header are treated as `member`.");
  }

  lines.push("");
  lines.push("## Data model");
  lines.push("");
  for (const item of spec.entities) {
    lines.push("### " + item.label);
    lines.push("");
    lines.push("| Field | Type | Required |");
    lines.push("| --- | --- | --- |");
    lines.push("| id | string | auto |");
    for (const field of item.fields) {
      const type = field.type === "enum"
        ? "enum(" + (field.options ?? []).join(" \\| ") + ")"
        : field.type === "reference"
          ? "reference -> " + field.references
          : field.type;
      lines.push("| " + field.name + " | " + type + " | " + (field.required ? "yes" : "no") + " |");
    }
    lines.push("| createdAt | date | auto |");
    lines.push("| updatedAt | date | auto |");
    lines.push("");
  }

  lines.push("## Example");
  lines.push("");
  lines.push("```bash");
  lines.push("curl -X POST http://localhost:4400/api/" + entity.plural + " \\");
  lines.push("  -H 'Content-Type: application/json' \\");
  lines.push("  -d '{\"title\":\"First " + entity.name + "\"}'");
  lines.push("```");
  lines.push("");
  lines.push("## Storage");
  lines.push("");
  lines.push("Records are written to `data/data.json`. Delete that file to reset.");
  lines.push("");

  return lines.join("\n");
}

function packageFile(spec: ProjectSpec): string {
  return JSON.stringify({
    name: spec.slug,
    version: "0.1.0",
    private: true,
    type: "module",
    description: spec.summary,
    engines: { node: ">=18.0.0" },
    scripts: {
      start: "node server.js",
      smoke: "node smoke.js"
    }
  }, null, 2) + "\n";
}

/** A runnable check the generated project ships with, so "it works" is provable. */
function samplePayload(entity: Entity): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of entity.fields.filter((item) => item.required && item.type !== "enum")) {
    payload[field.name] = field.type === "number" ? 1 : "smoke test " + field.name;
  }
  return payload;
}

function smokeFile(spec: ProjectSpec): string {
  const entity = spec.entities[0];
  const payload = samplePayload(entity);
  const hasRoles = spec.features.includes("roles");

  const perEntityChecks = spec.entities.map((item) => [
    "  {",
    "    const created = await fetch(base + \"/api/" + item.plural + "\", {",
    "      method: \"POST\",",
    "      headers: { \"Content-Type\": \"application/json\"" + (hasRoles ? ", \"x-role\": \"admin\"" : "") + " },",
    "      body: JSON.stringify(" + JSON.stringify(samplePayload(item)) + ")",
    "    });",
    "    check(\"" + item.plural + ": create returns 201\", created.status === 201);",
    "    const record = await created.json();",
    "    check(\"" + item.plural + ": record has an id\", typeof record.id === \"string\");",
    "",
    "    const listed = await fetch(base + \"/api/" + item.plural + "\"" + (hasRoles ? ", { headers: { \"x-role\": \"admin\" } }" : "") + ");",
    "    const rows = await listed.json();",
    "    check(\"" + item.plural + ": list includes the new record\", rows.some((row) => row.id === record.id));",
    "",
    "    const patched = await fetch(base + \"/api/" + item.plural + "/\" + record.id, {",
    "      method: \"PATCH\",",
    "      headers: { \"Content-Type\": \"application/json\"" + (hasRoles ? ", \"x-role\": \"admin\"" : "") + " },",
    "      body: JSON.stringify({ title: \"renamed by smoke\" })",
    "    });",
    "    check(\"" + item.plural + ": update returns 200\", patched.status === 200);",
    "    const updated = await patched.json();",
    "    check(\"" + item.plural + ": update persisted\", updated.title === \"renamed by smoke\");",
    "",
    "    const removed = await fetch(base + \"/api/" + item.plural + "/\" + record.id, {",
    "      method: \"DELETE\"" + (hasRoles ? ", headers: { \"x-role\": \"admin\" }" : ""),
    "    });",
    "    check(\"" + item.plural + ": delete returns 204\", removed.status === 204);",
    "  }"
  ].join("\n")).join("\n\n");

  const primaryRef = entity.fields.find((field) => field.type === "reference");
  const adminHeader = hasRoles ? ", \"x-role\": \"admin\"" : "";

  const relationChecks = primaryRef
    ? [
      "",
      "  // Relations: a reference must point at a record that exists, and a",
      "  // referenced record must not be deletable out from under it.",
      "  {",
      "    const bad = await fetch(base + \"/api/" + entity.plural + "\", {",
      "      method: \"POST\",",
      "      headers: { \"Content-Type\": \"application/json\"" + adminHeader + " },",
      "      body: JSON.stringify({ ..." + JSON.stringify(payload) + ", "
        + JSON.stringify(primaryRef.name) + ": \"not-a-real-id\" })",
      "    });",
      "    check(\"dangling reference is rejected\", bad.status === 400);",
      "",
      "    const parent = await (await fetch(base + \"/api/" + primaryRef.references + "\", {",
      "      method: \"POST\",",
      "      headers: { \"Content-Type\": \"application/json\"" + adminHeader + " },",
      "      body: JSON.stringify({ title: \"linked parent\" })",
      "    })).json();",
      "",
      "    const child = await (await fetch(base + \"/api/" + entity.plural + "\", {",
      "      method: \"POST\",",
      "      headers: { \"Content-Type\": \"application/json\"" + adminHeader + " },",
      "      body: JSON.stringify({ ..." + JSON.stringify(payload) + ", "
        + JSON.stringify(primaryRef.name) + ": parent.id })",
      "    })).json();",
      "    check(\"valid reference is accepted\", child." + primaryRef.name + " === parent.id);",
      "",
      "    const blocked = await fetch(base + \"/api/" + primaryRef.references + "/\" + parent.id, {",
      "      method: \"DELETE\"" + (hasRoles ? ", headers: { \"x-role\": \"admin\" }" : ""),
      "    });",
      "    check(\"referenced record cannot be deleted\", blocked.status === 409);",
      "",
      "    await fetch(base + \"/api/" + entity.plural + "/\" + child.id, {",
      "      method: \"DELETE\"" + (hasRoles ? ", headers: { \"x-role\": \"admin\" }" : ""),
      "    });",
      "    const freed = await fetch(base + \"/api/" + primaryRef.references + "/\" + parent.id, {",
      "      method: \"DELETE\"" + (hasRoles ? ", headers: { \"x-role\": \"admin\" }" : ""),
      "    });",
      "    check(\"deletable once nothing references it\", freed.status === 204);",
      "  }"
    ].join("\n")
    : "";

  const roleChecks = hasRoles
    ? [
      "",
      "  // Role enforcement is real, not decorative.",
      "  const viewerWrite = await fetch(base + \"/api/" + entity.plural + "\", {",
      "    method: \"POST\",",
      "    headers: { \"Content-Type\": \"application/json\", \"x-role\": \"viewer\" },",
      "    body: JSON.stringify(" + JSON.stringify(payload) + ")",
      "  });",
      "  check(\"viewer cannot create\", viewerWrite.status === 403);",
      "",
      "  const viewerRead = await fetch(base + \"/api/" + entity.plural + "\", { headers: { \"x-role\": \"viewer\" } });",
      "  check(\"viewer can read\", viewerRead.status === 200);",
      "",
      "  const memberCreate = await fetch(base + \"/api/" + entity.plural + "\", {",
      "    method: \"POST\",",
      "    headers: { \"Content-Type\": \"application/json\", \"x-role\": \"member\" },",
      "    body: JSON.stringify(" + JSON.stringify(payload) + ")",
      "  });",
      "  check(\"member can create\", memberCreate.status === 201);",
      "  const memberRecord = await memberCreate.json();",
      "",
      "  const memberDelete = await fetch(base + \"/api/" + entity.plural + "/\" + memberRecord.id, {",
      "    method: \"DELETE\", headers: { \"x-role\": \"member\" }",
      "  });",
      "  check(\"member cannot delete\", memberDelete.status === 403);",
      "",
      "  const unknownRole = await fetch(base + \"/api/" + entity.plural + "\", { headers: { \"x-role\": \"wizard\" } });",
      "  check(\"unknown role is rejected\", unknownRole.status === 403);"
    ].join("\n")
    : "";

  return [
    "// Starts the server, exercises the API, and reports the result.",
    "import { spawn } from \"node:child_process\";",
    "import { once } from \"node:events\";",
    "import { setTimeout as delay } from \"node:timers/promises\";",
    "",
    "const port = Number(process.env.SMOKE_PORT ?? 4499);",
    "// stdio is ignored and the child is awaited on shutdown: killing a child with",
    "// inherited stdio and then calling process.exit() trips a libuv assertion on",
    "// Windows, which fails the run even when every check passed.",
    "const child = spawn(process.execPath, [\"server.js\"], {",
    "  env: { ...process.env, PORT: String(port) },",
    "  stdio: \"ignore\"",
    "});",
    "",
    "const base = \"http://127.0.0.1:\" + port;",
    "let failures = 0;",
    "",
    "function check(label, condition) {",
    "  console.log((condition ? \"  ok   \" : \"  FAIL \") + label);",
    "  if (!condition) failures += 1;",
    "}",
    "",
    "try {",
    "  for (let attempt = 0; attempt < 40; attempt += 1) {",
    "    try { await fetch(base + \"/health\"); break; } catch { await delay(100); }",
    "  }",
    "",
    "  const health = await fetch(base + \"/health\");",
    "  check(\"health responds 200\", health.status === 200);",
    "",
    perEntityChecks,
    "",
    "  const invalid = await fetch(base + \"/api/" + entity.plural + "\", {",
    "    method: \"POST\",",
    "    headers: { \"Content-Type\": \"application/json\""
      + (hasRoles ? ", \"x-role\": \"admin\"" : "") + " },",
    "    body: JSON.stringify({})",
    "  });",
    "  check(\"missing required fields are rejected\", invalid.status === 400);",
    "",
    "  const ghost = await fetch(base + \"/api/" + entity.plural + "/does-not-exist\""
      + (hasRoles ? ", { headers: { \"x-role\": \"admin\" } }" : "") + ");",
    "  check(\"unknown id returns 404\", ghost.status === 404);",
    relationChecks,
    roleChecks,
    "} finally {",
    "  child.kill();",
    "  // Let the child fully exit before this process does.",
    "  await Promise.race([once(child, \"exit\"), delay(2000)]);",
    "}",
    "",
    "console.log(failures === 0 ? \"\\nAll checks passed.\" : \"\\n\" + failures + \" check(s) failed.\");",
    "// Set the code rather than forcing exit, so open handles unwind cleanly.",
    "process.exitCode = failures === 0 ? 0 : 1;",
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The calculator archetype.
//
// No entities, no store, no CRUD routes — a calculator has nothing to save.
// Everything below is its own small, complete generator rather than a special
// case bolted onto the entity-driven one above, because there is no entity
// here to bolt it onto.
// ---------------------------------------------------------------------------

function calculatorPackageFile(spec: ProjectSpec): string {
  return JSON.stringify({
    name: spec.slug,
    version: "0.1.0",
    private: true,
    type: "module",
    description: spec.summary,
    engines: { node: ">=18.0.0" },
    scripts: {
      start: "node server.js",
      smoke: "node smoke.js"
    }
  }, null, 2) + "\n";
}

function calculatorReadmeFile(spec: ProjectSpec): string {
  return [
    "# " + spec.title,
    "",
    spec.summary,
    "",
    "## Run it",
    "",
    "```bash",
    "node server.js",
    "```",
    "",
    "Then open http://localhost:4400",
    "",
    "No dependencies and no install step — this runs on the Node standard library alone.",
    "",
    "## API",
    "",
    "| Method | Path | Purpose |",
    "| --- | --- | --- |",
    "| GET | `/health` | Liveness check |",
    "| POST | `/api/calculate` | `{ a, b, operation }` -> `{ result }` |",
    "",
    "`operation` is one of `add`, `subtract`, `multiply`, `divide`. Dividing by",
    "zero and non-numeric input are both rejected with a 400 and an `error`",
    "field, not silently turned into `null` or `Infinity`.",
    ""
  ].join("\n");
}

/** The four operations the UI, the API and the smoke test all share. */
function calculatorOperationsSource(): string {
  return [
    "const operations = {",
    "  add: (a, b) => a + b,",
    "  subtract: (a, b) => a - b,",
    "  multiply: (a, b) => a * b,",
    "  divide: (a, b) => {",
    "    if (b === 0) throw new Error(\"Cannot divide by zero\");",
    "    return a / b;",
    "  }",
    "};",
    "",
    "function calculate(a, b, operation) {",
    "  if (typeof a !== \"number\" || !Number.isFinite(a)) return { error: \"a must be a finite number\" };",
    "  if (typeof b !== \"number\" || !Number.isFinite(b)) return { error: \"b must be a finite number\" };",
    "  const fn = operations[operation];",
    "  if (!fn) return { error: \"operation must be one of: \" + Object.keys(operations).join(\", \") };",
    "  try {",
    "    return { result: fn(a, b) };",
    "  } catch (error) {",
    "    return { error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "}"
  ].join("\n");
}

function calculatorServerFile(): string {
  return [
    "import { createServer } from \"node:http\";",
    "import { readFile } from \"node:fs/promises\";",
    "import { fileURLToPath } from \"node:url\";",
    "import path from \"node:path\";",
    "",
    "const rootDir = path.dirname(fileURLToPath(import.meta.url));",
    "",
    calculatorOperationsSource(),
    "",
    "function sendJson(response, status, payload) {",
    "  const body = JSON.stringify(payload, null, 2);",
    "  response.writeHead(status, {",
    "    \"Content-Type\": \"application/json; charset=utf-8\",",
    "    \"Content-Length\": Buffer.byteLength(body)",
    "  });",
    "  response.end(body);",
    "}",
    "",
    "const server = createServer(async (request, response) => {",
    "  const url = new URL(request.url, \"http://localhost\");",
    "",
    "  if (request.method === \"GET\" && url.pathname === \"/health\") {",
    "    sendJson(response, 200, { status: \"ok\" });",
    "    return;",
    "  }",
    "",
    "  if (request.method === \"POST\" && url.pathname === \"/api/calculate\") {",
    "    const chunks = [];",
    "    for await (const chunk of request) chunks.push(chunk);",
    "    let body;",
    "    try {",
    "      body = JSON.parse(Buffer.concat(chunks).toString(\"utf8\") || \"{}\");",
    "    } catch {",
    "      sendJson(response, 400, { error: \"invalid JSON body\" });",
    "      return;",
    "    }",
    "",
    "    const outcome = calculate(Number(body.a), Number(body.b), String(body.operation ?? \"\"));",
    "    sendJson(response, outcome.error ? 400 : 200, outcome);",
    "    return;",
    "  }",
    "",
    "  if (request.method === \"GET\" && (url.pathname === \"/\" || url.pathname === \"/index.html\")) {",
    "    try {",
    "      const html = await readFile(path.join(rootDir, \"public\", \"index.html\"), \"utf8\");",
    "      response.writeHead(200, { \"Content-Type\": \"text/html; charset=utf-8\" });",
    "      response.end(html);",
    "    } catch {",
    "      sendJson(response, 500, { error: \"index.html is missing\" });",
    "    }",
    "    return;",
    "  }",
    "",
    "  sendJson(response, 404, { error: \"not found\" });",
    "});",
    "",
    "const port = Number(process.env.PORT ?? 4400);",
    "server.listen(port, () => {",
    "  console.log(\"listening on http://localhost:\" + port);",
    "});",
    ""
  ].join("\n");
}

function calculatorUiFile(spec: ProjectSpec): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "  <title>" + spec.title + "</title>",
    "  <style>",
    "    body { font-family: system-ui, sans-serif; max-width: 360px; margin: 48px auto; padding: 0 16px; }",
    "    h1 { font-size: 1.25rem; }",
    "    .row { display: flex; gap: 8px; margin-bottom: 8px; }",
    "    input, select, button { font-size: 1rem; padding: 8px; }",
    "    input { width: 100px; }",
    "    #result { margin-top: 16px; font-size: 1.1rem; min-height: 1.5em; }",
    "    #result.error { color: #b3261e; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <h1>" + spec.title + "</h1>",
    "  <div class=\"row\">",
    "    <input id=\"a\" type=\"number\" placeholder=\"First number\" />",
    "    <select id=\"operation\">",
    "      <option value=\"add\">+</option>",
    "      <option value=\"subtract\">-</option>",
    "      <option value=\"multiply\">×</option>",
    "      <option value=\"divide\">÷</option>",
    "    </select>",
    "    <input id=\"b\" type=\"number\" placeholder=\"Second number\" />",
    "  </div>",
    "  <button id=\"go\">=</button>",
    "  <div id=\"result\"></div>",
    "  <script>",
    "    const resultEl = document.getElementById(\"result\");",
    "    document.getElementById(\"go\").addEventListener(\"click\", async () => {",
    "      const a = Number(document.getElementById(\"a\").value);",
    "      const b = Number(document.getElementById(\"b\").value);",
    "      const operation = document.getElementById(\"operation\").value;",
    "",
    "      resultEl.className = \"\";",
    "      resultEl.textContent = \"…\";",
    "",
    "      try {",
    "        const response = await fetch(\"/api/calculate\", {",
    "          method: \"POST\",",
    "          headers: { \"Content-Type\": \"application/json\" },",
    "          body: JSON.stringify({ a, b, operation })",
    "        });",
    "        const payload = await response.json();",
    "        if (!response.ok) {",
    "          resultEl.className = \"error\";",
    "          resultEl.textContent = payload.error;",
    "          return;",
    "        }",
    "        resultEl.textContent = \"= \" + payload.result;",
    "      } catch {",
    "        resultEl.className = \"error\";",
    "        resultEl.textContent = \"Could not reach the server.\";",
    "      }",
    "    });",
    "  </script>",
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

function calculatorSmokeFile(): string {
  return [
    "// Starts the server, exercises the real API, and reports the result.",
    "import { spawn } from \"node:child_process\";",
    "import { once } from \"node:events\";",
    "import { setTimeout as delay } from \"node:timers/promises\";",
    "",
    "const port = Number(process.env.SMOKE_PORT ?? 4499);",
    "const child = spawn(process.execPath, [\"server.js\"], {",
    "  env: { ...process.env, PORT: String(port) },",
    "  stdio: \"ignore\"",
    "});",
    "",
    "const base = \"http://127.0.0.1:\" + port;",
    "let failures = 0;",
    "",
    "function check(label, condition) {",
    "  console.log((condition ? \"  ok   \" : \"  FAIL \") + label);",
    "  if (!condition) failures += 1;",
    "}",
    "",
    "async function calc(a, b, operation) {",
    "  const response = await fetch(base + \"/api/calculate\", {",
    "    method: \"POST\",",
    "    headers: { \"Content-Type\": \"application/json\" },",
    "    body: JSON.stringify({ a, b, operation })",
    "  });",
    "  return { status: response.status, body: await response.json() };",
    "}",
    "",
    "try {",
    "  for (let attempt = 0; attempt < 40; attempt += 1) {",
    "    try { await fetch(base + \"/health\"); break; } catch { await delay(100); }",
    "  }",
    "",
    "  const health = await fetch(base + \"/health\");",
    "  check(\"health responds 200\", health.status === 200);",
    "",
    "  const sum = await calc(2, 3, \"add\");",
    "  check(\"2 + 3 = 5\", sum.status === 200 && sum.body.result === 5);",
    "",
    "  const diff = await calc(10, 4, \"subtract\");",
    "  check(\"10 - 4 = 6\", diff.status === 200 && diff.body.result === 6);",
    "",
    "  const product = await calc(6, 7, \"multiply\");",
    "  check(\"6 * 7 = 42\", product.status === 200 && product.body.result === 42);",
    "",
    "  const quotient = await calc(9, 2, \"divide\");",
    "  check(\"9 / 2 = 4.5\", quotient.status === 200 && quotient.body.result === 4.5);",
    "",
    "  const byZero = await calc(5, 0, \"divide\");",
    "  check(\"division by zero is rejected, not Infinity\", byZero.status === 400 && typeof byZero.body.error === \"string\");",
    "",
    "  const badOp = await calc(1, 1, \"exponentiate\");",
    "  check(\"an unknown operation is rejected\", badOp.status === 400);",
    "",
    "  const badInput = await calc(\"nope\", 1, \"add\");",
    "  check(\"non-numeric input is rejected, not coerced\", badInput.status === 400);",
    "",
    "  const page = await fetch(base + \"/\");",
    "  check(\"the calculator page itself loads\", page.status === 200);",
    "} finally {",
    "  child.kill();",
    "  await Promise.race([once(child, \"exit\"), delay(2000)]);",
    "}",
    "",
    "console.log(failures === 0 ? \"\\nAll checks passed.\" : \"\\n\" + failures + \" check(s) failed.\");",
    "process.exitCode = failures === 0 ? 0 : 1;",
    ""
  ].join("\n");
}

function generateCalculatorProject(spec: ProjectSpec): GeneratedFile[] {
  return [
    { path: "package.json", content: calculatorPackageFile(spec) },
    { path: "README.md", content: calculatorReadmeFile(spec) },
    { path: "server.js", content: calculatorServerFile() },
    { path: "smoke.js", content: calculatorSmokeFile() },
    { path: "public/index.html", content: calculatorUiFile(spec) }
  ];
}

export function generateProject(spec: ProjectSpec): GeneratedFile[] {
  if (spec.kind === "calculator") return generateCalculatorProject(spec);

  return [
    { path: "package.json", content: packageFile(spec) },
    { path: "README.md", content: readmeFile(spec) },
    { path: "server.js", content: serverFile(spec) },
    { path: "store.js", content: storeFile() },
    { path: "smoke.js", content: smokeFile(spec) },
    { path: "public/index.html", content: uiFile(spec) }
  ];
}
