import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  describeHeldMessage, explainSendFailure, formatPhoneNumber, mailtoLink, messageProblem, normalizePhoneNumber,
  parseEmailAddresses, phoneLinkStatus, sendEmail, sendText, sendWithAccount, smsLink
} = await import("../src/services/messaging.js");
const {
  describeEmailAccount, providerFor, readEmailAccount, removeEmailAccount, resetEmailAccountForTests, saveEmailAccount
} = await import("../src/services/emailAccount.js");
const { wantsToSendAMessage } = await import("../src/services/actionIntent.js");
const { requiresConfirmation, permissionLevelOf, describeConfirmationNeeded } = await import("../src/services/toolPermissions.js");
const { availableTools, runTool } = await import("../src/services/agentTools.js");
const { approvesTheSend, describePendingAction, isAffirmative, resetPendingConfirmations } = await import("../src/services/pendingConfirmation.js");
const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");

/** A link opener that records what it was asked to open and opens nothing. */
function recorder(opens = true) {
  const opened: string[] = [];
  return { opened, open: async (url: string) => { opened.push(url); return opens; } };
}

/** A stand-in for nodemailer's transport: records the mail, or fails the way a server does. */
function fakeTransport(failure?: { code?: string; responseCode?: number; message: string }) {
  const sent: Array<Record<string, unknown>> = [];
  const options: Array<Record<string, unknown>> = [];
  let closed = false;
  const createTransport = ((config: Record<string, unknown>) => {
    options.push(config);
    return {
      sendMail: async (mail: Record<string, unknown>) => {
        if (failure) throw Object.assign(new Error(failure.message), failure);
        sent.push(mail);
        return { accepted: mail.to };
      },
      close: () => { closed = true; }
    };
  }) as never;
  return { sent, options, createTransport, wasClosed: () => closed };
}

const account = {
  address: "me@example.com", password: "app-password-1234", host: "smtp.example.com", port: 465, secure: true,
  savedAt: "2026-10-01T00:00:00.000Z"
};

// ------------------------------------------------------------- addresses

test("a phone number is digits, with its plus kept, and a name is not a number", () => {
  assert.equal(normalizePhoneNumber("555-010-0123"), "5550100123");
  assert.equal(normalizePhoneNumber("(555) 010 0123"), "5550100123");
  assert.equal(normalizePhoneNumber("+44 20 7946 0123"), "+442079460123");
  for (const bad of ["mom", "555-CALL-NOW", "123", "1234567890123456", "", undefined, 5550100123]) {
    assert.equal(normalizePhoneNumber(bad), null, `${String(bad)} is not a number to text`);
  }
  assert.equal(formatPhoneNumber("5550100123"), "(555) 010-0123");
  assert.equal(formatPhoneNumber("15550100123"), "+1 (555) 010-0123");
  assert.equal(formatPhoneNumber("+442079460123"), "+442079460123");
});

test("email addresses are checked one by one, up to ten", () => {
  assert.deepEqual(parseEmailAddresses("bob@example.com"), ["bob@example.com"]);
  assert.deepEqual(parseEmailAddresses("a@example.com, b@example.org; c@example.net"), ["a@example.com", "b@example.org", "c@example.net"]);
  assert.equal(parseEmailAddresses("bob"), null);
  assert.equal(parseEmailAddresses("bob@example.com, my boss"), null, "one bad address fails the lot");
  assert.equal(parseEmailAddresses(Array.from({ length: 11 }, (_, i) => `p${i}@example.com`).join(",")), null);
});

test("links carry the message encoded, so an & or a new line cannot end it early", () => {
  assert.equal(smsLink("5550100123", "Fish & chips?\nSee you at 6"), "sms:5550100123?body=Fish%20%26%20chips%3F%0ASee%20you%20at%206");
  assert.equal(mailtoLink(["a@example.com", "b@example.com"], "Q3 & Q4", "Hi"), "mailto:a@example.com,b@example.com?subject=Q3%20%26%20Q4&body=Hi");
  assert.equal(mailtoLink(["a@example.com"], "", "Hi"), "mailto:a@example.com?body=Hi");
});

// ------------------------------------------------------------- when they are offered

test("the send tools are offered for a request to text or email someone, and not for text or email as nouns", () => {
  for (const asked of [
    "text mom that I'm running late",
    "text 555-010-0123 saying the door code is 4512",
    "send John a text saying I'll be there at 5",
    "can you text my wife I'll be late",
    "email bob@example.com about the meeting",
    "email my boss that I'm sick today",
    "send an email to the team about Friday",
    "shoot a quick message to Sarah",
    "message him that the build passed"
  ]) assert.equal(wantsToSendAMessage(asked), true, asked);

  for (const asked of [
    "summarize the text in notes.txt",
    "what is my email address",
    "open the text file and fix the typo",
    "what does this error message mean",
    "make the text bigger",
    "the email address that I saved",
    "read the message log",
    "write a cover letter for a design job"
  ]) assert.equal(wantsToSendAMessage(asked), false, asked);
});

test("both tools are offered only when asked for", () => {
  const names = (options: Parameters<typeof availableTools>[1]) => availableTools(false, options).map((tool) => tool.function.name);
  assert.ok(names({ messaging: true }).includes("send_text"));
  assert.ok(names({ messaging: true }).includes("send_email"));
  assert.ok(!names({ messaging: false }).includes("send_text"));
  assert.ok(!names({ messaging: false }).includes("send_email"));
});

// ------------------------------------------------------------- held, then sent

test("sending reaches another person, so every message waits for a yes", () => {
  assert.equal(permissionLevelOf("send_text"), 4);
  assert.equal(permissionLevelOf("send_email"), 4);
  assert.equal(requiresConfirmation("send_text"), true);
  assert.equal(requiresConfirmation("send_email"), true);
  assert.match(describeConfirmationNeeded("send_text"), /is an external action/);
});

test("a call is held for approval and nothing is opened until then", async () => {
  const { opened, open } = recorder();
  const held = await runTool({ name: "send_text", arguments: { to: "555-010-0123", message: "Running late" } },
    { memories: [], knowledge: [], messaging: { open, phoneLink: "linked" as const } });
  assert.equal(held.ok, false);
  assert.equal(held.needsConfirmation, true);
  assert.deepEqual(opened, [], "nothing goes anywhere before the user says yes");

  const approved = await runTool({ name: "send_text", arguments: { to: "555-010-0123", message: "Running late" } },
    { memories: [], knowledge: [], confirmedActions: new Set(["send_text"]), messaging: { open, phoneLink: "linked" as const } });
  assert.equal(approved.ok, true);
  assert.deepEqual(opened, ["sms:5550100123?body=Running%20late"]);
  assert.match(approved.content, /press \*\*Send\*\*/, "it says plainly that the text is ready, not that it was sent");
});

test("a message that could only fail goes back to the model instead of being held", async () => {
  const { opened, open } = recorder();
  const toAName = await runTool({ name: "send_text", arguments: { to: "mom", message: "hi" } },
    { memories: [], knowledge: [], messaging: { open, phoneLink: "linked" as const } });
  assert.equal(toAName.ok, false);
  assert.equal(toAName.needsConfirmation, undefined, "not held: there is nothing to approve");
  assert.match(toAName.content, /"mom" is not a phone number/);
  assert.match(toAName.content, /search_memory/);

  assert.match(messageProblem("send_email", { to: "my boss", subject: "x", body: "y" }) ?? "", /not an email address/);
  assert.match(messageProblem("send_email", { to: "a@example.com", subject: "x", body: "" }) ?? "", /needs the body/);
  assert.match(messageProblem("send_text", { to: "5550100123", message: "x".repeat(1601) }, { phoneLink: "linked" }) ?? "", /at most 1,600/);
  assert.equal(messageProblem("send_text", { to: "5550100123", message: "fine" }, { phoneLink: "linked" }), null);
  assert.deepEqual(opened, []);
});

test("with no phone linked, a text is not offered for approval: the user hears why first", async () => {
  const { opened, open } = recorder();
  const result = await runTool({ name: "send_text", arguments: { to: "5550100123", message: "hi" } },
    { memories: [], knowledge: [], messaging: { open, phoneLink: "not-linked" } });
  assert.equal(result.ok, false);
  assert.equal(result.needsConfirmation, undefined, "nothing to approve: it could not go");
  assert.match(result.content, /no phone is linked/);
  assert.match(messageProblem("send_text", { to: "5550100123", message: "hi" }, { phoneLink: "missing" }) ?? "", /not installed/);
  assert.deepEqual(opened, []);
});

test("Phone Link counts as ready only with a phone linked to it", () => {
  const local = mkdtempSync(path.join(tmpdir(), "trhai-phonelink-"));
  assert.equal(phoneLinkStatus(local, "linux"), "missing", "not a Windows PC");
  assert.equal(phoneLinkStatus(local, "win32"), "missing");
  const app = path.join(local, "Packages", "Microsoft.YourPhone_8wekyb3d8bbwe");
  mkdirSync(path.join(app, "LocalState", "StartMenu"), { recursive: true });
  assert.equal(phoneLinkStatus(local, "win32"), "not-linked", "installed and never linked - the machine this was built on");
  mkdirSync(path.join(app, "LocalCache", "Indexed", "0b6c0d1e-device"), { recursive: true });
  assert.equal(phoneLinkStatus(local, "win32"), "linked");
});

test("a scheduled run cannot send, approved or not", async () => {
  const { opened, open } = recorder();
  const result = await runTool({ name: "send_text", arguments: { to: "5550100123", message: "hi" } },
    { memories: [], knowledge: [], unattended: true, confirmedActions: new Set(["send_text"]), messaging: { open, phoneLink: "linked" as const } });
  assert.equal(result.ok, false);
  assert.match(result.content, /nobody to approve/);
  assert.deepEqual(opened, []);
});

// ------------------------------------------------------------- texts

test("a text opens in Phone Link addressed and written, and says so honestly when it cannot", async () => {
  const { opened, open } = recorder();
  const ready = await sendText({ to: "+1 555 010 0123", message: "On my way" }, { open, phoneLink: "linked" as const });
  assert.equal(ready.ok, true);
  assert.equal(ready.via, "phone-link");
  assert.equal(opened[0], "sms:+15550100123?body=On%20my%20way");
  assert.match(ready.content, /\+1 \(555\) 010-0123/);

  const noPhoneLink = await sendText({ to: "5550100123", message: "hi" }, { open, phoneLink: "not-linked" as const });
  assert.equal(noPhoneLink.ok, false);
  assert.match(noPhoneLink.content, /Nothing was sent/);
  assert.match(noPhoneLink.content, /Phone Link/);

  const failed = await sendText({ to: "5550100123", message: "hi" }, { open: async () => false, phoneLink: "linked" as const });
  assert.equal(failed.ok, false);
  assert.match(failed.content, /Nothing was sent/);
});

// ------------------------------------------------------------- email

test("with an account saved, the email is sent through it, over TLS", async () => {
  const transport = fakeTransport();
  const result = await sendEmail({ to: "bob@example.com", subject: "Friday", body: "See you at 6." },
    { account: { ...account, fromName: "Ada" }, createTransport: transport.createTransport });
  assert.equal(result.ok, true);
  assert.equal(result.via, "email-account");
  assert.match(result.content, /Sent your email to bob@example.com from me@example.com/);
  assert.deepEqual(transport.sent[0], {
    from: { name: "Ada", address: "me@example.com" }, to: ["bob@example.com"], subject: "Friday", text: "See you at 6."
  });
  assert.equal(transport.options[0].host, "smtp.example.com");
  assert.equal(transport.wasClosed(), true, "the connection is closed after sending");

  const plain = fakeTransport();
  await sendWithAccount({ ...account, port: 587, secure: false }, { to: ["bob@example.com"], subject: "", body: "x" }, plain.createTransport);
  assert.equal(plain.options[0].requireTLS, true, "the password never goes over a plain connection");
  const local = fakeTransport();
  await sendWithAccount({ ...account, host: "127.0.0.1", port: 1025, secure: false }, { to: ["bob@example.com"], subject: "", body: "x" }, local.createTransport);
  assert.equal(local.options[0].requireTLS, false, "except to a mail bridge on this PC");
});

test("a refused sign-in says what password the provider wants", async () => {
  const transport = fakeTransport({ code: "EAUTH", responseCode: 535, message: "535 5.7.8 Username and Password not accepted" });
  const gmail = { ...account, address: "me@gmail.com", host: "smtp.gmail.com" };
  const result = await sendEmail({ to: "bob@example.com", subject: "x", body: "y" }, { account: gmail, createTransport: transport.createTransport });
  assert.equal(result.ok, false);
  assert.match(result.content, /Your email was not sent/);
  assert.match(result.content, /app password/);
  assert.match(explainSendFailure({ code: "ETIMEDOUT" }, account), /could not be reached/);
});

test("with no account, the email opens in the mail app ready to send", async () => {
  const { opened, open } = recorder();
  const result = await sendEmail({ to: "bob@example.com", subject: "Friday", body: "See you" }, { account: null, open });
  assert.equal(result.ok, true);
  assert.equal(result.via, "mail-app");
  assert.equal(opened[0], "mailto:bob@example.com?subject=Friday&body=See%20you");
  assert.match(result.content, /Settings > Email/);

  const tooLong = await sendEmail({ to: "bob@example.com", subject: "x", body: "word ".repeat(600) }, { account: null, open });
  assert.equal(tooLong.ok, false, "a link that long would be cut off on the way to the mail app");
});

// ------------------------------------------------------------- the account

test("the email account keeps its password to itself", () => {
  resetEmailAccountForTests();
  assert.deepEqual(describeEmailAccount(), { configured: false });

  const saved = saveEmailAccount({ address: "ada@gmail.com", password: "abcd efgh ijkl mnop", fromName: "Ada" });
  assert.equal(saved.ok, true);
  const view = describeEmailAccount();
  assert.deepEqual(view, {
    configured: true, address: "ada@gmail.com", host: "smtp.gmail.com", port: 465, secure: true, fromName: "Ada",
    provider: "Gmail", savedAt: (view as { savedAt: string }).savedAt
  });
  assert.ok(!JSON.stringify(view).includes("abcd"), "the password is never part of what the screen sees");
  assert.equal(readEmailAccount()?.password, "abcd efgh ijkl mnop");

  // Saving again without a password keeps the one already saved.
  assert.equal(saveEmailAccount({ address: "ada@gmail.com", fromName: "Ada L." }).ok, true);
  assert.equal(readEmailAccount()?.password, "abcd efgh ijkl mnop");
  assert.equal((describeEmailAccount() as { fromName?: string }).fromName, "Ada L.");
  // But not for a different address.
  const other = saveEmailAccount({ address: "someone@gmail.com" });
  assert.equal(other.ok, false);

  assert.equal(removeEmailAccount(), true);
  assert.deepEqual(describeEmailAccount(), { configured: false });
});

test("an unknown provider needs its server named, and a bad one is refused", () => {
  resetEmailAccountForTests();
  const missing = saveEmailAccount({ address: "me@mycompany.com", password: "secret" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /SMTP server/);
  assert.equal(saveEmailAccount({ address: "me@mycompany.com", password: "secret", host: "smtp server!" }).ok, false);
  assert.equal(saveEmailAccount({ address: "me@mycompany.com", password: "secret", host: "smtp.mycompany.com", port: 99999 }).ok, false);

  const ok = saveEmailAccount({ address: "me@mycompany.com", password: "secret", host: "smtp.mycompany.com", port: "587" });
  assert.equal(ok.ok, true);
  assert.deepEqual([readEmailAccount()?.port, readEmailAccount()?.secure], [587, false]);
  assert.equal(providerFor("x@hotmail.com")?.name, "Outlook.com");
  resetEmailAccountForTests();
});

// ------------------------------------------------------------- approval

test("the message shown for approval is the message itself, word for word", () => {
  const text = describeHeldMessage("send_text", { to: "5550100123", message: "Running late\nSave me a seat" });
  assert.match(text, /\(555\) 010-0123/);
  assert.match(text, /> Running late\n> Save me a seat/);
  assert.match(text, /\*\*yes\*\*/);

  const viaAccount = describeHeldMessage("send_email", { to: "bob@example.com", subject: "Friday", body: "See you" },
    { configured: true, address: "me@example.com" });
  assert.match(viaAccount, /\*\*Subject:\*\* Friday/);
  assert.match(viaAccount, /from your email account, me@example.com/);
  assert.match(describeHeldMessage("send_email", { to: "bob@example.com", subject: "", body: "x" }), /opens in your mail app/);

  assert.deepEqual(describePendingAction({ tool: "send_text", arguments: { to: "5550100123", message: "hi" }, request: "", askedAt: 0 }),
    { verb: "Send this text to 5550100123", target: "hi" });
});

test("'send it' approves a waiting message, and only as the whole reply", () => {
  for (const yes of ["send it", "Send it!", "send", "yes send it", "send the text", "send it now"]) {
    assert.equal(approvesTheSend(yes), true, yes);
  }
  for (const not of ["send an email to dad instead", "send it to Sam instead", "sending", "don't send it"]) {
    assert.equal(approvesTheSend(not), false, not);
  }
  assert.equal(isAffirmative("send it"), false, "it is not a general yes: it could otherwise approve a deletion");
});

// ------------------------------------------------------------- end to end

/** A stand-in Ollama that answers each chat request with the next scripted reply. */
function scriptedOllama(replies: Array<Record<string, unknown>>) {
  const chats: Array<Record<string, unknown>> = [];
  return new Promise<{ server: Server; baseUrl: string; chats: typeof chats }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        if (request.url?.startsWith("/api/tags")) {
          response.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
          return;
        }
        if (request.url?.startsWith("/api/chat")) {
          chats.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const reply = replies[Math.min(chats.length - 1, replies.length - 1)];
          response.end(JSON.stringify({ model: "llama3.2:latest", ...reply }));
          return;
        }
        response.end(JSON.stringify({ model: "llama3.2:latest", response: "ok" }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats }));
  });
}

async function withScriptedModel<T>(replies: Array<Record<string, unknown>>, run: (chats: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const { server, baseUrl, chats } = await scriptedOllama(replies);
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = baseUrl;
  try {
    return await run(chats);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    server.close();
  }
}

const textCall = {
  message: { content: "", tool_calls: [{ function: { name: "send_text", arguments: { to: "555-010-0123", message: "Running 10 minutes late, sorry!" } } }] }
};
const reworded = {
  message: { content: "", tool_calls: [{ function: { name: "send_text", arguments: { to: "555-999-0000", message: "Something else entirely" } } }] }
};

test("yes sends exactly the message that was shown, without asking the model again", async () => {
  resetPendingConfirmations();
  resetEmailAccountForTests();
  const { opened, open } = recorder();
  const messaging = { open, phoneLink: "linked" as const };
  await withScriptedModel([textCall, { message: { content: "I've sent it!" } }, reworded], async (chats) => {
    const asked = await runAssistantOrchestrator({
      mode: "general", sessionId: "send-1", userMessage: "text 555-010-0123 that I'm running 10 minutes late", messaging
    });
    assert.deepEqual(opened, [], "nothing is sent while the user has not answered");
    assert.match(asked.assistantMessage, /Here's the text for \(555\) 010-0123/);
    assert.match(asked.assistantMessage, /> Running 10 minutes late, sorry!/);
    assert.doesNotMatch(asked.assistantMessage, /I've sent it/, "the model's claim is not what the user reads");
    assert.equal(asked.pendingConfirmation?.tool, "send_text");
    assert.equal(asked.pendingConfirmation?.target, "Running 10 minutes late, sorry!");
    const chatsBeforeYes = chats.length;

    const sent = await runAssistantOrchestrator({ mode: "general", sessionId: "send-1", userMessage: "yes", messaging });
    assert.deepEqual(opened, ["sms:5550100123?body=Running%2010%20minutes%20late%2C%20sorry!"],
      "the approved words to the approved number, not a fresh call's");
    assert.equal(chats.length, chatsBeforeYes, "the model was not asked again");
    assert.match(sent.assistantMessage, /Phone Link is open with your text to \(555\) 010-0123/);

    const again = await runAssistantOrchestrator({ mode: "general", sessionId: "send-1", userMessage: "yes", messaging });
    assert.equal(opened.length, 1, "one yes sends one message");
    assert.doesNotMatch(again.assistantMessage, /Phone Link is open/);
  });
});

test("a model that only says 'Understood.' is told to make the message, once", async () => {
  const { runAgent } = await import("../src/services/agentLoop.js");
  const { server, baseUrl, chats } = await scriptedOllama([{ message: { content: "Understood." } }, textCall, { message: { content: "Ready." } }]);
  try {
    const result = await runAgent({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 },
      "text 555-010-0123 that I'm running late", { memories: [], knowledge: [], messaging: { open: async () => true, phoneLink: "linked" as const } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.awaitingConfirmation?.tool, "send_text", "the second try made the message, held for a yes");
    const correction = (chats[1].messages as Array<{ role: string; content: string }>).at(-1);
    assert.match(correction?.content ?? "", /did not call send_text or send_email/);
  } finally {
    server.close();
  }

  const asking = await scriptedOllama([{ message: { content: "What's their number?" } }]);
  try {
    const result = await runAgent({ baseUrl: asking.baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 },
      "text my sister that I'm running late", { memories: [], knowledge: [] });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.text, "What's their number?", "asking for the number is the right move");
    assert.equal(asking.chats.length, 1);
  } finally {
    asking.server.close();
  }

  const stubborn = await scriptedOllama([{ message: { content: "Understood." } }]);
  try {
    const result = await runAgent({ baseUrl: stubborn.baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 },
      "text 555-010-0123 that I'm running late", { memories: [], knowledge: [] });
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.text, /didn't get a message ready to send, so nothing went anywhere/);
  } finally {
    stubborn.server.close();
  }
});

test("no drops the message, and 'send it' sends one", async () => {
  resetPendingConfirmations();
  const { opened, open } = recorder();
  const messaging = { open, phoneLink: "linked" as const };
  await withScriptedModel([textCall, { message: { content: "Ready." } }], async () => {
    await runAssistantOrchestrator({ mode: "general", sessionId: "send-2", userMessage: "text 555-010-0123 that I'm running late", messaging });
    const declined = await runAssistantOrchestrator({ mode: "general", sessionId: "send-2", userMessage: "no", messaging });
    assert.equal(declined.assistantMessage, "Not sent. Nothing went out.");
    assert.deepEqual(opened, []);
  });

  await withScriptedModel([textCall, { message: { content: "Ready." } }], async () => {
    await runAssistantOrchestrator({ mode: "general", sessionId: "send-3", userMessage: "text 555-010-0123 that I'm running late", messaging });
    await runAssistantOrchestrator({ mode: "general", sessionId: "send-3", userMessage: "send it", messaging });
    assert.equal(opened.length, 1);
  });
});
