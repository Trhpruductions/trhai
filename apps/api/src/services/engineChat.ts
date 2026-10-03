// The shape of a conversation with the model engine.
//
// llama.cpp's server speaks the chat-completions format: a tool call's
// arguments are a JSON string, every call has an id and a type, and a tool's
// result names the call it answers. The agent loop keeps its own, simpler
// shape - arguments as an object, no ids - which is what its checks read and
// what its tests script. The two are converted here, at the wire, so neither
// has to know about the other.

export type LoopToolCall = { function: { name: string; arguments: Record<string, unknown> } };

/** A message as the agent loop keeps it. */
export type LoopMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LoopToolCall[];
};

export type WireMessage = Record<string, unknown>;

/**
 * The loop's messages as the engine takes them.
 *
 * The engine refuses a tool call without a type or with arguments that are
 * not a string, so both are supplied. Ids are made up here, one per call, and
 * each tool result is given the id of the call it follows, in order. A result
 * that answers a whole batch - "none of them were run" - takes the first, and
 * one with no call before it goes without.
 */
export function toWireMessages(messages: LoopMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  let waiting: string[] = [];
  let last: string | null = null;
  let issued = 0;
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const calls = message.tool_calls.map((call) => ({
        id: `call_${++issued}`,
        type: "function",
        function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments ?? {}) }
      }));
      waiting = calls.map((call) => call.id);
      last = waiting[waiting.length - 1] ?? null;
      wire.push({ role: "assistant", content: message.content, tool_calls: calls });
      continue;
    }
    if (message.role === "tool") {
      const id = waiting.shift() ?? last;
      wire.push(id ? { role: "tool", tool_call_id: id, content: message.content } : { role: "tool", content: message.content });
      continue;
    }
    waiting = [];
    last = null;
    wire.push({ role: message.role, content: message.content });
  }
  return wire;
}

export type EngineReply = {
  model: string;
  content: string;
  /** As the engine sent them: `arguments` is a JSON string, which the loop parses. */
  toolCalls?: Array<{ function: { name: unknown; arguments: unknown } }>;
  /** "stop", "tool_calls", or "length" when the reply limit cut it off. */
  finishReason: string | null;
};

/** One finished reply out of the engine's answer to an unstreamed request. */
export function readCompletion(payload: unknown, fallbackModel: string): EngineReply {
  const body = (payload ?? {}) as { model?: unknown; choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; tool_calls?: unknown } }> };
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const calls = Array.isArray(choice?.message?.tool_calls)
    ? (choice.message.tool_calls as Array<{ function?: { name?: unknown; arguments?: unknown } }>)
      .filter((call) => call?.function)
      .map((call) => ({ function: { name: call.function!.name, arguments: call.function!.arguments } }))
    : [];
  return {
    model: typeof body.model === "string" && body.model ? body.model : fallbackModel,
    // A reply that is only tool calls has no content at all, not an empty string.
    content: typeof choice?.message?.content === "string" ? choice.message.content : "",
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null
  };
}

/**
 * The sentence in an engine error body: `{"error":{"message":"..."}}`, with
 * the message itself sometimes JSON again. Its first line, at most 200
 * characters; the body as it came when it is not JSON at all.
 */
export function engineError(body: string): string {
  let text = body.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const inner = typeof parsed.error === "string" ? parsed.error
        : parsed.error && typeof parsed.error === "object" ? JSON.stringify(parsed.error)
          : typeof parsed.message === "string" ? parsed.message : null;
      if (inner === null) break;
      text = inner.trim();
    } catch {
      break;
    }
  }
  return text.split("\n")[0].slice(0, 200);
}
