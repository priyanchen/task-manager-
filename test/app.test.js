import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Keygrip from "keygrip";
import { newDb } from "pg-mem";
import { createApp } from "../server/app.js";
import { initSchema, insertSuggestion, upsertUser } from "../server/db.js";

let server;
let base;
let alice;
let bob;

function cookieFor(userId) {
  const value = Buffer.from(JSON.stringify({ userId })).toString("base64");
  return `session=${value}; session.sig=${new Keygrip(["test"]).sign(`session=${value}`)}`;
}

before(async () => {
  const pool = new (newDb().adapters.createPg().Pool)();
  await initSchema(pool);
  alice = (await upsertUser(pool, { email: "alice@example.com" })).id;
  bob = (await upsertUser(pool, { email: "bob@example.com" })).id;
  await insertSuggestion(pool, alice, {
    name: "Alice only", organizer: "Acme", offer: "o", start_date: "2030-05-10", end_date: null,
    start_time: null, end_time: null, time_zone: null, url: null,
  });
  const app = createApp({
    pool,
    services: {},
    scanner: async () => ({}),
    config: { sessionSecret: "test", secureCookies: false, googleConfigured: false, googleClientId: "", allowedEmails: [] },
  });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

test("serves the three frontend files and nothing else from the project", async () => {
  for (const url of ["/", "/script.js", "/styles.css"]) {
    assert.equal((await fetch(base + url)).status, 200);
  }
  for (const url of ["/package.json", "/server/index.js", "/.gitignore", "/.git/config", "/server/../package.json"]) {
    assert.equal((await fetch(base + url)).status, 404, url);
  }
});

test("API routes require sign-in", async () => {
  assert.equal((await fetch(`${base}/api/suggestions?from=2030-01-01&to=2030-12-31`)).status, 401);
  const post = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "X-Requested-With": "fetch", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(post.status, 401);
});

test("state-changing requests without the CSRF header are rejected", async () => {
  const res = await fetch(`${base}/api/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});

test("/api/me reports signed-out state without leaking data", async () => {
  const body = await (await fetch(`${base}/api/me`)).json();
  assert.deepEqual(body, { configured: false, authenticated: false, email: null, connected: false, timeZone: "Asia/Jerusalem", topics: [] });
});

test("security headers are set", async () => {
  const res = await fetch(base + "/");
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a signed-in user sees only their own suggestions and cannot skip another user's", async () => {
  const range = "/api/suggestions?from=2030-01-01&to=2030-12-31";
  const mine = await (await fetch(base + range, { headers: { cookie: cookieFor(alice) } })).json();
  assert.deepEqual(mine.suggestions.map((s) => s.name), ["Alice only"]);

  const theirs = await (await fetch(base + range, { headers: { cookie: cookieFor(bob) } })).json();
  assert.deepEqual(theirs.suggestions, []);

  await fetch(base + "/api/suggestions/skip", {
    method: "POST",
    headers: { cookie: cookieFor(bob), "X-Requested-With": "fetch", "Content-Type": "application/json" },
    body: JSON.stringify({ ids: mine.suggestions.map((s) => s.id) }),
  });
  const after = await (await fetch(base + range, { headers: { cookie: cookieFor(alice) } })).json();
  assert.equal(after.suggestions.length, 1);
});

test("topics are saved per user, cleaned, and validated", async () => {
  const put = (body) =>
    fetch(base + "/api/settings", {
      method: "PUT",
      headers: { cookie: cookieFor(alice), "X-Requested-With": "fetch", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await put({ topics: [" AI ", "ai", "Finance", ""] })).status, 200);
  const me = async (id) => (await (await fetch(base + "/api/me", { headers: { cookie: cookieFor(id) } })).json()).topics;
  assert.deepEqual(await me(alice), ["AI", "Finance"]);
  assert.deepEqual(await me(bob), []);
  assert.equal((await put({ topics: "AI" })).status, 400);
  assert.equal((await put({ topics: ["x".repeat(41)] })).status, 400);
  assert.equal((await put({ topics: [] })).status, 200);
  assert.deepEqual(await me(alice), []);
});

test("/api/me returns the signed-in user's own time zone", async () => {
  const put = await fetch(base + "/api/settings", {
    method: "PUT",
    headers: { cookie: cookieFor(bob), "X-Requested-With": "fetch", "Content-Type": "application/json" },
    body: JSON.stringify({ timeZone: "Europe/London" }),
  });
  assert.equal(put.status, 200);
  const zone = async (id) => (await (await fetch(base + "/api/me", { headers: { cookie: cookieFor(id) } })).json()).timeZone;
  assert.equal(await zone(bob), "Europe/London");
  assert.equal(await zone(alice), "Asia/Jerusalem");
});
