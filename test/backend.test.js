import assert from "node:assert/strict";
import { test } from "node:test";
import { newDb } from "pg-mem";
import { decrypt, encrypt } from "../server/crypto.js";
import { initSchema, insertSuggestion, listSuggestions, setStatus } from "../server/db.js";
import { validateEvent } from "../server/extract.js";
import { buildEvent, htmlToText } from "../server/google.js";
import { runScan } from "../server/scan.js";

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
  assert.equal(await insertSuggestion(pool, event()), true);
  const [first] = await listSuggestions(pool, { from: "2030-01-01", to: "2030-12-31" });
  await setStatus(pool, first.id, "skipped");

  assert.equal(await insertSuggestion(pool, event()), false);
  assert.equal(await insertSuggestion(pool, event({ name: "Another Acme Workshop" })), true);
  assert.equal(await insertSuggestion(pool, event({ start_date: "2030-06-01" })), true);

  const visible = await listSuggestions(pool, { from: "2030-01-01", to: "2030-12-31" });
  assert.deepEqual(visible.map((s) => s.name).sort(), ["AI Founders Webinar", "Another Acme Workshop"]);
});

test("runScan stores only extracted fields and never rescans a message", async () => {
  const pool = await freshPool();
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

  const first = await runScan({ pool, mail, extract, days: 2, today: "2030-01-01" });
  assert.deepEqual(first, { messages: 2, scanned: 2, found: 1, added: 1, failed: 0 });

  const second = await runScan({ pool, mail, extract, days: 2, today: "2030-01-01" });
  assert.equal(second.scanned, 0);
  assert.equal(extractCalls, 1);

  const { rows } = await pool.query("SELECT * FROM suggestions");
  assert.ok(!Object.keys(rows[0]).some((column) => /body|text|subject/.test(column)));
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
