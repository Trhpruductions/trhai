// Presentation rules for stored memories.
//
// A memory has a title and a body, but extraction derives the title *from* the
// body, so for anything the user has not renamed the two are the same sentence.
// Rendering both printed it twice on every row of the Memory panel.
//
// The reply composer already applies this rule when citing a memory; this is the
// same judgement for the panel, kept in one place so the two cannot drift.

export type MemoryLike = {
  title: string;
  body: string;
};

/**
 * Whether the body says anything the title has not already said.
 *
 * Also covers the near-miss case: extraction often trims the title to a prefix
 * of the body, and "we standardized on Postgres" above "we standardized on
 * Postgres for all services" reads as a stutter rather than as detail.
 */
export function memoryBodyAddsInfo(item: MemoryLike): boolean {
  const title = item.title.trim().toLowerCase();
  const body = item.body.trim().toLowerCase();

  if (!body) return false;
  if (!title) return true;
  if (title === body) return false;

  return !body.startsWith(title);
}
