import { wallTimeToMs } from "./conflicts.js";
import { buildEvent } from "./google.js";

const encoder = new TextEncoder();

const clean = (text) => String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

const escapeText = (text) =>
  clean(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

export function fold(line) {
  const lines = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      lines.push(current);
      current = " ";
      bytes = 1;
    }
    current += char;
    bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}

const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateStamp = (date) => date.replace(/-/g, "");

function eventLines(s, defaultTimeZone, now) {
  const built = buildEvent(s, defaultTimeZone);
  const url = s.url ? clean(s.url).replace(/\s/g, "") : null;
  const description = [s.offer, `By ${s.organizer}`, url].filter(Boolean).join("\n");

  const when = built.start.dateTime
    ? [
        `DTSTART:${utcStamp(wallTimeToMs(built.start.dateTime, built.start.timeZone))}`,
        `DTEND:${utcStamp(wallTimeToMs(built.end.dateTime, built.end.timeZone))}`,
      ]
    : [`DTSTART;VALUE=DATE:${dateStamp(built.start.date)}`, `DTEND;VALUE=DATE:${dateStamp(built.end.date)}`];

  return [
    "BEGIN:VEVENT",
    `UID:suggestion-${s.id}-${s.dedupe_key.slice(0, 16)}@task-manager`,
    `DTSTAMP:${utcStamp(now)}`,
    ...when,
    `SUMMARY:${escapeText(s.name)}`,
    `DESCRIPTION:${escapeText(description)}`,
    ...(url ? [`URL:${url}`] : []),
    "END:VEVENT",
  ];
}

export function buildIcs(suggestions, defaultTimeZone, now = Date.now()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Task Manager//Event suggestions//EN",
    "CALSCALE:GREGORIAN",
    ...suggestions.flatMap((s) => eventLines(s, defaultTimeZone, now)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
