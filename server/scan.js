import { decrypt } from "./crypto.js";
import { getAuth, getSetting, insertSuggestion, isScanned, markScanned } from "./db.js";
import { looksLikeEvent } from "./extract.js";
import { isRateLimit } from "./google.js";

export const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

export async function runScan({ pool, mail, extract, days, today }) {
  const ids = await mail.listIds(days);
  const result = { messages: ids.length, scanned: 0, found: 0, added: 0, failed: 0, rateLimited: false };

  for (const id of ids) {
    if (await isScanned(pool, id)) continue;

    try {
      const message = await mail.getMessage(id);
      result.scanned++;

      if (looksLikeEvent(message.subject, message.text)) {
        const events = await extract({
          from: message.from,
          subject: message.subject,
          text: message.text,
          today,
        });
        result.found += events.length;
        for (const event of events) {
          if (await insertSuggestion(pool, event)) result.added++;
        }
      }
      await markScanned(pool, id);
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

export function createScanner({ pool, services }) {
  let running = false;

  return async function scan(days) {
    if (running) throw Object.assign(new Error("A scan is already running"), { status: 409 });
    running = true;
    try {
      const auth = await getAuth(pool);
      if (!auth) throw Object.assign(new Error("Google is not connected"), { status: 409 });
      const timeZone = await getSetting(pool, "timeZone", DEFAULT_TIME_ZONE);
      return await runScan({
        pool,
        mail: services.makeMail(decrypt(auth.refresh_token_enc)),
        extract: services.extract,
        days,
        today: todayIn(timeZone),
      });
    } finally {
      running = false;
    }
  };
}
