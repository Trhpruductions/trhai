// Whether the microphone may record. Recording is only worth doing when
// something on this PC can turn the speech into words: without that, the
// audio was captured and then discarded at Stop, which looks like being heard
// and ignored.

/** Why the microphone must not record, or null when it may. Unknown (null) still may: the check is still running. */
export function whyNotListen(transcription: { available: boolean | null; reason: string | null }): string | null {
  if (transcription.available !== false) return null;
  return transcription.reason ?? "Local speech-to-text is not installed, so TRH AI cannot hear you yet.";
}
