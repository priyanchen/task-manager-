import { decrypt } from "./crypto.js";
import {
  addUsage,
  getToken,
  getUsage,
  getUser,
  insertSuggestion,
  isScanned,
  listScannableUsers,
  markScanned,
} from "./db.js";
import { looksLikeEvent } from "./extract.js";
import { isRateLimit } from "./google.js";

export const DEFAULT_DAILY_LIMIT = 200;
const SCAN_HOUR = 6;

export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

export function dueScanDays(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" })
    .formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  if (Number(get("hour")) !== SCAN_HOUR) return null;
  return get("weekday") === "Sun" ? 8 : 2;
}

export async function runScan({ pool, userId, mail, extract, days, today, dailyLimit = DEFAULT_DAILY_LIMIT }) {
  const ids = await mail.listIds(days);
  const result = { messages: ids.length, scanned: 0, found: 0, added: 0, failed: 0, rateLimited: false, limited: false };

  for (const id of ids) {
    if (await isScanned(pool, userId, id)) continue;

    try {
      const message = await mail.getMessage(id);
      result.scanned++;

      if (looksLikeEvent(message.subject, message.text)) {
        if ((await getUsage(pool, userId, today)) >= dailyLimit) {
          result.limited = true;
          result.scanned--;
          break;
        }
        await addUsage(pool, userId, today);
        const events = await extract({
          from: message.from,
          subject: message.subject,
          text: message.text,
          today,
        });
        result.found += events.length;
        for (const event of events) {
          if (await insertSuggestion(pool, userId, event)) result.added++;
        }
      }
      await markScanned(pool, userId, id);
    } catch (error) {
      if (String(error?.message).includes("invalid_grant")) throw error;
      if (isRateLimit(error)) {
        result.rateLimited = true;
        break;
      }
      result.failed++;
      console.error(`Scan failed for one message: ${error?.message}`);
    }
  }

  return result;
}

export function createScanner({ pool, services, dailyLimit = DEFAULT_DAILY_LIMIT, track = () => {} }) {
  const running = new Set();

  return async function scan(userId, days) {
    if (running.has(userId)) throw Object.assign(new Error("A scan is already running"), { status: 409 });
    running.add(userId);
    try {
      const token = await getToken(pool, userId);
      if (!token) throw Object.assign(new Error("Google is not connected"), { status: 409 });
      const user = await getUser(pool, userId);
      const result = await runScan({
        pool,
        userId,
        mail: services.makeMail(decrypt(token)),
        extract: services.extract,
        days,
        today: todayIn(user.time_zone),
        dailyLimit,
      });
      track(userId, "scan_completed", { days, ...result });
      return result;
    } finally {
      running.delete(userId);
    }
  };
}

export async function runScheduled({ pool, scanner, now = new Date() }) {
  for (const user of await listScannableUsers(pool)) {
    const days = dueScanDays(user.time_zone, now);
    if (!days) continue;
    try {
      await scanner(user.id, days);
    } catch (error) {
      console.error(`Scheduled scan skipped for user ${user.id}: ${error?.message}`);
    }
  }
}
