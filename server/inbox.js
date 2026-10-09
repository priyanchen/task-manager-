import { createHash, timingSafeEqual } from "node:crypto";
import { htmlToText } from "./google.js";

const MAX_TEXT_CHARS = 8000;

const text = (...values) => values.find((value) => typeof value === "string" && value.length > 0) ?? "";

export function normalizeInbound(body = {}) {
  const to = [].concat(body.to ?? body.To ?? body.OriginalRecipient ?? []).join(",");
  const plain = text(body.text, body.TextBody);
  const html = text(body.html, body.HtmlBody);
  return {
    to,
    from: text(body.from, body.From),
    subject: text(body.subject, body.Subject),
    text: (plain || htmlToText(html)).slice(0, MAX_TEXT_CHARS),
    messageId: text(body.messageId, body.MessageID),
  };
}

export function tokenFromAddress(to) {
  return /\b(u[0-9a-f]{16})@/i.exec(to)?.[1]?.toLowerCase() ?? null;
}

export function messageKey(prefix, message) {
  const id = message.messageId || createHash("sha256").update(`${message.from}|${message.subject}|${message.text}`).digest("hex");
  return `${prefix}:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

export function forwardingCode(from, body) {
  if (!/forwarding-noreply@google\.com/i.test(from)) return null;
  return /confirmation code:?\s*(\d{4,10})/i.exec(body)?.[1] ?? null;
}

export function sameSecret(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
