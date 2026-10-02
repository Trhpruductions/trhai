import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { readEmailAccount, providerFor, type EmailAccount } from "./emailAccount.js";

// Sending a text or an email for the user, from this machine.
//
// No messaging service sits in between, so nothing needs an API key - the
// rule for this whole app. A text goes out from the user's own phone through
// Phone Link: TRH AI opens it there addressed and written, and the user presses
// Send. An email goes through the user's own email account when one is saved
// (see emailAccount.ts), and otherwise opens in their mail app ready to send.
//
// Nothing is ever sent that the user has not seen. Both tools are level 4 in
// toolPermissions: a call is checked here first (messageProblem), held, and
// shown word for word, and an approval replays exactly that message - see
// resolveSendMessage in the orchestrator - never a fresh one the model writes
// after the "yes". What sendText and sendEmail return is therefore read by the
// user, not the model, and says "you".

export type SendOutcome = { ok: boolean; content: string; via?: "phone-link" | "email-account" | "mail-app" };

/** Everything that touches the machine or the network, so a test can stand in for it. */
export type MessagingDeps = {
  /** Opens a link with this machine's handler for it. True when something opened. */
  open?: (url: string) => Promise<boolean>;
  /** Whether Phone Link is here, with a phone linked, to send texts. */
  phoneLink?: PhoneLinkStatus;
  /** The saved email account; null for none. Read from the store when left out. */
  account?: EmailAccount | null;
  /** Builds the SMTP connection; nodemailer's own when left out. */
  createTransport?: typeof nodemailer.createTransport;
};

/** The tools that send a message. */
export const sendingTools: ReadonlySet<string> = new Set(["send_text", "send_email"]);

/** The longest text sent as one: past this a phone splits it, and some phones drop the rest. */
export const maxTextLength = 1600;
/** Windows hands a link to an app through a command line, which cuts off long ones. */
const maxLinkLength = 2000;

/**
 * A phone number as digits, with a leading + when it had one, or null.
 *
 * Seven to fifteen digits (the international maximum), written with the usual
 * separators. A name is not a number: "mom" is refused with a message saying
 * to look the number up, rather than being sent anywhere.
 */
export function normalizePhoneNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** A number the way a person reads one: (555) 010-0123 for ten digits. */
export function formatPhoneNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (!number.startsWith("+") && digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return number;
}

const emailPattern = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** One to ten addresses, as a list or separated by commas, or null if any is not one. */
export function parseEmailAddresses(raw: unknown): string[] | null {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;]/) : null;
  if (!list) return null;
  const addresses = list.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  if (addresses.length === 0 || addresses.length > 10) return null;
  return addresses.every((address) => emailPattern.test(address)) ? addresses : null;
}

/** An sms: link, which opens a new message in Phone Link addressed and written. */
export function smsLink(number: string, message: string): string {
  return `sms:${number}?body=${encodeURIComponent(message)}`;
}

/** A mailto: link, which opens a new email in the mail app addressed and written. */
export function mailtoLink(to: string[], subject: string, body: string): string {
  const query = [subject ? `subject=${encodeURIComponent(subject)}` : "", `body=${encodeURIComponent(body)}`]
    .filter(Boolean).join("&");
  return `mailto:${to.join(",")}?${query}`;
}

export type PhoneLinkStatus = "linked" | "not-linked" | "missing";

/**
 * Whether Phone Link can send a text from this PC: installed, and with a phone
 * linked to it.
 *
 * Installed is not enough. On the machine this was built on, Phone Link was
 * there and registered for sms: links, and opening one did nothing at all -
 * no phone had ever been linked, so there was nothing to send through, and the
 * hand-off reported success while nothing appeared. A linked phone leaves its
 * data under LocalCache\Indexed, one folder per device; an unlinked install has
 * no such folder.
 */
export function phoneLinkStatus(localAppData = process.env.LOCALAPPDATA, platform: string = process.platform): PhoneLinkStatus {
  if (platform !== "win32" || !localAppData) return "missing";
  const app = path.join(localAppData, "Packages", "Microsoft.YourPhone_8wekyb3d8bbwe");
  if (!existsSync(app)) return "missing";
  try {
    const devices = readdirSync(path.join(app, "LocalCache", "Indexed"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    return devices.length > 0 ? "linked" : "not-linked";
  } catch {
    return "not-linked";
  }
}

/**
 * Opens a link with whatever this machine has set to handle it.
 *
 * Not through cmd's start: the link is one argument to a program, never a
 * line for a shell to read, so the & in a mailto link and the % of its
 * encoding reach the handler as they were written.
 */
export function openWithSystem(url: string): Promise<boolean> {
  const [command, args]: [string, string[]] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Why a call to send a message cannot go ahead as written, or null when it can.
 *
 * Addressed to the model, which made the call and can fix it. Checked before
 * the call is held for approval, so the user is never asked to approve a
 * message that could only fail - "Send this text to mom?" approved, and then
 * refused because mom is not a phone number.
 */
export function messageProblem(
  tool: string,
  args: Record<string, unknown>,
  deps: Pick<MessagingDeps, "phoneLink"> = {}
): string | null {
  if (tool === "send_text") {
    // Before anything about the message: with no phone to send through, the
    // user should hear that, not approve a text that cannot go.
    const phoneLink = deps.phoneLink ?? phoneLinkStatus();
    if (phoneLink !== "linked") {
      return phoneLink === "not-linked"
        ? "Texts cannot go out from this PC yet: Phone Link is installed but no phone is linked to it. Nothing was "
          + "sent. Tell the user to open Phone Link from the Start menu and link their phone, then ask again."
        : "Texts cannot go out from this PC: Phone Link, which sends them from the user's phone, is not installed. "
          + "Nothing was sent. Tell the user to install Phone Link from the Microsoft Store and link their phone.";
    }
    if (!normalizePhoneNumber(args.to)) {
      const given = text(args.to);
      return given
        ? `"${given}" is not a phone number, so nothing was sent. send_text needs the number itself: find it `
          + "with search_memory, or ask the user for it."
        : "send_text needs the phone number to text.";
    }
    const message = text(args.message);
    if (!message) return "send_text needs the message to send.";
    if (message.length > maxTextLength) {
      return `That text is ${message.length.toLocaleString("en-US")} characters; a phone sends at most `
        + `${maxTextLength.toLocaleString("en-US")} as one message. Write a shorter one.`;
    }
    return null;
  }
  if (tool === "send_email") {
    if (!parseEmailAddresses(args.to)) {
      const given = text(args.to);
      return given
        ? `"${given}" is not an email address, so nothing was sent. send_email needs the address itself: find `
          + "it with search_memory, or ask the user for it."
        : "send_email needs the address to send to.";
    }
    if (!text(args.body)) return "send_email needs the body of the email.";
    return null;
  }
  return null;
}

/** A text message, opened in Phone Link ready to send. */
export async function sendText(args: Record<string, unknown>, deps: MessagingDeps = {}): Promise<SendOutcome> {
  // Phone Link is checked here in the user's own words; the shared check
  // below is worded for the model, which the user never reads.
  const phoneLink = deps.phoneLink ?? phoneLinkStatus();
  if (phoneLink !== "linked") {
    return {
      ok: false,
      content: phoneLink === "not-linked"
        ? "Nothing was sent. Texts go out from your own phone through Phone Link, and no phone is linked to it on this PC yet. "
          + "Open Phone Link from the Start menu and follow its steps to link your phone, then ask again."
        : "Nothing was sent. Texts go out from your own phone through Phone Link, which isn't on this PC. "
          + "It comes with Windows 11 - install Phone Link from the Microsoft Store, link your phone, then ask again."
    };
  }
  const problem = messageProblem("send_text", args, { phoneLink });
  if (problem) return { ok: false, content: problem };
  const number = normalizePhoneNumber(args.to) as string;
  const message = text(args.message);

  const link = smsLink(number, message);
  if (link.length > maxLinkLength) {
    return { ok: false, content: "Nothing was sent - that text is too long to hand to Phone Link. Shorten it and ask again." };
  }
  const opened = await (deps.open ?? openWithSystem)(link);
  return opened
    ? {
      ok: true,
      via: "phone-link",
      content: `Phone Link is open with your text to ${formatPhoneNumber(number)} written and ready - press **Send** `
        + "there and it goes from your phone."
    }
    : { ok: false, content: "Nothing was sent - Phone Link could not be opened." };
}

/** Why the server refused or could not be reached, with what to do about it. */
export function explainSendFailure(error: unknown, account: Pick<EmailAccount, "address" | "host" | "port">): string {
  const failure = error as { code?: string; responseCode?: number; message?: string } | null;
  const code = failure?.code ?? "";
  if (code === "EAUTH" || failure?.responseCode === 535 || failure?.responseCode === 534) {
    const help = providerFor(account.address)?.passwordHelp;
    return `${account.host} refused the sign-in for ${account.address}.${help ? ` ${help}` : " Check the app password in Settings > Email."}`;
  }
  if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(code)) {
    return `${account.host}:${account.port} could not be reached. Check the internet connection, and the server and port in Settings > Email.`;
  }
  if (failure?.responseCode && failure.responseCode >= 500) {
    return `${account.host} refused the message: ${firstLine(failure.message ?? "")}`;
  }
  return firstLine(failure?.message ?? "the mail server did not accept it.");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0].trim().slice(0, 240);
}

/** Sends through the user's own account. */
export async function sendWithAccount(
  account: EmailAccount,
  message: { to: string[]; subject: string; body: string },
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport
): Promise<SendOutcome> {
  // A server on this machine itself - a mail bridge such as Proton's - is the
  // one place a plain connection is fine: nothing leaves the PC, and those
  // bridges sign their TLS themselves.
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(account.host);
  const transport = createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    // Anywhere else, STARTTLS is required on a plain port: a server that does
    // not offer it does not get the password sent in the clear.
    requireTLS: !account.secure && !loopback,
    ...(loopback ? { tls: { rejectUnauthorized: false } } : {}),
    auth: { user: account.username ?? account.address, pass: account.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000
  });
  try {
    await transport.sendMail({
      from: account.fromName ? { name: account.fromName, address: account.address } : account.address,
      to: message.to,
      subject: message.subject,
      text: message.body
    });
    return { ok: true, via: "email-account", content: `Sent your email to ${message.to.join(", ")} from ${account.address}.` };
  } catch (error) {
    return { ok: false, content: `Your email was not sent: ${explainSendFailure(error, account)}` };
  } finally {
    transport.close();
  }
}

/** An email, sent from the user's account, or opened in their mail app when none is saved. */
export async function sendEmail(args: Record<string, unknown>, deps: MessagingDeps = {}): Promise<SendOutcome> {
  const problem = messageProblem("send_email", args);
  if (problem) return { ok: false, content: problem };
  const to = parseEmailAddresses(args.to) as string[];
  const subject = text(args.subject).replace(/[\r\n]+/g, " ").slice(0, 200);
  const body = text(args.body);

  const account = deps.account !== undefined ? deps.account : readEmailAccount();
  if (account) return sendWithAccount(account, { to, subject, body }, deps.createTransport);

  const link = mailtoLink(to, subject, body);
  if (link.length > maxLinkLength) {
    return {
      ok: false,
      content: "Nothing was sent - that email is too long to hand to a mail app in one go. Add your email account in "
        + "**Settings > Email** and TRH AI can send it directly."
    };
  }
  const opened = await (deps.open ?? openWithSystem)(link);
  return opened
    ? {
      ok: true,
      via: "mail-app",
      content: `Your mail app is open with the email to ${to.join(", ")} written and ready - press **Send** there. `
        + "To have TRH AI send emails itself, add your email account in **Settings > Email**."
    }
    : {
      ok: false,
      content: "Nothing was sent - no mail app opened. Add your email account in **Settings > Email** and TRH AI can send it directly."
    };
}

/**
 * What the user is shown before a message goes: the message itself, word for
 * word, and how it would go. Written here rather than by the model, so the
 * words approved are exactly the words sent - a model asked to repeat a
 * message back is a model that can quietly reword it.
 */
export function describeHeldMessage(
  tool: string,
  args: Record<string, unknown>,
  account: { configured: boolean; address?: string } = { configured: false }
): string {
  const quote = (value: string) => value.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  if (tool === "send_text") {
    const number = normalizePhoneNumber(args.to);
    return `Here's the text for ${number ? formatPhoneNumber(number) : text(args.to)}:\n\n${quote(text(args.message))}\n\n`
      + "It goes out from your phone through Phone Link. Say **yes** to send it, or **no** to cancel.";
  }
  const to = (parseEmailAddresses(args.to) ?? [text(args.to)]).join(", ");
  const subject = text(args.subject);
  const how = account.configured && account.address
    ? `It sends from your email account, ${account.address}.`
    : "It opens in your mail app, ready to send.";
  return `Here's the email for ${to}:\n\n${subject ? `**Subject:** ${subject}\n\n` : ""}${quote(text(args.body))}\n\n`
    + `${how} Say **yes** to send it, or **no** to cancel.`;
}
