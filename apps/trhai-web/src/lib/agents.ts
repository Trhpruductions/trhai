// The storage key the Agents page and the dashboard both read, centralized
// so the two call sites cannot silently drift onto different keys.

export const marketplaceStorageKey = "trhai.marketplace.v1";
