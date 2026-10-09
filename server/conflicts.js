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

const sameName = (event, suggestion) => event.summary?.trim().toLowerCase() === suggestion.name.trim().toLowerCase();

function isDuplicate(suggestion, calendarEvents) {
  return calendarEvents.some(
    (event) =>
      event.status !== "cancelled" &&
      sameName(event, suggestion) &&
      (event.start?.date ?? event.start?.dateTime?.slice(0, 10)) === suggestion.start_date,
  );
}

export function findConflicts(suggestion, calendarEvents, defaultTimeZone) {
  const duplicate = isDuplicate(suggestion, calendarEvents);
  if (!suggestion.start_time) return { overlaps: [], duplicate };
  const built = buildEvent(suggestion, defaultTimeZone);
  const start = wallTimeToMs(built.start.dateTime, built.start.timeZone);
  const end = wallTimeToMs(built.end.dateTime, built.end.timeZone);
  const overlaps = calendarEvents
    .filter(isBusy)
    .filter((event) => !sameName(event, suggestion))
    .filter((event) => Date.parse(event.start.dateTime) < end && start < Date.parse(event.end.dateTime))
    .map((event) => event.summary ?? "Busy");
  return { overlaps, duplicate };
}
