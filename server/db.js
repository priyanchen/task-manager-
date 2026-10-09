import { createHash } from "node:crypto";
import pg from "pg";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS google_auth (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS suggestions (
    id SERIAL PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
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
    calendar_event_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS scanned_messages (message_id TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
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

export async function saveAuth(pool, email, refreshTokenEnc) {
  await pool.query(
    `INSERT INTO google_auth (id, email, refresh_token_enc) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET email = $1, refresh_token_enc = $2`,
    [email, refreshTokenEnc],
  );
}

export async function getAuth(pool) {
  const { rows } = await pool.query("SELECT email, refresh_token_enc FROM google_auth WHERE id = 1");
  return rows[0] ?? null;
}

export async function deleteAuth(pool) {
  await pool.query("DELETE FROM google_auth WHERE id = 1");
}

export async function insertSuggestion(pool, event) {
  const key = dedupeKey(event);
  const existing = await pool.query("SELECT 1 FROM suggestions WHERE dedupe_key = $1", [key]);
  if (existing.rows.length > 0) return false;

  await pool.query(
    `INSERT INTO suggestions
       (dedupe_key, name, organizer, offer, start_date, end_date, start_time, end_time, time_zone, url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
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

export async function listSuggestions(pool, { from, to, status = "new" }) {
  const { rows } = await pool.query(
    `SELECT id, name, organizer, offer, start_date, end_date, start_time, end_time, time_zone, url, status
     FROM suggestions WHERE status = $1 AND start_date >= $2 AND start_date <= $3
     ORDER BY start_date, start_time, id`,
    [status, from, to],
  );
  return rows;
}

export async function getSuggestions(pool, ids) {
  const found = [];
  for (const id of ids) {
    const { rows } = await pool.query("SELECT * FROM suggestions WHERE id = $1", [id]);
    if (rows[0]) found.push(rows[0]);
  }
  return found;
}

export async function setStatus(pool, id, status, calendarEventId = null) {
  await pool.query("UPDATE suggestions SET status = $2, calendar_event_id = $3 WHERE id = $1", [
    id,
    status,
    calendarEventId,
  ]);
}

export async function isScanned(pool, messageId) {
  const { rows } = await pool.query("SELECT 1 FROM scanned_messages WHERE message_id = $1", [messageId]);
  return rows.length > 0;
}

export async function markScanned(pool, messageId) {
  await pool.query("INSERT INTO scanned_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING", [
    messageId,
  ]);
}

export async function getSetting(pool, key, fallback) {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value ?? fallback;
}

export async function setSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value],
  );
}
