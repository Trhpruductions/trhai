// E4-S1: memory write pipeline.
//
// There is no LLM in this stack — ModelRouter is deterministic string assembly —
// so extraction is rule-based. The rules are deliberately high-precision and
// low-recall: a missed memory is invisible, but a wrong one silently poisons every
// later reply and erodes trust in the whole memory feature. Every candidate is
// tagged with the pattern that produced it and a confidence the UI can scope.

export type MemoryKind = "preference" | "fact" | "decision" | "constraint";

export type MemoryCandidate = {
  title: string;
  body: string;
  kind: MemoryKind;
  /** 0..1. Rule-based, not model-derived; treat as a precision hint only. */
  confidence: number;
  /** The rule that matched, so a bad memory can be traced to its cause. */
  rule: string;
};

type ExtractionRule = {
  name: string;
  kind: MemoryKind;
  confidence: number;
  pattern: RegExp;
};

/**
 * Each pattern must capture the memorable clause in group 1. Anchored to the
 * start of a sentence so mid-sentence mentions ("...ask whether I prefer...")
 * do not match.
 *
 * Group 1 must include the verb and any polarity word. Capturing only the object
 * inverts meaning when the memory is replayed as context: "Never deploy on Fridays"
 * stored as "deploy on Fridays" reads as an instruction to do exactly that. Only
 * the explicit remember/note rules drop their lead-in, because there the verb is
 * the user addressing the assistant rather than part of the fact.
 */
const extractionRules: ExtractionRule[] = [
  {
    name: "explicit-remember",
    kind: "fact",
    confidence: 0.95,
    pattern: /^(?:please\s+)?remember\s+(?:that\s+)?(.+)$/i
  },
  {
    name: "explicit-note",
    kind: "fact",
    confidence: 0.9,
    pattern: /^(?:make\s+a\s+)?note\s+(?:that|this)[:\s]+(.+)$/i
  },
  {
    name: "preference",
    kind: "preference",
    confidence: 0.85,
    pattern: /^i\s+((?:prefer|like|want|always\s+use)\s+.+)$/i
  },
  {
    name: "dislike",
    kind: "preference",
    confidence: 0.85,
    pattern: /^i\s+((?:don'?t\s+(?:like|want)|hate|never\s+use)\s+.+)$/i
  },
  {
    name: "team-convention",
    kind: "decision",
    confidence: 0.8,
    pattern: /^(we\s+(?:use|decided(?:\s+to)?|agreed(?:\s+to)?|standardi[sz]ed\s+on)\s+.+)$/i
  },
  {
    name: "hard-constraint",
    kind: "constraint",
    confidence: 0.8,
    pattern: /^((?:always|never)\s+.+)$/i
  },
  {
    name: "requirement",
    kind: "constraint",
    confidence: 0.75,
    pattern: /^((?:the\s+)?(?:deadline|budget|limit|quota)\s+is\s+.+)$/i
  }
];

const minBodyLength = 3;
const maxBodyLength = 400;
const maxTitleLength = 60;
const maxCandidatesPerMessage = 3;

function splitSentences(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?,;:\s]+$/, "").trim();
}

function buildTitle(body: string): string {
  const firstClause = body.split(/[,;:]/)[0].trim() || body;
  if (firstClause.length <= maxTitleLength) {
    return firstClause;
  }
  // Cut on a word boundary so titles do not end mid-word.
  const clipped = firstClause.slice(0, maxTitleLength);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trim()}...`;
}

/** Normalized form used for duplicate detection. */
export function memoryFingerprint(body: string): string {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractMemoryCandidates(message: unknown): MemoryCandidate[] {
  if (typeof message !== "string" || !message.trim()) {
    return [];
  }

  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(message)) {
    for (const rule of extractionRules) {
      const match = rule.pattern.exec(sentence);
      if (!match) {
        continue;
      }

      const body = stripTrailingPunctuation(match[1] ?? "");
      if (body.length < minBodyLength) {
        continue;
      }

      const fingerprint = memoryFingerprint(body);
      if (!fingerprint || seen.has(fingerprint)) {
        continue;
      }

      seen.add(fingerprint);
      candidates.push({
        title: buildTitle(body),
        body: body.length > maxBodyLength ? body.slice(0, maxBodyLength) : body,
        kind: rule.kind,
        confidence: rule.confidence,
        rule: rule.name
      });

      // First matching rule wins for a sentence; later rules are less specific.
      break;
    }

    if (candidates.length >= maxCandidatesPerMessage) {
      break;
    }
  }

  return candidates;
}

/**
 * Duplicate suppression: drop candidates already represented in the store.
 * Without this, repeating "remember we use Postgres" spams the memory list and
 * crowds out real context during retrieval.
 */
export function suppressDuplicateMemories(
  candidates: MemoryCandidate[],
  existingBodies: string[]
): MemoryCandidate[] {
  const known = new Set(existingBodies.map(memoryFingerprint));
  const kept: MemoryCandidate[] = [];

  for (const candidate of candidates) {
    const fingerprint = memoryFingerprint(candidate.body);
    if (known.has(fingerprint)) {
      continue;
    }
    known.add(fingerprint);
    kept.push(candidate);
  }

  return kept;
}
