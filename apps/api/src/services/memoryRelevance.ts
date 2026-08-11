// E4-S3: retrieval context builder.
//
// Retrieval was pure recency, which is useless for answering a question — the
// memory that answers "which database?" is rarely the newest one. Scoring is term
// overlap plus a pinned boost, with recency only as a tiebreak.
//
// No embeddings are available here, so matching is lexical. That means a question
// phrased with different vocabulary than the stored memory will miss; the composer
// must therefore never claim an answer it did not actually retrieve.

import { extractTopics, normalizeTerm } from "./requestAnalysis.js";

/**
 * Query expansion lexicon.
 *
 * Pure term overlap cannot connect "which database?" to a memory that says
 * "Postgres" — they share no words. This maps a small set of technology
 * categories to their members so a category question reaches a concrete answer
 * and vice versa.
 *
 * This is deliberately a short, hand-curated list, not a knowledge base. Anything
 * outside it simply does not expand, and the composer's honest "nothing matches"
 * path handles that. Expanded hits score lower than direct hits so a literal match
 * always wins.
 */
// Each group lists the names a user might ask by. Multi-word categories need every
// token that identifies them: "which package manager?" tokenizes to "package" and
// "manager", so a single "packagemanager" key would never match.
const conceptGroups: Array<{ names: string[]; members: string[] }> = [
  {
    names: ["database", "db", "datastore", "storage"],
    members: ["postgres", "postgresql", "mysql", "sqlite", "mongo", "mongodb", "redis", "dynamodb", "supabase", "mariadb"]
  },
  {
    names: ["language", "lang"],
    members: ["typescript", "javascript", "python", "rust", "golang", "java", "ruby", "php", "swift", "kotlin"]
  },
  {
    names: ["framework", "library"],
    members: ["react", "vue", "svelte", "angular", "next", "nuxt", "express", "fastify", "django", "rails"]
  },
  {
    names: ["cloud", "hosting", "host", "deploy", "deployment"],
    members: ["aws", "gcp", "azure", "vercel", "netlify", "cloudflare", "heroku", "fly"]
  },
  { names: ["runtime"], members: ["node", "deno", "bun"] },
  { names: ["package", "packagemanager", "installer"], members: ["npm", "pnpm", "yarn", "bun"] },
  { names: ["testing", "test", "tests"], members: ["jest", "vitest", "mocha", "playwright", "cypress", "pytest"] },
  { names: ["editor", "ide"], members: ["vscode", "vim", "neovim", "emacs", "intellij", "zed"] },
  { names: ["ci", "pipeline"], members: ["jenkins", "circleci", "actions", "gitlab", "buildkite"] },
  { names: ["styling", "styles", "css"], members: ["tailwind", "sass", "scss", "styled"] }
];

/** member term -> category, and category -> members, both normalized. */
const expansionIndex = buildExpansionIndex();

function buildExpansionIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  const link = (from: string, to: string) => {
    const existing = index.get(from) ?? new Set<string>();
    existing.add(to);
    index.set(from, existing);
  };

  for (const group of conceptGroups) {
    const names = group.names.map(normalizeTerm);
    for (const member of group.members) {
      const normalizedMember = normalizeTerm(member);
      for (const name of names) {
        link(name, normalizedMember);
        link(normalizedMember, name);
      }
    }
  }

  return index;
}

export function expandTerm(term: string): string[] {
  return [...(expansionIndex.get(term) ?? [])];
}

export type ScorableMemory = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
};

export type ScoredMemory<T extends ScorableMemory> = {
  memory: T;
  score: number;
  /** Query terms this memory actually matched, for provenance and debugging. */
  matchedTerms: string[];
};

const pinnedBoost = 0.5;
/** A concept-expanded hit is real but weaker than a literal term match. */
const expandedMatchWeight = 0.7;
/**
 * Below this, a memory is not considered a genuine match. Tuned so a single
 * strong term hit against a rich memory still qualifies: density is deliberately
 * a light signal, otherwise long, information-dense memories get penalised for
 * containing more than the question asked about.
 */
export const relevanceThreshold = 0.28;

export function scoreMemories<T extends ScorableMemory>(
  query: string,
  memories: T[]
): Array<ScoredMemory<T>> {
  const queryTerms = extractTopics(query);
  if (queryTerms.length === 0) {
    return [];
  }

  const scored: Array<ScoredMemory<T>> = [];

  for (const memory of memories) {
    const memoryTerms = new Set(extractTopics(`${memory.title} ${memory.body}`));
    if (memoryTerms.size === 0) {
      continue;
    }

    const matchedTerms: string[] = [];
    let matchWeight = 0;

    for (const term of queryTerms) {
      if (memoryTerms.has(term)) {
        matchedTerms.push(term);
        matchWeight += 1;
        continue;
      }
      // Related concept: "database" reaching a memory that says "Postgres".
      const related = expandTerm(term).find((candidate) => memoryTerms.has(candidate));
      if (related) {
        matchedTerms.push(`${term}~${related}`);
        matchWeight += expandedMatchWeight;
      }
    }

    if (matchedTerms.length === 0) {
      continue;
    }

    const coverage = matchWeight / queryTerms.length;
    const density = matchWeight / memoryTerms.size;

    // Take the stronger of the two signals rather than blending them. Pure
    // coverage punishes detail: "which database?" matched, but "which database
    // should the new reporting service use?" did not, because the extra words
    // diluted the ratio. A more specific question must never retrieve worse.
    const primary = Math.max(coverage, density);
    const secondary = Math.min(coverage, density);
    const score = primary * 0.85 + secondary * 0.15 + (memory.pinned ? pinnedBoost : 0);

    scored.push({ memory, score, matchedTerms });
  }

  return scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    // Recency only breaks ties.
    return Date.parse(right.memory.createdAt) - Date.parse(left.memory.createdAt);
  });
}

/**
 * Memories relevant enough to ground an answer. Pinned entries clear the bar on a
 * weaker lexical match because the user explicitly marked them as important.
 */
export function selectRelevantMemories<T extends ScorableMemory>(
  query: string,
  memories: T[],
  limit = 3
): Array<ScoredMemory<T>> {
  return scoreMemories(query, memories)
    .filter((entry) => entry.score >= relevanceThreshold)
    .slice(0, limit);
}
