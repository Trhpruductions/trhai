// Texts and email, as the settings screen sees them. See the API's
// messaging.ts and emailAccount.ts: texts go out from the user's own phone
// through Phone Link, email through their own account, and the app password
// goes to the API and never comes back.

export type EmailAccountView =
  | { configured: false }
  | {
    configured: true;
    address: string;
    username?: string;
    host: string;
    port: number;
    secure: boolean;
    fromName?: string;
    provider?: string;
    savedAt: string;
  };

export type ProviderHint = { name: string; domains: string[]; passwordHelp: string };

/** Phone Link installed with a phone linked, installed with none, or not on this PC. */
export type PhoneLinkStatus = "linked" | "not-linked" | "missing";

export type MessagingStatus = {
  email: EmailAccountView;
  texts: { phoneLink: PhoneLinkStatus };
  providers: ProviderHint[];
};

/** What the settings screen says about texting, for each Phone Link state. */
export function describeTexting(status: PhoneLinkStatus): { ready: boolean; text: string } {
  switch (status) {
    case "linked":
      return { ready: true, text: "Texts open in Phone Link, written and ready, and go from your phone when you press Send." };
    case "not-linked":
      return {
        ready: false,
        text: "Texts go out from your phone through Phone Link, but no phone is linked to it yet. Open Phone Link from the Start menu and follow its steps to link your phone."
      };
    default:
      return {
        ready: false,
        text: "Texts go out from your phone through Phone Link, which isn't on this PC. Install it from the Microsoft Store and link your phone."
      };
  }
}

/** The provider an address belongs to, from the API's list, or null. */
export function providerHint(address: string, providers: ProviderHint[]): ProviderHint | null {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  if (!domain) return null;
  return providers.find((provider) => provider.domains.includes(domain)) ?? null;
}

/**
 * Whether the form has to ask for the server: only for an address whose
 * provider the API does not know. Gmail, Yahoo, iCloud and the rest fill it in.
 */
export function needsServer(address: string, providers: ProviderHint[]): boolean {
  return /@[^@\s]+\.[^@\s]+$/.test(address.trim()) && !providerHint(address, providers);
}
