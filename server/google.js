import { google } from "googleapis";

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

const MAX_MESSAGES_PER_SCAN = 200;
const MAX_TEXT_CHARS = 8000;

export function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`,
  );
}

function authorizedClient(refreshToken) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label} (${href}) `)
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function collectParts(part, out) {
  const data = part.body?.data;
  if (data && part.mimeType === "text/plain") out.plain.push(Buffer.from(data, "base64url").toString("utf8"));
  if (data && part.mimeType === "text/html") out.html.push(Buffer.from(data, "base64url").toString("utf8"));
  for (const child of part.parts ?? []) collectParts(child, out);
}

export function isRateLimit(error) {
  return (
    error?.code === 429 ||
    error?.status === 429 ||
    /quota exceeded|rate.?limit/i.test(String(error?.message))
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN_GAP_MS = 250;
const RETRY_WAITS_MS = [5000, 15000, 30000];

export function createMail(refreshToken) {
  const gmail = google.gmail({ version: "v1", auth: authorizedClient(refreshToken) });
  let lastCall = 0;

  // New Google projects get only 6,000 quota units per minute per user, so pace calls and back off on 429.
  async function paced(call) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try {
        return await call();
      } catch (error) {
        if (!isRateLimit(error) || attempt >= RETRY_WAITS_MS.length) throw error;
        await sleep(RETRY_WAITS_MS[attempt]);
      }
    }
  }

  return {
    async listIds(days) {
      const ids = [];
      let pageToken;
      do {
        const { data } = await paced(() =>
          gmail.users.messages.list({
            userId: "me",
            q: `newer_than:${days}d -in:sent -in:spam -in:trash`,
            maxResults: 100,
            pageToken,
          }),
        );
        ids.push(...(data.messages ?? []).map((message) => message.id));
        pageToken = data.nextPageToken;
      } while (pageToken && ids.length < MAX_MESSAGES_PER_SCAN);
      return ids.slice(0, MAX_MESSAGES_PER_SCAN);
    },

    async getMessage(id) {
      const { data } = await paced(() => gmail.users.messages.get({ userId: "me", id, format: "full" }));
      const header = (name) =>
        data.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
      const parts = { plain: [], html: [] };
      collectParts(data.payload ?? {}, parts);

      let text = parts.plain.join("\n");
      if (!/https?:\/\//.test(text) && parts.html.length > 0) text = htmlToText(parts.html.join("\n"));

      return { id, from: header("from"), subject: header("subject"), text: text.slice(0, MAX_TEXT_CHARS) };
    },
  };
}

const pad = (n) => String(n).padStart(2, "0");

function shiftDay(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const nextDay = (date) => shiftDay(date, 1);

function plusHour(time) {
  const [h, m] = time.split(":").map(Number);
  return h >= 23 ? "23:59" : `${pad(h + 1)}:${pad(m)}`;
}

export function buildEvent(s, defaultTimeZone) {
  const base = {
    summary: s.name,
    description: [s.offer, `By ${s.organizer}`, s.url].filter(Boolean).join("\n"),
    ...(s.url ? { source: { title: "Registration", url: s.url } } : {}),
  };

  if (!s.start_time) {
    return { ...base, start: { date: s.start_date }, end: { date: nextDay(s.end_date ?? s.start_date) } };
  }

  const timeZone = s.time_zone ?? defaultTimeZone;
  const endDate = s.end_date ?? s.start_date;
  const endsBeforeStart = endDate === s.start_date && s.end_time && s.end_time <= s.start_time;
  const endTime = s.end_time && !endsBeforeStart ? s.end_time : plusHour(s.start_time);

  return {
    ...base,
    start: { dateTime: `${s.start_date}T${s.start_time}:00`, timeZone },
    end: { dateTime: `${endDate}T${endTime}:00`, timeZone },
  };
}

export function createCalendar(refreshToken) {
  const calendar = google.calendar({ version: "v3", auth: authorizedClient(refreshToken) });

  return {
    async findExisting(s) {
      const { data } = await calendar.events.list({
        calendarId: "primary",
        timeMin: `${shiftDay(s.start_date, -1)}T00:00:00Z`,
        timeMax: `${shiftDay(s.end_date ?? s.start_date, 2)}T00:00:00Z`,
        q: s.name,
        singleEvents: true,
        maxResults: 20,
      });
      const match = (data.items ?? []).find(
        (item) => item.summary?.trim().toLowerCase() === s.name.trim().toLowerCase(),
      );
      return match?.id ?? null;
    },

    async insert(event) {
      const { data } = await calendar.events.insert({ calendarId: "primary", requestBody: event });
      return data.id;
    },
  };
}
