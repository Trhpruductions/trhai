export function stableSerialize(value: unknown): string {
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (valueType === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    const body = entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(",");
    return `{${body}}`;
  }

  return JSON.stringify(String(value));
}

export async function sha256Hex(payload: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API unavailable");
  }

  const normalized = payload.replace(/\r\n/g, "\n");
  const encoder = new TextEncoder();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(normalized));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifySignedJsonExport(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bundle root must be an object");
  }

  const candidate = parsed as Record<string, unknown>;
  const integrityRaw = candidate.integrity;

  if (!integrityRaw || typeof integrityRaw !== "object" || Array.isArray(integrityRaw)) {
    throw new Error("Missing integrity metadata");
  }

  const integrity = integrityRaw as Record<string, unknown>;
  const algorithm = String(integrity.algorithm ?? "").toUpperCase();
  const canonicalization = String(integrity.canonicalization ?? "");
  const expectedHash = String(integrity.contentHash ?? "").toLowerCase();

  if (algorithm !== "SHA-256") {
    throw new Error(`Unsupported integrity algorithm: ${algorithm || "unknown"}`);
  }

  if (canonicalization !== "sorted-keys-v1") {
    throw new Error(`Unsupported canonicalization: ${canonicalization || "unknown"}`);
  }

  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) {
    throw new Error("Invalid integrity hash format");
  }

  const { integrity: _ignoredIntegrity, ...content } = candidate;
  const computedHash = await sha256Hex(stableSerialize(content));

  if (computedHash.toLowerCase() !== expectedHash) {
    const mismatch = `${computedHash.slice(0, 12)}!=${expectedHash.slice(0, 12)}`;
    throw new Error(`Integrity mismatch (${mismatch})`);
  }
}

export async function verifySignedMarkdownExport(raw: string): Promise<void> {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const integrityMap: Record<string, string> = {};

  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    const match = line.match(/^<!--\s*integrity\.([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*-->$/);
    if (!match) {
      break;
    }

    integrityMap[match[1].toLowerCase()] = match[2];
    index += 1;
  }

  const algorithm = (integrityMap.algorithm ?? "").toUpperCase();
  const scope = integrityMap.scope ?? "";
  const expectedHash = (integrityMap.contenthash ?? "").toLowerCase();

  if (!algorithm || !scope || !expectedHash) {
    throw new Error("Missing markdown integrity headers");
  }

  if (algorithm !== "SHA-256") {
    throw new Error(`Unsupported integrity algorithm: ${algorithm || "unknown"}`);
  }

  if (scope !== "markdown-body") {
    throw new Error(`Unsupported integrity scope: ${scope || "unknown"}`);
  }

  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) {
    throw new Error("Invalid integrity hash format");
  }

  const body = lines.slice(index).join("\n").replace(/^\n+/, "");
  if (!body.trim()) {
    throw new Error("Markdown body missing");
  }

  const computedHash = await sha256Hex(body);
  if (computedHash.toLowerCase() !== expectedHash) {
    const mismatch = `${computedHash.slice(0, 12)}!=${expectedHash.slice(0, 12)}`;
    throw new Error(`Integrity mismatch (${mismatch})`);
  }
}