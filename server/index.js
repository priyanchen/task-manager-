import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { createAnalytics } from "./analytics.js";
import { createApp } from "./app.js";
import { createPool, initSchema } from "./db.js";
import { createSender } from "./digest.js";
import { createExtractor } from "./extract.js";
import { createCalendar, createMail, oauthClient } from "./google.js";
import { createScanner, DEFAULT_DAILY_LIMIT, runScheduled } from "./scan.js";

const env = process.env;
const port = Number(env.PORT ?? 3000);

if (!env.SESSION_SECRET || !env.DATABASE_URL) {
  console.error("SESSION_SECRET and DATABASE_URL are required");
  process.exit(1);
}

const config = {
  sessionSecret: env.SESSION_SECRET,
  secureCookies: env.NODE_ENV === "production",
  googleConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.BASE_URL),
  googleClientId: env.GOOGLE_CLIENT_ID,
  digestAvailable: Boolean(env.RESEND_API_KEY),
  inboxDomain: env.INBOX_DOMAIN ?? "",
  inboundSecret: env.INBOUND_SECRET ?? "",
  dailyLimit: Number(env.DAILY_EXTRACTION_LIMIT ?? DEFAULT_DAILY_LIMIT),
  allowedEmails: (env.ALLOWED_EMAIL ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
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

const track = createAnalytics({ key: env.POSTHOG_KEY, host: env.POSTHOG_HOST });
const scanner = createScanner({
  pool,
  services,
  track,
  dailyLimit: Number(env.DAILY_EXTRACTION_LIMIT ?? DEFAULT_DAILY_LIMIT),
});
const app = createApp({ pool, services, scanner, config, track });

const digest = { send: createSender({ key: env.RESEND_API_KEY, from: env.DIGEST_FROM }), baseUrl: env.BASE_URL, track };

if (env.SCAN_SCHEDULE !== "off") {
  cron.schedule("0 * * * *", () =>
    runScheduled({ pool, scanner, digest }).catch((error) => console.error(`Scheduled scans failed: ${error?.message}`)),
  );
}

app.listen(port, () => console.log(`Listening on ${port}`));
