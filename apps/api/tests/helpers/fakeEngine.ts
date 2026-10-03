import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for TRH AI's model engine - llama.cpp's server in router mode -
// for tests. Everything but the inference is real: a socket, HTTP, JSON, an
// event stream. It answers the routes the app uses, in the shapes the real
// engine was recorded answering them with (build b11366):
//
//   GET  /models                the models, each already loaded
//   GET  /props                 the engine's build
//   POST /models/load, /unload  accepted
//   POST /v1/chat/completions   what the test scripts, streamed when asked
//
// A reply is scripted in the agent loop's own shape - words, and tool calls
// with their arguments as an object - and sent in the engine's.

/** What a test has a model say. */
export type ScriptedReply = {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
  };
  /** What a thinking model thinks before it answers. Sent beside the reply, as the engine sends it, never in it. */
  thinking?: string;
  /** How the reply ended: "stop" unless said. "length" is one the reply limit cut off. */
  done_reason?: string;
  model?: string;
};

/** The context window the stand-in says every model is loaded with. */
export const fakeWindow = 16384;

/** The engine's model list. Every model is loaded already, so nothing waits on a load. */
export function modelsBody(names: string[], options: { window?: number; vision?: string[]; loaded?: boolean } = {}) {
  return {
    object: "list",
    data: names.map((id) => ({
      id,
      object: "model",
      owned_by: "llamacpp",
      status: { value: options.loaded === false ? "unloaded" : "loaded" },
      architecture: { input_modalities: options.vision?.includes(id) ? ["text", "image"] : ["text"], output_modalities: ["text"] },
      ...(options.loaded === false ? {} : { meta: { n_ctx: options.window ?? fakeWindow, size: 1_900_000_000 } })
    }))
  };
}

function wireCalls(reply: ScriptedReply) {
  return (reply.message?.tool_calls ?? []).map((call, index) => ({
    id: `call_${index + 1}`,
    type: "function",
    function: {
      name: call.function.name,
      arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments)
    }
  }));
}

function finishOf(reply: ScriptedReply): string {
  return reply.done_reason ?? ((reply.message?.tool_calls?.length ?? 0) > 0 ? "tool_calls" : "stop");
}

/** An unstreamed reply, as the engine sends one. */
export function completionBody(model: string, reply: ScriptedReply) {
  const calls = wireCalls(reply);
  return {
    object: "chat.completion",
    model: reply.model ?? model,
    choices: [{
      index: 0,
      finish_reason: finishOf(reply),
      message: {
        role: "assistant",
        ...(reply.thinking ? { reasoning_content: reply.thinking } : {}),
        content: reply.message?.content ?? "",
        ...(calls.length > 0 ? { tool_calls: calls } : {})
      }
    }]
  };
}

/** One event of a streamed reply. */
export function streamEvent(model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** A whole streamed reply: its words a line at a time, any tool calls, the ending, then [DONE]. */
export function streamEvents(model: string, reply: ScriptedReply): string[] {
  const name = reply.model ?? model;
  const events = [streamEvent(name, { role: "assistant", content: null })];
  // Its thoughts first, a line at a time, as a thinking model sends them.
  for (const piece of (reply.thinking ?? "").split(/(?<=\n)/).filter(Boolean)) {
    events.push(streamEvent(name, { reasoning_content: piece }));
  }
  for (const piece of (reply.message?.content ?? "").split(/(?<=\n)/).filter(Boolean)) {
    events.push(streamEvent(name, { content: piece }));
  }
  const calls = wireCalls(reply);
  if (calls.length > 0) events.push(streamEvent(name, { tool_calls: calls.map((call, index) => ({ index, ...call })) }));
  events.push(streamEvent(name, {}, finishOf(reply)), "data: [DONE]\n\n");
  return events;
}

/** The body of a chat request, as a test reads it back. */
export type ChatBody = {
  model?: string;
  stream?: boolean;
  max_tokens?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages?: Array<{ role: string; content: any; tool_calls?: Array<{ id?: string; type?: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
  tools?: Array<{ type?: string; function: { name: string } }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

/** What one chat request is answered with: a reply, nothing at all, or an error. */
export type Answer = ScriptedReply | "hang" | { status: number; body: unknown };

export type FakeEngine = {
  server: Server;
  baseUrl: string;
  /** The body of every chat request, in the order they came. */
  chats: ChatBody[];
  /** The path of every request, in the order they came. */
  urls: string[];
  close: () => Promise<void>;
};

export function fakeEngine(options: {
  /** The models it has. One, "llama3.2:latest", unless said. */
  models?: string[];
  /** Which of them take images. */
  vision?: string[];
  window?: number;
  /**
   * What each chat request is answered with: one reply for all of them, one
   * per request (the last repeats), or a function of the request. "Done."
   * when nothing is scripted.
   */
  reply?: ScriptedReply | ScriptedReply[] | ((body: ChatBody, index: number) => Answer);
} = {}): Promise<FakeEngine> {
  const models = options.models ?? ["llama3.2:latest"];
  const chats: ChatBody[] = [];
  const urls: string[] = [];
  const answerFor = (body: ChatBody, index: number): Answer => {
    const reply = options.reply ?? { message: { content: "Done." } };
    if (typeof reply === "function") return reply(body, index);
    if (Array.isArray(reply)) return reply[Math.min(index, reply.length - 1)];
    return reply;
  };

  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const url = request.url ?? "";
        urls.push(url);
        const json = (status: number, body: unknown) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (url.startsWith("/models/load") || url.startsWith("/models/unload")) return json(200, { success: true });
        if (url.startsWith("/models") || url.startsWith("/v1/models")) {
          return json(200, modelsBody(models, { window: options.window, vision: options.vision }));
        }
        if (url.startsWith("/props")) return json(200, { build_info: "b0-test" });
        if (!url.startsWith("/v1/chat/completions")) {
          return json(404, { error: { code: 404, message: "File Not Found", type: "not_found_error" } });
        }

        const body = (chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) as ChatBody;
        const index = chats.length;
        chats.push(body);
        const answer = answerFor(body, index);
        // Never answered: what a model still at work looks like from outside.
        if (answer === "hang") return;
        if ("status" in answer) return json(answer.status, answer.body);
        const model = body.model ?? models[0];
        if (body.stream) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const event of streamEvents(model, answer)) response.write(event);
          response.end();
          return;
        }
        json(200, completionBody(model, answer));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        chats,
        urls,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
      });
    });
  });
}
