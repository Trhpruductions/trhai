// The Settings app's sections, and what a search of them keeps. Pure, so it
// is testable without a screen.

export type SectionId = "account" | "assistant" | "voice" | "appearance" | "messaging" | "notifications" | "data" | "about";

export type Section = { id: SectionId; label: string; summary: string; keywords: string };

export const sections: Section[] = [
  { id: "account", label: "Account", summary: "Sign in, out, password, recovery codes.", keywords: "sign in out password recovery codes email login" },
  { id: "assistant", label: "Assistant", summary: "Personality, accent colour, agent and model.", keywords: "personality tone agent model accent colour color" },
  { id: "voice", label: "Voice", summary: "The voice TRH AI speaks with.", keywords: "voice speech speak piper sound" },
  { id: "appearance", label: "Appearance", summary: "What stands behind everything.", keywords: "background scene theme look plain still living" },
  { id: "messaging", label: "Texts and email", summary: "Your email account and Phone Link.", keywords: "email smtp texts sms phone link mail" },
  { id: "notifications", label: "Notifications", summary: "Desktop notifications for reminders and schedules.", keywords: "notifications reminders desktop alerts" },
  { id: "data", label: "Data and privacy", summary: "Where your data is kept, and how.", keywords: "data privacy encryption encrypted storage files backup folder key" },
  { id: "about", label: "About", summary: "Versions and build.", keywords: "about version build commit update" }
];

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === "string" && sections.some((section) => section.id === value);
}

/** Sections a search keeps: every word in the label, the summary or the keywords. */
export function filterSections(query: string): Section[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sections.filter((section) => {
    const text = `${section.label} ${section.summary} ${section.keywords}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
