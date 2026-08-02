export function resolveDraftMessageText(
  overrideInput: string | undefined,
  stateInput: string,
  liveInputValue: string | undefined
): string {
  if (overrideInput !== undefined) {
    return overrideInput;
  }

  if (liveInputValue && liveInputValue.trim()) {
    return liveInputValue;
  }

  return stateInput;
}
