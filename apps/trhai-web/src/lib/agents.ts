import {
  activateAgent, activeAgent, installAgent, readMarketplaceState, writeMarketplaceState, type Agent
} from "@ascend/shared";

// The storage key the Agents page and the dashboard both read, centralized
// so the two call sites cannot silently drift onto different keys.

export const marketplaceStorageKey = "trhai.marketplace.v1";

/** The active agent, or null. Read when it is needed, like the personality. */
export function readActiveAgent(storage: Storage | undefined): Agent | null {
  return activeAgent(readMarketplaceState(storage, marketplaceStorageKey));
}

/**
 * Make an agent the active one, or clear it with null, and return what is now
 * active.
 *
 * There is no marketplace page left to install from, so choosing an agent
 * installs it too - "installed" only ever meant "selectable". An id the
 * catalogue does not know changes nothing.
 */
export function chooseAgent(storage: Storage | undefined, id: string | null): Agent | null {
  const current = readMarketplaceState(storage, marketplaceStorageKey);
  const next = id === null ? activateAgent(current, null) : activateAgent(installAgent(current, id), id);
  writeMarketplaceState(storage, marketplaceStorageKey, next);
  return activeAgent(next);
}
