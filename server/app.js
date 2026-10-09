import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieSession from "cookie-session";
import express from "express";
import { decrypt, encrypt } from "./crypto.js";
import {
  deleteAuth,
  getAuth,
  getSetting,
  getSuggestions,
  listSuggestions,
  saveAuth,
  setSetting,
  setStatus,
} from "./db.js";
import { buildEvent, SCOPES } from "./google.js";
import { DEFAULT_TIME_ZONE } from "./scan.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGIN_TTL_MS = 10 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isReauth = (error) => String(error?.message).includes("invalid_grant");

function parseIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  return value.every((id) => Number.isInteger(id) && id > 0) ? value : null;
}

function validTimeZone(value) {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function createApp({ pool, services, scanner, config }) {
  const app = express();
  const pendingLogins = new Map();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));
  app.use(
    cookieSession({
      name: "session",
      keys: [config.sessionSecret],
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    }),
  );

  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.get("X-Requested-With") !== "fetch") {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  });

  for (const file of ["index.html", "styles.css", "script.js"]) {
    app.get(file === "index.html" ? "/" : `/${file}`, (req, res) => res.sendFile(path.join(root, file)));
  }

  const requireAuth = (req, res, next) =>
    req.session?.email ? next() : res.status(401).json({ error: "Sign in required" });

  async function connectedServices() {
    const auth = await getAuth(pool);
    if (!auth) throw Object.assign(new Error("Google is not connected"), { status: 409 });
    return decrypt(auth.refresh_token_enc);
  }

  app.get("/auth/google", async (req, res) => {
    if (!config.googleConfigured) return res.status(503).send("Google sign-in is not configured");
    const oauth = services.oauthClient();
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const state = randomBytes(16).toString("hex");
    for (const [key, login] of pendingLogins) if (login.expires < Date.now()) pendingLogins.delete(key);
    pendingLogins.set(state, { codeVerifier, expires: Date.now() + LOGIN_TTL_MS });

    res.redirect(
      oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
    );
  });

  app.get("/auth/google/callback", async (req, res) => {
    const login = pendingLogins.get(req.query.state);
    pendingLogins.delete(req.query.state);
    if (!login || login.expires < Date.now() || typeof req.query.code !== "string") {
      return res.status(400).send("Invalid or expired sign-in attempt");
    }

    const oauth = services.oauthClient();
    const { tokens } = await oauth.getToken({ code: req.query.code, codeVerifier: login.codeVerifier });
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
    const profile = ticket.getPayload();

    if (!profile.email_verified || profile.email.toLowerCase() !== config.allowedEmail.toLowerCase()) {
      return res.status(403).send("This Google account is not allowed");
    }

    const granted = String(tokens.scope ?? "");
    if (!SCOPES.every((scope) => granted.includes(scope))) {
      return res.status(400).send("Gmail and Calendar access are both required. Sign in again and allow both.");
    }

    if (tokens.refresh_token) {
      await saveAuth(pool, profile.email, encrypt(tokens.refresh_token));
    } else if (!(await getAuth(pool))) {
      return res.status(400).send("Google did not return a refresh token. Revoke access and sign in again.");
    }

    req.session.email = profile.email;
    res.redirect("/");
  });

  app.post("/auth/logout", (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  app.post("/auth/disconnect", requireAuth, async (req, res) => {
    const auth = await getAuth(pool);
    if (auth) {
      try {
        await services.oauthClient().revokeToken(decrypt(auth.refresh_token_enc));
      } catch (error) {
        console.error(`Token revoke failed: ${error?.message}`);
      }
      await deleteAuth(pool);
    }
    req.session = null;
    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    const authenticated = Boolean(req.session?.email);
    res.json({
      configured: config.googleConfigured,
      authenticated,
      email: authenticated ? req.session.email : null,
      connected: authenticated ? Boolean(await getAuth(pool)) : false,
      timeZone: authenticated ? await getSetting(pool, "timeZone", DEFAULT_TIME_ZONE) : DEFAULT_TIME_ZONE,
    });
  });

  app.put("/api/settings", requireAuth, async (req, res) => {
    if (!validTimeZone(req.body?.timeZone)) return res.status(400).json({ error: "Invalid time zone" });
    await setSetting(pool, "timeZone", req.body.timeZone);
    res.json({ timeZone: req.body.timeZone });
  });

  app.get("/api/suggestions", requireAuth, async (req, res) => {
    const { from, to } = req.query;
    if (!DATE.test(from) || !DATE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    res.json({ suggestions: await listSuggestions(pool, { from, to }) });
  });

  app.post("/api/suggestions/skip", requireAuth, async (req, res) => {
    const ids = parseIds(req.body?.ids);
    if (!ids) return res.status(400).json({ error: "ids must be a list of suggestion ids" });
    for (const s of await getSuggestions(pool, ids)) {
      if (s.status === "new") await setStatus(pool, s.id, "skipped");
    }
    res.json({ ok: true });
  });

  app.post("/api/suggestions/add", requireAuth, async (req, res) => {
    const ids = parseIds(req.body?.ids);
    if (!ids) return res.status(400).json({ error: "ids must be a list of suggestion ids" });

    const calendar = services.makeCalendar(await connectedServices());
    const timeZone = await getSetting(pool, "timeZone", DEFAULT_TIME_ZONE);
    const results = [];

    for (const s of await getSuggestions(pool, ids)) {
      if (s.status !== "new") {
        results.push({ id: s.id, status: s.status });
        continue;
      }
      try {
        const existing = await calendar.findExisting(s);
        const eventId = existing ?? (await calendar.insert(buildEvent(s, timeZone)));
        await setStatus(pool, s.id, "added", eventId);
        results.push({ id: s.id, status: "added", alreadyOnCalendar: Boolean(existing) });
      } catch (error) {
        if (isReauth(error)) throw error;
        console.error(`Calendar add failed: ${error?.message}`);
        results.push({ id: s.id, status: "error" });
      }
    }
    res.json({ results });
  });

  app.post("/api/scan", requireAuth, async (req, res) => {
    const days = req.body?.days === 7 ? 8 : 2;
    res.json(await scanner(days));
  });

  app.use((error, req, res, next) => {
    if (isReauth(error)) return res.status(401).json({ error: "reauth" });
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(`Request failed: ${error?.message}`);
    res.status(500).json({ error: "Server error" });
  });

  return app;
}
