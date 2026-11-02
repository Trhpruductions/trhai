// Which key a store lets go of when it holds too many.
//
// Every per-person store caps how many keys it tracks, so an anonymous caller
// cannot grow it without bound, and drops the least recently used key when the cap
// is passed. The keys of signed-in accounts (`user:<id>`) must never be the ones
// dropped: an account is bounded by the accounts file, not by anyone's traffic, and
// five hundred made-up guest ids would otherwise push a real person's conversations
// off the disk. So the key let go of is the oldest anonymous one, and when every key
// is an account's, nothing is dropped.

export function isAccountKey(key: string): boolean {
  return key.startsWith("user:");
}

/** The least recently used key that is not an account's, in a map kept in insertion order; undefined when there is none. */
export function evictableKey(keys: Iterable<string>): string | undefined {
  for (const key of keys) if (!isAccountKey(key)) return key;
  return undefined;
}
