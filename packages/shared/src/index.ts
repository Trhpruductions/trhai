export type AssistantMode = "general" | "coding" | "business" | "creator";

export type TraceEnvelope<T> = {
  data: T;
  traceId: string;
};
