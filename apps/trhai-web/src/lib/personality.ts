// Personality, stored locally the same way the accent is (theme.ts). The
// picker and its effects live in @ascend/shared, shared with Vexora; this is
// only the storage half, namespaced for this app.

import { defaultPersonality, resolvePersonality, type PersonalityId } from "@ascend/shared";

const storageKey = "trhai.personality.v1";

export function readStoredPersonality(storage: Pick<Storage, "getItem"> | undefined): PersonalityId {
  if (!storage) return defaultPersonality;
  try {
    return resolvePersonality(storage.getItem(storageKey));
  } catch {
    return defaultPersonality;
  }
}

export function writeStoredPersonality(storage: Pick<Storage, "setItem"> | undefined, id: PersonalityId): void {
  try {
    storage?.setItem(storageKey, id);
  } catch {
    // A personality choice not persisting is not worth failing over.
  }
}
