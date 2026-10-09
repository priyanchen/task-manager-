import { buildEvent } from "./google.js";

function offsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(utcMs)
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}

function wallTimeToMs(dateTime, timeZone) {
  const [date, time] = dateTime.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  return wall - offsetMs(wall - offsetMs(wall, timeZone), timeZone);
}

function isBusy(event) {
  if (!event.start?.dateTime || event.status === "cancelled" || event.transparency === "transparent") return false;
  return !event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === "declined");
}

export function findConflicts(suggestion, calendarEvents, defaultTimeZone) {
  if (!suggestion.start_time) return [];
  const built = buildEvent(suggestion, defaultTimeZone);
  const start = wallTimeToMs(built.start.dateTime, built.start.timeZone);
  const end = wallTimeToMs(built.end.dateTime, built.end.timeZone);
  const name = suggestion.name.trim().toLowerCase();

  return calendarEvents
    .filter(isBusy)
    .filter((event) => event.summary?.trim().toLowerCase() !== name)
    .filter((event) => Date.parse(event.start.dateTime) < end && start < Date.parse(event.end.dateTime))
    .map((event) => event.summary ?? "Busy");
}
