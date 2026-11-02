import { legalVersions } from "@ascend/shared";

/** What a request to make an account must carry: the texts as they stand now, agreed to. */
export const consents = { terms: legalVersions.terms, privacy: legalVersions.privacy, age: true };
