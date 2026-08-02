export function normalizeVoiceTranscript(transcript: string): string {
  const normalized = transcript.trim();
  if (!normalized) return "";

  const uppercase = normalized.toUpperCase();
  const blockedTokens = new Set(["[BLANK_AUDIO]", "[MUSIC]", "[NOISE]", "[SILENCE]", "[SILENCE]", "[INAUDIBLE]"]);
  if (blockedTokens.has(uppercase)) return "";

  if (/^\[[A-Z_ ]+\]$/.test(uppercase)) return "";

  const cleaned = normalized
    .replace(/\s+/g, " ")
    .replace(/([.,!?;:])(?=[A-Za-z0-9])/g, "$1 ")
    .trim();

  const letters = (cleaned.match(/[A-Za-z]/g) ?? []).length;
  const digits = (cleaned.match(/[0-9]/g) ?? []).length;
  const words = cleaned.split(/\s+/).filter(Boolean);
  const hasMeaningfulWord = words.some((word) => /[A-Za-z0-9]{2,}/.test(word));
  const compact = cleaned.toLowerCase().replace(/[^a-z]/g, "");
  const fillerTokens = new Set(["uh", "um", "hmm", "mm", "mhm", "huh", "err", "ah"]);

  if (fillerTokens.has(compact)) return "";
  if (!hasMeaningfulWord) return "";
  if (letters + digits < 2) return "";

  return cleaned;
}

export function buildVoiceProfile(request: string, mode: "general" | "coding" | "business" | "creator") {
  const normalized = request.toLowerCase();
  const hasDevelopmentIntent = /(build|create|develop|implement|feature|widget|component|debug|fix|app|code|launch|plan|design|story|video|music)/i.test(normalized);
  const isCodingMode = mode === "coding" || hasDevelopmentIntent;
  const isCreatorMode = mode === "creator" || /(design|story|visual|brand|music|video|image)/i.test(normalized);
  const isBusinessMode = mode === "business" || /(launch|plan|strategy|revenue|kpi|market|brief|ops)/i.test(normalized);

  if (isCreatorMode) {
    return {
      rate: 0.96,
      pitch: 0.9,
      volume: 0.97
    };
  }

  if (isBusinessMode) {
    return {
      rate: 0.94,
      pitch: 0.82,
      volume: 0.95
    };
  }

  return {
    rate: isCodingMode ? 1.02 : 0.92,
    pitch: isCodingMode ? 0.86 : 0.78,
    volume: isCodingMode ? 0.99 : 0.94
  };
}
