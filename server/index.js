import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { createApp } from "./app.js";
import { createPool, initSchema } from "./db.js";
import { createExtractor } from "./extract.js";
import { createCalendar, createMail, oauthClient } from "./google.js";
import { createScanner, DEFAULT_TIME_ZONE } from "./scan.js";

const env = process.env;
const port = Number(env.PORT ?? 3000);

if (!env.SESSION_SECRET || !env.DATABASE_URL) {
  console.error("SESSION_SECRET and DATABASE_URL are required");
  process.exit(1);
}

const config = {
  sessionSecret: env.SESSION_SECRET,
  secureCookies: env.NODE_ENV === "production",
  googleConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.BASE_URL && env.ALLOWED_EMAIL),
  googleClientId: env.GOOGLE_CLIENT_ID,
  allowedEmail: env.ALLOWED_EMAIL ?? "",
};

let extractor;
const services = {
  oauthClient,
  makeMail: createMail,
  makeCalendar: createCalendar,
  extract(input) {
    extractor ??= createExtractor({
      client: new Anthropic(
        env.ANTHROPIC_WORKSPACE_ID
          ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }
          : undefined,
      ),
      model: env.EXTRACTION_MODEL ?? "claude-haiku-5-5",
    });
    return extractor(input);
  },
};

const pool = createPool();
await initSchema(pool);

const scanner = createScanner({ pool, services });
const app = createApp({ pool, services, scanner, config });

if (env.SCAN_SCHEDULE !== "off") {
  const run = (days) => () =>
    scanner(days).catch((error) => console.error(`Scheduled scan skipped: ${error?.message}`));
  cron.schedule("0 6 * * *", run(2), { timezone: DEFAULT_TIME_ZONE });
  cron.schedule("0 6 * * 0", run(8), { timezone: DEFAULT_TIME_ZONE });
}

app.listen(port, () => console.log(`Listening on ${port}`));
