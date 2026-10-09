import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../server/app.js";
import { initSchema } from "../server/db.js";

let server;
let base;

before(async () => {
  const pool = new (newDb().adapters.createPg().Pool)();
  await initSchema(pool);
  const app = createApp({
    pool,
    services: {},
    scanner: async () => ({}),
    config: { sessionSecret: "test", secureCookies: false, googleConfigured: false, googleClientId: "", allowedEmail: "me@example.com" },
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
  assert.deepEqual(body, { configured: false, authenticated: false, email: null, connected: false, timeZone: "Asia/Jerusalem" });
});

test("security headers are set", async () => {
  const res = await fetch(base + "/");
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});
