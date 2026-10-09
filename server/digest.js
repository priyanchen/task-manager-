import { listSuggestions } from "./db.js";
import { shiftDay } from "./google.js";

const oneLine = (text) => text.replace(/\s+/g, " ").trim();

function dayLabel(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function buildDigest(suggestions, baseUrl) {
  if (suggestions.length === 0) return null;

  const lines = [`${suggestions.length} suggested events in the next 7 days:`, ""];
  let current = null;
  for (const s of suggestions) {
    if (s.start_date !== current) {
      current = s.start_date;
      lines.push(dayLabel(current));
    }
    lines.push(`- ${s.start_time ?? "All day"} · ${oneLine(s.name)} — ${oneLine(s.organizer)}`);
    if (s.offer) lines.push(`  ${oneLine(s.offer)}`);
  }
  lines.push("", `Open the app to add or skip them: ${baseUrl}`);

  return {
    subject: `${suggestions.length} event${suggestions.length === 1 ? "" : "s"} coming up this week`,
    text: lines.join("\n"),
  };
}

export async function upcomingDigest(pool, userId, today, baseUrl) {
  const suggestions = await listSuggestions(pool, userId, { from: today, to: shiftDay(today, 6) });
  return buildDigest(suggestions, baseUrl);
}

export function createSender({ key, from = "Task Manager <onboarding@resend.dev>", send = fetch }) {
  if (!key) return null;

  return async function sendEmail({ to, subject, text }) {
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  };
}
