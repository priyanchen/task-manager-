import { createHash } from "node:crypto";
import pg from "pg";

export const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    google_sub TEXT,
    time_zone TEXT NOT NULL DEFAULT '${DEFAULT_TIME_ZONE}'
  )`,
  `CREATE TABLE IF NOT EXISTS user_tokens (
    user_id INTEGER PRIMARY KEY,
    refresh_token_enc TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_suggestions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL,
    name TEXT NOT NULL,
    organizer TEXT NOT NULL,
    offer TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    start_time TEXT,
    end_time TEXT,
    time_zone TEXT,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    calendar_event_id TEXT,
    UNIQUE (user_id, dedupe_key)
  )`,
  `CREATE TABLE IF NOT EXISTS scanned_emails (
    user_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (user_id, message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS extraction_usage (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  )`,
];

export function createPool() {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

export async function initSchema(pool) {
  for (const statement of SCHEMA) {
    await pool.query(statement);
  }
}

const normalize = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function dedupeKey(event) {
  return createHash("sha256")
    .update(`${normalize(event.name)}|${event.start_date}|${normalize(event.organizer)}`)
    .digest("hex");
}

export async function upsertUser(pool, { email, sub }) {
  const found = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (found.rows[0]) {
    await pool.query("UPDATE users SET google_sub = $2 WHERE id = $1", [found.rows[0].id, sub ?? null]);
    return getUser(pool, found.rows[0].id);
  }
  const { rows } = await pool.query("INSERT INTO users (email, google_sub) VALUES ($1, $2) RETURNING id", [
    email.toLowerCase(),
    sub ?? null,
  ]);
  return getUser(pool, rows[0].id);
}

export async function getUser(pool, id) {
  const { rows } = await pool.query("SELECT id, email, time_zone FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function setTimeZone(pool, userId, timeZone) {
  await pool.query("UPDATE users SET time_zone = $2 WHERE id = $1", [userId, timeZone]);
}

export async function listScannableUsers(pool) {
  const { rows } = await pool.query(
    "SELECT u.id, u.email, u.time_zone FROM users u JOIN user_tokens t ON t.user_id = u.id ORDER BY u.id",
  );
  return rows;
}

export async function saveToken(pool, userId, refreshTokenEnc) {
  const found = await pool.query("SELECT 1 FROM user_tokens WHERE user_id = $1", [userId]);
  if (found.rows.length > 0) {
    await pool.query("UPDATE user_tokens SET refresh_token_enc = $2 WHERE user_id = $1", [userId, refreshTokenEnc]);
  } else {
    await pool.query("INSERT INTO user_tokens (user_id, refresh_token_enc) VALUES ($1, $2)", [userId, refreshTokenEnc]);
  }
}

export async function getToken(pool, userId) {
  const { rows } = await pool.query("SELECT refresh_token_enc FROM user_tokens WHERE user_id = $1", [userId]);
  return rows[0]?.refresh_token_enc ?? null;
}

export async function deleteToken(pool, userId) {
  await pool.query("DELETE FROM user_tokens WHERE user_id = $1", [userId]);
}

export async function insertSuggestion(pool, userId, event) {
  const key = dedupeKey(event);
  const existing = await pool.query("SELECT 1 FROM event_suggestions WHERE user_id = $1 AND dedupe_key = $2", [
    userId,
    key,
  ]);
  if (existing.rows.length > 0) return false;

  await pool.query(
    `INSERT INTO event_suggestions
       (user_id, dedupe_key, name, organizer, offer, start_date, end_date, start_time, end_time, time_zone, url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      userId,
      key,
      event.name,
      event.organizer,
      event.offer,
      event.start_date,
      event.end_date,
      event.start_time,
      event.end_time,
      event.time_zone,
      event.url,
    ],
  );
  return true;
}

export async function listSuggestions(pool, userId, { from, to, status = "new" }) {
  const { rows } = await pool.query(
    `SELECT id, name, organizer, offer, start_date, end_date, start_time, end_time, time_zone, url, status
     FROM event_suggestions
     WHERE user_id = $1 AND status = $2 AND start_date >= $3 AND start_date <= $4
     ORDER BY start_date, start_time, id`,
    [userId, status, from, to],
  );
  return rows;
}

export async function getSuggestions(pool, userId, ids) {
  const found = [];
  for (const id of ids) {
    const { rows } = await pool.query("SELECT * FROM event_suggestions WHERE id = $1 AND user_id = $2", [id, userId]);
    if (rows[0]) found.push(rows[0]);
  }
  return found;
}

export async function setStatus(pool, userId, id, status, calendarEventId = null) {
  await pool.query(
    "UPDATE event_suggestions SET status = $3, calendar_event_id = $4 WHERE id = $2 AND user_id = $1",
    [userId, id, status, calendarEventId],
  );
}

export async function isScanned(pool, userId, messageId) {
  const { rows } = await pool.query("SELECT 1 FROM scanned_emails WHERE user_id = $1 AND message_id = $2", [
    userId,
    messageId,
  ]);
  return rows.length > 0;
}

export async function markScanned(pool, userId, messageId) {
  const found = await isScanned(pool, userId, messageId);
  if (!found) await pool.query("INSERT INTO scanned_emails (user_id, message_id) VALUES ($1, $2)", [userId, messageId]);
}

export async function getUsage(pool, userId, day) {
  const { rows } = await pool.query("SELECT count FROM extraction_usage WHERE user_id = $1 AND day = $2", [userId, day]);
  return rows[0]?.count ?? 0;
}

export async function addUsage(pool, userId, day) {
  const used = await getUsage(pool, userId, day);
  if (used === 0) {
    await pool.query("INSERT INTO extraction_usage (user_id, day, count) VALUES ($1, $2, 1)", [userId, day]);
  } else {
    await pool.query("UPDATE extraction_usage SET count = count + 1 WHERE user_id = $1 AND day = $2", [userId, day]);
  }
}

// Carries the single-user tables from before multi-user support over to the first matching sign-in.
export async function adoptLegacy(pool, user) {
  let legacy;
  try {
    legacy = (await pool.query("SELECT email FROM google_auth WHERE id = 1")).rows[0];
  } catch {
    return false;
  }
  if (legacy?.email?.toLowerCase() !== user.email.toLowerCase()) return false;

  await pool.query(
    `INSERT INTO event_suggestions
       (user_id, dedupe_key, name, organizer, offer, start_date, end_date, start_time, end_time, time_zone, url, status, calendar_event_id)
     SELECT $1::integer, dedupe_key, name, organizer, offer, start_date, end_date, start_time, end_time, time_zone, url, status, calendar_event_id
     FROM suggestions`,
    [user.id],
  );
  await pool.query("INSERT INTO scanned_emails (user_id, message_id) SELECT $1::integer, message_id FROM scanned_messages", [
    user.id,
  ]);
  const tz = (await pool.query("SELECT value FROM settings WHERE key = 'timeZone'")).rows[0]?.value;
  if (tz) await setTimeZone(pool, user.id, tz);
  await pool.query("DELETE FROM google_auth WHERE id = 1");
  return true;
}
