export type ConnectionState = "booting" | "online" | "offline";

export function getCoreIntegrity(connectionState: ConnectionState): string {
  return connectionState === "offline" ? "85%" : "100%";
}

export function getConnectionSecurityLabel(connectionState: ConnectionState): string {
  return connectionState === "offline" ? "Local" : "Encrypted";
}

export function buildConversationStatus(livePhase: string, channelState: string): string {
  return `${livePhase} · ${channelState}`;
}

/**
 * A telemetry reading as a whole percent, 0-100.
 *
 * The finite guard is the point. Two call sites can hand this a NaN:
 * `navigator.storage.estimate()` returns `usage` and `quota` as optional, so a
 * browser that reports neither divides undefined by undefined, and the JS heap
 * ratio is 0/0 before the heap is measured. Without the guard the NaN reached
 * the dashboard as a bar width and a label.
 *
 * The desktop main process carries its own copy of this rule, guard included.
 * It is deliberately dependency-free, so sharing one function across the two
 * would cost a build dependency for three lines; the duplication is the cheaper
 * trade, and this comment is here so the next person knows it was weighed.
 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
