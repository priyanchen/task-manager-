import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieSession from "cookie-session";
import express from "express";
import { decrypt, encrypt } from "./crypto.js";
import {
  adoptLegacy,
  DEFAULT_TIME_ZONE,
  deleteToken,
  getSuggestions,
  getToken,
  getUser,
  listSuggestions,
  saveToken,
  setStatus,
  setTimeZone,
  upsertUser,
} from "./db.js";
import { buildEvent, SCOPES } from "./google.js";

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

export function createApp({ pool, services, scanner, config, track = () => {} }) {
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
    req.session?.userId ? next() : res.status(401).json({ error: "Sign in required" });

  async function refreshTokenFor(userId) {
    const token = await getToken(pool, userId);
    if (!token) throw Object.assign(new Error("Google is not connected"), { status: 409 });
    return decrypt(token);
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

    const allowed = config.allowedEmails.length === 0 || config.allowedEmails.includes(profile.email.toLowerCase());
    if (!profile.email_verified || !allowed) {
      return res.status(403).send("This Google account is not allowed");
    }

    const granted = String(tokens.scope ?? "");
    if (!SCOPES.every((scope) => granted.includes(scope))) {
      return res.status(400).send("Gmail and Calendar access are both required. Sign in again and allow both.");
    }

    const user = await upsertUser(pool, { email: profile.email, sub: profile.sub });
    if (tokens.refresh_token) {
      await saveToken(pool, user.id, encrypt(tokens.refresh_token));
    } else if (!(await getToken(pool, user.id))) {
      return res.status(400).send("Google did not return a refresh token. Revoke access and sign in again.");
    }
    await adoptLegacy(pool, user);

    req.session.userId = user.id;
    track(user.id, "signed_in");
    res.redirect("/");
  });

  app.post("/auth/logout", (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  app.post("/auth/disconnect", requireAuth, async (req, res) => {
    const token = await getToken(pool, req.session.userId);
    if (token) {
      try {
        await services.oauthClient().revokeToken(decrypt(token));
      } catch (error) {
        console.error(`Token revoke failed: ${error?.message}`);
      }
      await deleteToken(pool, req.session.userId);
    }
    req.session = null;
    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    const user = req.session?.userId ? await getUser(pool, req.session.userId) : null;
    res.json({
      configured: config.googleConfigured,
      authenticated: Boolean(user),
      email: user?.email ?? null,
      connected: user ? Boolean(await getToken(pool, user.id)) : false,
      timeZone: user?.time_zone ?? DEFAULT_TIME_ZONE,
    });
  });

  app.put("/api/settings", requireAuth, async (req, res) => {
    if (!validTimeZone(req.body?.timeZone)) return res.status(400).json({ error: "Invalid time zone" });
    await setTimeZone(pool, req.session.userId, req.body.timeZone);
    res.json({ timeZone: req.body.timeZone });
  });

  app.get("/api/suggestions", requireAuth, async (req, res) => {
    const { from, to } = req.query;
    if (!DATE.test(from) || !DATE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    res.json({ suggestions: await listSuggestions(pool, req.session.userId, { from, to }) });
  });

  app.post("/api/suggestions/skip", requireAuth, async (req, res) => {
    const ids = parseIds(req.body?.ids);
    if (!ids) return res.status(400).json({ error: "ids must be a list of suggestion ids" });
    let skipped = 0;
    for (const s of await getSuggestions(pool, req.session.userId, ids)) {
      if (s.status !== "new") continue;
      await setStatus(pool, req.session.userId, s.id, "skipped");
      skipped++;
    }
    track(req.session.userId, "suggestions_skipped", { count: skipped });
    res.json({ ok: true });
  });

  app.post("/api/suggestions/add", requireAuth, async (req, res) => {
    const ids = parseIds(req.body?.ids);
    if (!ids) return res.status(400).json({ error: "ids must be a list of suggestion ids" });

    const userId = req.session.userId;
    const calendar = services.makeCalendar(await refreshTokenFor(userId));
    const { time_zone: timeZone } = await getUser(pool, userId);
    const results = [];

    for (const s of await getSuggestions(pool, userId, ids)) {
      if (s.status !== "new") {
        results.push({ id: s.id, status: s.status });
        continue;
      }
      try {
        const existing = await calendar.findExisting(s);
        const eventId = existing ?? (await calendar.insert(buildEvent(s, timeZone)));
        await setStatus(pool, userId, s.id, "added", eventId);
        results.push({ id: s.id, status: "added", alreadyOnCalendar: Boolean(existing) });
      } catch (error) {
        if (isReauth(error)) throw error;
        console.error(`Calendar add failed: ${error?.message}`);
        results.push({ id: s.id, status: "error" });
      }
    }
    track(userId, "suggestions_added", { count: results.filter((r) => r.status === "added").length });
    res.json({ results });
  });

  app.post("/api/scan", requireAuth, async (req, res) => {
    const days = req.body?.days === 7 ? 8 : 2;
    res.json(await scanner(req.session.userId, days));
  });

  app.use((error, req, res, next) => {
    if (isReauth(error)) return res.status(401).json({ error: "reauth" });
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(`Request failed: ${error?.message}`);
    res.status(500).json({ error: "Server error" });
  });

  return app;
}
