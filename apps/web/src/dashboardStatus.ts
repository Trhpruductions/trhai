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
