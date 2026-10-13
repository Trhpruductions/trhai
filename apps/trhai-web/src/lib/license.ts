// The paywall, from the interface's side: what the API says about the trial
// or license, and the one event that opens the paywall screen when a request
// is refused for want of one.
//
// Nothing here knows about money. Buying happens on the owner's checkout
// page, opened in the browser; what comes back is a key, pasted in here.

import { apiBaseUrl, apiDelete, apiFetch, apiGet, licenseEventName, requestHeaders } from "./api";

export type Plan = "personal" | "pro" | "team";
export type LicenseState = "trial" | "licensed" | "trial_expired" | "license_expired";

export type LicenseStatus = {
  state: LicenseState;
  locked: boolean;
  plan: Plan | "trial";
  trialStartedAt: string;
  trialEndsAt: string;
  trialDaysLeft: number;
  license: { id: string; plan: Plan; email: string; issuedAt: string; expiresAt?: string | null; seats?: number } | null;
  checkoutUrl: string | null;
  priceText: string | null;
  paywallDisabled: boolean;
};

/** Fired on window when the API answers 402, and after a key is activated or removed. */
export const licenseEvent = licenseEventName;

export function announceLicenseChange(detail: "locked" | "changed"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(licenseEvent, { detail }));
}

export async function readLicense(): Promise<LicenseStatus | null> {
  const result = await apiGet<LicenseStatus>("/v1/license");
  return result.ok ? result.data : null;
}

export type ActivateOutcome = { ok: true; status: LicenseStatus } | { ok: false; reason: string };

export async function activateKey(key: string): Promise<ActivateOutcome> {
  try {
    const response = await apiFetch(`${apiBaseUrl}/v1/license/activate`, {
      method: "POST",
      headers: requestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ key })
    });
    const payload = await response.json().catch(() => null) as { data?: LicenseStatus; message?: string } | null;
    if (!response.ok || !payload?.data) {
      return { ok: false, reason: payload?.message ?? `The service answered ${response.status}.` };
    }
    announceLicenseChange("changed");
    return { ok: true, status: payload.data };
  } catch {
    return { ok: false, reason: "TRH AI's service could not be reached." };
  }
}

export async function removeKey(): Promise<boolean> {
  const result = await apiDelete("/v1/license");
  if (result.ok) announceLicenseChange("changed");
  return result.ok;
}

/** The plan's name as people see it. */
export function planLabel(plan: Plan | "trial"): string {
  switch (plan) {
    case "personal": return "Personal";
    case "pro": return "Pro";
    case "team": return "Team";
    default: return "Free trial";
  }
}

/** One line saying where things stand, for the settings section and the top of the paywall. */
export function describeLicense(status: LicenseStatus): string {
  if (status.paywallDisabled) return "This copy is not limited by a trial or license.";
  switch (status.state) {
    case "licensed":
      return status.license?.expiresAt
        ? `${planLabel(status.plan)} plan, licensed to ${status.license.email}, until ${new Date(status.license.expiresAt).toLocaleDateString()}.`
        : `${planLabel(status.plan)} plan, licensed to ${status.license?.email ?? "you"}. It does not expire.`;
    case "license_expired":
      return `Your ${planLabel(status.plan)} license expired on ${status.license?.expiresAt ? new Date(status.license.expiresAt).toLocaleDateString() : "an earlier date"}.`;
    case "trial_expired":
      return `Your free trial ended on ${new Date(status.trialEndsAt).toLocaleDateString()}.`;
    default:
      return status.trialDaysLeft === 1
        ? "Free trial: this is the last day."
        : `Free trial: ${status.trialDaysLeft} days left, until ${new Date(status.trialEndsAt).toLocaleDateString()}.`;
  }
}

/** Opens the owner's checkout page in the browser (the desktop shell hands web links to the OS). */
export function openCheckout(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
