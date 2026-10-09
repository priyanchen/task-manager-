import assert from "node:assert/strict";
import { test } from "node:test";
import { newDb } from "pg-mem";
import { decrypt, encrypt } from "../server/crypto.js";
import { buildIcs, fold } from "../server/ics.js";
import { findConflicts } from "../server/conflicts.js";
import { createAnalytics } from "../server/analytics.js";
import {
  adoptLegacy,
  getSuggestions,
  getUsage,
  initSchema,
  insertSuggestion,
  listSuggestions,
  saveToken,
  setDigest,
  setStatus,
  upsertUser,
} from "../server/db.js";
import { validateEvent } from "../server/extract.js";
import { buildEvent, htmlToText } from "../server/google.js";
import { buildDigest, createSender } from "../server/digest.js";
import { dueScanDays, runScan, runScheduled } from "../server/scan.js";

process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

const event = (overrides = {}) => ({
  name: "AI Founders Webinar",
  organizer: "Acme",
  offer: "Learn to ship faster",
  start_date: "2030-05-10",
  end_date: null,
  start_time: "17:00",
  end_time: null,
  time_zone: null,
  url: "https://zoom.us/webinar/register/abc",
  ...overrides,
});

async function freshPool() {
  const pool = new (newDb().adapters.createPg().Pool)();
  await initSchema(pool);
  return pool;
}

const newUser = async (pool, email = "me@example.com") => (await upsertUser(pool, { email, sub: "sub" })).id;

test("tokens round-trip and are not stored in plaintext", () => {
  const encrypted = encrypt("refresh-token");
  assert.notEqual(encrypted, "refresh-token");
  assert.equal(decrypt(encrypted), "refresh-token");
});

test("validateEvent rejects past dates and URLs that are not in the email", () => {
  const ctx = { today: "2030-01-01", emailText: "Register: https://zoom.us/webinar/register/abc", fallbackOrganizer: "x" };
  assert.equal(validateEvent(event({ start_date: "2029-12-31" }), ctx), null);
  assert.equal(validateEvent(event({ url: "https://evil.example/x" }), ctx).url, null);
  assert.equal(validateEvent(event(), ctx).url, "https://zoom.us/webinar/register/abc");
  assert.equal(validateEvent(event({ url: "javascript:alert(1)" }), { ...ctx, emailText: "javascript:alert(1)" }).url, null);
});

test("skipping an event does not hide a later event from the same sender", async () => {
  const pool = await freshPool();
  const userId = await newUser(pool);
  assert.equal(await insertSuggestion(pool, userId, event()), true);
  const [first] = await listSuggestions(pool, userId, { from: "2030-01-01", to: "2030-12-31" });
  await setStatus(pool, userId, first.id, "skipped");

  assert.equal(await insertSuggestion(pool, userId, event()), false);
  assert.equal(await insertSuggestion(pool, userId, event({ name: "Another Acme Workshop" })), true);
  assert.equal(await insertSuggestion(pool, userId, event({ start_date: "2030-06-01" })), true);

  const visible = await listSuggestions(pool, userId, { from: "2030-01-01", to: "2030-12-31" });
  assert.deepEqual(visible.map((s) => s.name).sort(), ["AI Founders Webinar", "Another Acme Workshop"]);
});

test("runScan stores only extracted fields and never rescans a message", async () => {
  const pool = await freshPool();
  const userId = await newUser(pool);
  const messages = {
    m1: { id: "m1", from: "Acme <a@acme.test>", subject: "Webinar: register now", text: "Join us https://zoom.us/x" },
    m2: { id: "m2", from: "Shop", subject: "Your receipt", text: "Thanks for your order" },
  };
  let extractCalls = 0;
  const mail = { listIds: async () => ["m1", "m2"], getMessage: async (id) => messages[id] };
  const extract = async () => {
    extractCalls++;
    return [event()];
  };

  const first = await runScan({ pool, userId, mail, extract, days: 2, today: "2030-01-01" });
  assert.deepEqual(first, { messages: 2, scanned: 2, found: 1, added: 1, failed: 0, rateLimited: false, limited: false });

  const second = await runScan({ pool, userId, mail, extract, days: 2, today: "2030-01-01" });
  assert.equal(second.scanned, 0);
  assert.equal(extractCalls, 1);

  const { rows } = await pool.query("SELECT * FROM event_suggestions");
  assert.ok(!Object.keys(rows[0]).some((column) => /body|text|subject/.test(column)));
});

test("runScan stops on a rate limit and leaves unscanned messages for the next run", async () => {
  const pool = await freshPool();
  const userId = await newUser(pool);
  const messages = {
    m1: { id: "m1", from: "A", subject: "Webinar one", text: "register https://zoom.us/x" },
    m2: { id: "m2", from: "A", subject: "Webinar two", text: "register https://zoom.us/y" },
    m3: { id: "m3", from: "A", subject: "Webinar three", text: "register https://zoom.us/z" },
  };
  const mail = {
    listIds: async () => ["m1", "m2", "m3"],
    getMessage: async (id) => {
      if (id === "m2") throw Object.assign(new Error("Quota exceeded for quota metric 'Total Query Cost'"), { code: 429 });
      return messages[id];
    },
  };
  const first = await runScan({ pool, userId, mail, extract: async () => [], days: 2, today: "2030-01-01" });
  assert.equal(first.rateLimited, true);
  assert.equal(first.scanned, 1);
  assert.equal(first.failed, 0);

  const healthy = { ...mail, getMessage: async (id) => messages[id] };
  const second = await runScan({ pool, userId, mail: healthy, extract: async () => [], days: 2, today: "2030-01-01" });
  assert.equal(second.rateLimited, false);
  assert.equal(second.scanned, 2);
});

test("buildEvent makes timed and all-day Google Calendar events", () => {
  const timed = buildEvent(event({ start_time: "23:30" }), "Asia/Jerusalem");
  assert.equal(timed.start.timeZone, "Asia/Jerusalem");
  assert.equal(timed.end.dateTime, "2030-05-10T23:59:00");

  const allDay = buildEvent(event({ start_time: null, end_date: "2030-05-12" }), "Asia/Jerusalem");
  assert.deepEqual([allDay.start.date, allDay.end.date], ["2030-05-10", "2030-05-13"]);
});

test("htmlToText keeps link targets", () => {
  assert.match(htmlToText('<p>Go <a href="https://luma.com/e?a=1&amp;b=2">here</a></p>'), /here \(https:\/\/luma\.com\/e\?a=1&b=2\)/);
});

test("two users keep separate suggestions, even for the same event", async () => {
  const pool = await freshPool();
  const a = await newUser(pool, "a@example.com");
  const b = await newUser(pool, "b@example.com");
  assert.equal(await insertSuggestion(pool, a, event()), true);
  assert.equal(await insertSuggestion(pool, b, event()), true);

  const range = { from: "2030-01-01", to: "2030-12-31" };
  const [mine] = await listSuggestions(pool, a, range);
  assert.equal((await listSuggestions(pool, b, range)).length, 1);
  assert.deepEqual(await getSuggestions(pool, b, [mine.id]), []);

  await setStatus(pool, b, mine.id, "skipped");
  assert.equal((await listSuggestions(pool, a, range)).length, 1);
});

test("runScan stops at the daily limit and counts usage per user", async () => {
  const pool = await freshPool();
  const userId = await newUser(pool);
  const other = await newUser(pool, "other@example.com");
  const ids = ["m1", "m2", "m3"];
  const mail = {
    listIds: async () => ids,
    getMessage: async (id) => ({ id, from: "A", subject: `Webinar ${id}`, text: "register https://zoom.us/x" }),
  };
  const result = await runScan({ pool, userId, mail, extract: async () => [], days: 2, today: "2030-01-01", dailyLimit: 2 });
  assert.equal(result.limited, true);
  assert.equal(await getUsage(pool, userId, "2030-01-01"), 2);
  assert.equal(await getUsage(pool, other, "2030-01-01"), 0);

  const next = await runScan({ pool, userId, mail, extract: async () => [], days: 2, today: "2030-01-02", dailyLimit: 2 });
  assert.equal(next.scanned, 1);
  assert.equal(result.scanned, 2);
});

test("daily scans are due at 06:00 local time, weekly on Sundays", () => {
  const sundayUtc = new Date("2030-01-06T04:00:00Z");
  assert.equal(dueScanDays("Asia/Jerusalem", sundayUtc), 8);
  assert.equal(dueScanDays("Asia/Jerusalem", new Date("2030-01-07T04:00:00Z")), 2);
  assert.equal(dueScanDays("Asia/Jerusalem", new Date("2030-01-07T05:00:00Z")), null);
  assert.equal(dueScanDays("America/New_York", new Date("2030-01-07T11:00:00Z")), 2);
});

test("single-user data is adopted by the matching account only once", async () => {
  const pool = await freshPool();
  await pool.query("CREATE TABLE google_auth (id INTEGER PRIMARY KEY, email TEXT, refresh_token_enc TEXT)");
  await pool.query(`CREATE TABLE suggestions (id SERIAL PRIMARY KEY, dedupe_key TEXT, name TEXT, organizer TEXT, offer TEXT,
    start_date TEXT, end_date TEXT, start_time TEXT, end_time TEXT, time_zone TEXT, url TEXT, status TEXT, calendar_event_id TEXT)`);
  await pool.query("CREATE TABLE scanned_messages (message_id TEXT PRIMARY KEY)");
  await pool.query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  await pool.query("INSERT INTO google_auth VALUES (1, 'me@example.com', 'x')");
  await pool.query(`INSERT INTO suggestions (dedupe_key, name, organizer, offer, start_date, status)
    VALUES ('k', 'Old event', 'Acme', 'o', '2030-05-10', 'new')`);
  await pool.query("INSERT INTO scanned_messages VALUES ('m1')");
  await pool.query("INSERT INTO settings VALUES ('timeZone', 'Europe/London')");

  const stranger = await upsertUser(pool, { email: "stranger@example.com" });
  assert.equal(await adoptLegacy(pool, stranger), false);

  const me = await upsertUser(pool, { email: "Me@Example.com" });
  assert.equal(await adoptLegacy(pool, me), true);
  assert.equal((await listSuggestions(pool, me.id, { from: "2030-01-01", to: "2030-12-31" })).length, 1);
  assert.equal(await adoptLegacy(pool, me), false);
  assert.equal((await pool.query("SELECT time_zone FROM users WHERE id = $1", [me.id])).rows[0].time_zone, "Europe/London");
});

test("analytics sends counts under a hashed id and does nothing without a key", async () => {
  const sent = [];
  const send = async (url, init) => sent.push({ url, body: JSON.parse(init.body) });
  createAnalytics({ key: "", send })(1, "x");
  assert.equal(sent.length, 0);

  createAnalytics({ key: "phc_test", send })(7, "scan_completed", { found: 2 });
  assert.equal(sent[0].url, "https://us.i.posthog.com/capture/");
  assert.equal(sent[0].body.event, "scan_completed");
  assert.match(sent[0].body.distinct_id, /^[0-9a-f]{16}$/);
  assert.equal(sent[0].body.properties.found, 2);
});

test("findConflicts flags overlapping timed events and ignores the rest", () => {
  const at = (hhmm) => `2030-05-10T${hhmm}:00+03:00`;
  const busy = (summary, from, to, extra = {}) => ({ summary, start: { dateTime: at(from) }, end: { dateTime: at(to) }, ...extra });
  const calendar = [
    busy("Dentist", "16:30", "17:30"),
    busy("Lunch", "12:00", "13:00"),
    busy("Right before", "16:00", "17:00"),
    busy("Free slot", "17:30", "18:30", { transparency: "transparent" }),
    busy("Declined", "17:15", "18:00", { attendees: [{ self: true, responseStatus: "declined" }] }),
    busy("AI Founders Webinar", "17:00", "18:00"),
    { summary: "Holiday", start: { date: "2030-05-10" }, end: { date: "2030-05-11" } },
  ];
  const timed = { ...event(), start_time: "17:00", end_time: "18:00", time_zone: "Asia/Jerusalem" };
  assert.deepEqual(findConflicts(timed, calendar, "Asia/Jerusalem"), { overlaps: ["Dentist"], duplicate: true });
  assert.deepEqual(findConflicts({ ...timed, start_time: null, name: "Other" }, calendar, "Asia/Jerusalem"), { overlaps: [], duplicate: false });
  assert.deepEqual(findConflicts({ ...timed, time_zone: "America/New_York" }, calendar, "Asia/Jerusalem").overlaps, []);
  const allDay = { ...event({ name: "תרגול", start_time: null }) };
  const hebrew = [{ summary: "תרגול ", start: { date: "2030-05-10" }, end: { date: "2030-05-11" } }];
  assert.equal(findConflicts(allDay, hebrew, "Asia/Jerusalem").duplicate, true);
  assert.equal(findConflicts({ ...allDay, start_date: "2030-05-11" }, hebrew, "Asia/Jerusalem").duplicate, false);
});

test("buildDigest lists events by day in plain text and is empty when there are none", () => {
  assert.equal(buildDigest([], "https://app.test"), null);
  const message = buildDigest(
    [
      { name: "AI\nWebinar", organizer: "Acme", offer: "Ship faster", start_date: "2030-05-10", start_time: "17:00" },
      { name: "Retreat", organizer: "Calm Co", offer: "", start_date: "2030-05-11", start_time: null },
    ],
    "https://app.test",
  );
  assert.equal(message.subject, "2 events coming up this week");
  assert.match(message.text, /Fri, May 10\n- 17:00 · AI Webinar — Acme\n  Ship faster\nSat, May 11\n- All day · Retreat — Calm Co/);
  assert.match(message.text, /https:\/\/app\.test$/);
});

test("the digest is sent once a day, only to users who opted in, and only when there is something to say", async () => {
  const pool = await freshPool();
  const optedIn = await newUser(pool, "yes@example.com");
  const optedOut = await newUser(pool, "no@example.com");
  for (const id of [optedIn, optedOut]) {
    await saveToken(pool, id, "enc");
    await insertSuggestion(pool, id, event({ start_date: "2030-01-08" }));
  }
  await setDigest(pool, optedIn, true);

  const sent = [];
  const digest = { send: async (message) => sent.push(message), baseUrl: "https://app.test" };
  const scanner = async () => ({});
  const now = new Date("2030-01-07T04:00:00Z");

  await runScheduled({ pool, scanner, now, digest });
  assert.deepEqual(sent.map((m) => m.to), ["yes@example.com"]);

  await runScheduled({ pool, scanner, now, digest });
  assert.equal(sent.length, 1);

  await runScheduled({ pool, scanner, now: new Date("2030-01-07T05:00:00Z"), digest });
  assert.equal(sent.length, 1);
});

test("a failed digest send does not mark the day as sent", async () => {
  const pool = await freshPool();
  const id = await newUser(pool);
  await saveToken(pool, id, "enc");
  await insertSuggestion(pool, id, event({ start_date: "2030-01-08" }));
  await setDigest(pool, id, true);

  const now = new Date("2030-01-07T04:00:00Z");
  await runScheduled({ pool, scanner: async () => ({}), now, digest: { send: async () => { throw new Error("down"); }, baseUrl: "x" } });
  const sent = [];
  await runScheduled({ pool, scanner: async () => ({}), now, digest: { send: async (m) => sent.push(m), baseUrl: "x" } });
  assert.equal(sent.length, 1);
});

test("the email sender posts to the provider and is absent without a key", async () => {
  assert.equal(createSender({ key: "" }), null);
  let request;
  const sender = createSender({ key: "re_test", send: async (url, init) => ((request = { url, init }), { ok: true }) });
  await sender({ to: "me@example.com", subject: "S", text: "T" });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.init.headers.Authorization, "Bearer re_test");
  assert.deepEqual(JSON.parse(request.init.body).to, ["me@example.com"]);
  await assert.rejects(createSender({ key: "k", send: async () => ({ ok: false, status: 403 }) })({ to: "a", subject: "s", text: "t" }), /403/);
});

test("a multi-day event with a start time but no end time becomes an all-day span", () => {
  const built = buildEvent(event({ start_time: "09:00", end_time: null, end_date: "2030-05-12" }), "Asia/Jerusalem");
  assert.deepEqual([built.start.date, built.end.date], ["2030-05-10", "2030-05-13"]);
  const result = findConflicts(event({ start_time: "09:00", end_time: null, end_date: "2030-05-12" }), [], "Asia/Jerusalem");
  assert.deepEqual(result, { overlaps: [], duplicate: false });
});

test("buildIcs writes UTC times, all-day dates and escaped text", () => {
  const base = { id: 1, dedupe_key: "a".repeat(64), organizer: "Acme", offer: "Line1\nLine2", url: "https://zoom.us/x" };
  const timed = { ...base, name: "תרגול, Practice; x", start_date: "2030-05-10", end_date: null, start_time: "17:00", end_time: null, time_zone: "Asia/Jerusalem" };
  const allDay = { ...base, id: 2, name: "Retreat", start_date: "2030-05-10", end_date: "2030-05-12", start_time: null, end_time: null, time_zone: null };
  const ics = buildIcs([timed, allDay], "Asia/Jerusalem", 0);

  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20300510T140000Z\r\nDTEND:20300510T150000Z/);
  assert.match(ics, /DTSTART;VALUE=DATE:20300510\r\nDTEND;VALUE=DATE:20300513/);
  assert.ok(ics.includes("SUMMARY:תרגול\\, Practice\\; x"));
  assert.ok(ics.includes("DESCRIPTION:Line1\\nLine2\\nBy Acme\\nhttps://zoom.us/x"));
  assert.ok(!/[^\r]\n/.test(ics));
});

test("buildIcs cannot be used to inject extra calendar lines", () => {
  const evil = {
    id: 3, dedupe_key: "b".repeat(64), organizer: "Evil\r\nATTENDEE:mailto:x@y.z", offer: "hi\r\nEND:VEVENT",
    url: "https://a.example/x\r\nX-EVIL:1", name: "Name\r\nBEGIN:VALARM", start_date: "2030-05-10", end_date: null,
    start_time: null, end_time: null, time_zone: null,
  };
  const lines = buildIcs([evil], "Asia/Jerusalem", 0).split("\r\n");
  assert.equal(lines.filter((l) => l === "END:VEVENT").length, 1);
  assert.ok(!lines.some((l) => /^(ATTENDEE|X-EVIL|BEGIN:VALARM)/.test(l)));
});

test("fold keeps every line within 75 bytes without splitting characters", () => {
  const folded = fold("SUMMARY:" + "תרגול ".repeat(40));
  for (const line of folded.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), "SUMMARY:" + "תרגול ".repeat(40));
});

test("inbound helpers read addresses, provider field names and Gmail's confirmation code", async () => {
  const { forwardingCode, normalizeInbound, sameSecret, tokenFromAddress } = await import("../server/inbox.js");
  assert.equal(tokenFromAddress("Me <U0123456789ABCDEF@in.example.com>"), "u0123456789abcdef");
  assert.equal(tokenFromAddress("someone@example.com"), null);
  assert.equal(normalizeInbound({ To: "a@b.c", From: "x", Subject: "S", HtmlBody: "<p>Hello <a href=\"https://z.us/1\">here</a></p>" }).text, "Hello here (https://z.us/1)");
  assert.equal(forwardingCode("forwarding-noreply@google.com", "Confirmation code: 12345678"), "12345678");
  assert.equal(forwardingCode("attacker@evil.test", "Confirmation code: 12345678"), null);
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abd", "abc"), false);
  assert.equal(sameSecret("abc", ""), false);
});

test("the digest also reaches users who signed in without Google mail access", async () => {
  const pool = await freshPool();
  const id = await newUser(pool);
  await insertSuggestion(pool, id, event({ start_date: "2030-01-08" }));
  await setDigest(pool, id, true);

  const sent = [];
  let scans = 0;
  await runScheduled({
    pool,
    scanner: async () => scans++,
    now: new Date("2030-01-07T04:00:00Z"),
    digest: { send: async (m) => sent.push(m), baseUrl: "https://app.test" },
  });
  assert.equal(sent.length, 1);
  assert.equal(scans, 0);
});
