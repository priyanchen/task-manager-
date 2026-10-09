import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Keygrip from "keygrip";
import { newDb } from "pg-mem";
import { createApp } from "../server/app.js";
import { encrypt } from "../server/crypto.js";
import { initSchema, insertSuggestion, saveToken, upsertUser } from "../server/db.js";

process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

let server;
let base;
let busyEvents = [];
let pool;
let alice;
let bob;

function cookieFor(userId) {
  const value = Buffer.from(JSON.stringify({ userId })).toString("base64");
  return `session=${value}; session.sig=${new Keygrip(["test"]).sign(`session=${value}`)}`;
}

before(async () => {
  pool = new (newDb().adapters.createPg().Pool)();
  await initSchema(pool);
  alice = (await upsertUser(pool, { email: "alice@example.com" })).id;
  bob = (await upsertUser(pool, { email: "bob@example.com" })).id;
  await insertSuggestion(pool, alice, {
    name: "Alice only", organizer: "Acme", offer: "o", start_date: "2030-05-10", end_date: null,
    start_time: null, end_time: null, time_zone: null, url: null,
  });
  await saveToken(pool, alice, encrypt("refresh"));
  await insertSuggestion(pool, alice, {
    name: "Timed talk", organizer: "Acme", offer: "o", start_date: "2030-05-10", end_date: null,
    start_time: "17:00", end_time: "18:00", time_zone: "Asia/Jerusalem", url: null,
  });
  const app = createApp({
    pool,
    services: { makeCalendar: () => ({ listBusy: async () => busyEvents }) },
    scanner: async () => ({}),
    config: { sessionSecret: "test", secureCookies: false, googleConfigured: false, googleClientId: "", digestAvailable: true, allowedEmails: [] },
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
  assert.deepEqual(body, { configured: false, authenticated: false, email: null, connected: false, timeZone: "Asia/Jerusalem", timeZoneSet: true, digest: false, digestAvailable: true });
});

test("security headers are set", async () => {
  const res = await fetch(base + "/");
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a signed-in user sees only their own suggestions and cannot skip another user's", async () => {
  const range = "/api/suggestions?from=2030-01-01&to=2030-12-31";
  const mine = await (await fetch(base + range, { headers: { cookie: cookieFor(alice) } })).json();
  assert.deepEqual(mine.suggestions.map((s) => s.name).sort(), ["Alice only", "Timed talk"]);

  const theirs = await (await fetch(base + range, { headers: { cookie: cookieFor(bob) } })).json();
  assert.deepEqual(theirs.suggestions, []);

  await fetch(base + "/api/suggestions/skip", {
    method: "POST",
    headers: { cookie: cookieFor(bob), "X-Requested-With": "fetch", "Content-Type": "application/json" },
    body: JSON.stringify({ ids: mine.suggestions.map((s) => s.id) }),
  });
  const after = await (await fetch(base + range, { headers: { cookie: cookieFor(alice) } })).json();
  assert.equal(after.suggestions.length, 2);
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

test("/api/conflicts lists overlaps for the signed-in user only", async () => {
  busyEvents = [{ summary: "Dentist", start: { dateTime: "2030-05-10T17:30:00+03:00" }, end: { dateTime: "2030-05-10T18:30:00+03:00" } }];
  const range = "/api/suggestions?from=2030-01-01&to=2030-12-31";
  const suggestions = (await (await fetch(base + range, { headers: { cookie: cookieFor(alice) } })).json()).suggestions;
  const talk = suggestions.find((s) => s.name === "Timed talk");

  const conflicts = async (id) =>
    (await (await fetch(`${base}/api/conflicts?from=2030-01-01&to=2030-12-31`, { headers: { cookie: cookieFor(id) } })).json()).conflicts;
  assert.deepEqual(await conflicts(alice), { [talk.id]: { overlaps: ["Dentist"], duplicate: false } });
  assert.deepEqual(await conflicts(bob), {});
  assert.equal((await fetch(`${base}/api/conflicts?from=2030-01-01&to=2030-12-31`)).status, 401);
});

test("the daily digest setting is per user and must be a boolean", async () => {
  const put = (id, body) =>
    fetch(base + "/api/settings", {
      method: "PUT",
      headers: { cookie: cookieFor(id), "X-Requested-With": "fetch", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const me = async (id) => (await (await fetch(base + "/api/me", { headers: { cookie: cookieFor(id) } })).json());
  assert.equal((await put(alice, { digest: "yes" })).status, 400);
  assert.equal((await put(alice, { digest: true })).status, 200);
  assert.deepEqual([(await me(alice)).digest, (await me(bob)).digest, (await me(alice)).digestAvailable], [true, false, true]);
});

test("new users start without a confirmed time zone; saving one confirms it", async () => {
  const zone = async (id) => (await (await fetch(base + "/api/me", { headers: { cookie: cookieFor(id) } })).json()).timeZoneSet;
  const carol = (await upsertUser(pool, { email: "carol@example.com" })).id;
  assert.equal(await zone(carol), false);
  await fetch(base + "/api/settings", {
    method: "PUT",
    headers: { cookie: cookieFor(carol), "X-Requested-With": "fetch", "Content-Type": "application/json" },
    body: JSON.stringify({ timeZone: "America/New_York" }),
  });
  assert.equal(await zone(carol), true);
});

test("skip reports how many events it actually skipped", async () => {
  const range = "/api/suggestions?from=2030-01-01&to=2030-12-31";
  const [first] = (await (await fetch(base + range, { headers: { cookie: cookieFor(alice) } })).json()).suggestions;
  const skip = async () =>
    (
      await (
        await fetch(base + "/api/suggestions/skip", {
          method: "POST",
          headers: { cookie: cookieFor(alice), "X-Requested-With": "fetch", "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [first.id] }),
        })
      ).json()
    ).skipped;
  assert.equal(await skip(), 1);
  assert.equal(await skip(), 0);
});

test("a sign-in callback is rejected unless this browser started the sign-in", async () => {
  const oauth = {
    generateCodeVerifierAsync: async () => ({ codeVerifier: "v", codeChallenge: "c" }),
    generateAuthUrl: ({ state }) => `https://accounts.example/auth?state=${state}`,
    getToken: async () => {
      throw new Error("stop here");
    },
  };
  const app = createApp({
    pool,
    services: { oauthClient: () => oauth },
    scanner: async () => ({}),
    config: { sessionSecret: "test", secureCookies: false, googleConfigured: true, googleClientId: "", allowedEmails: [] },
  });
  const srv = app.listen(0);
  const url = `http://localhost:${srv.address().port}`;
  try {
    const start = await fetch(`${url}/auth/google`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");

    const attacker = await fetch(`${url}/auth/google/callback?state=${state}&code=x`);
    assert.equal(attacker.status, 400);

    const second = await fetch(`${url}/auth/google`, { redirect: "manual" });
    const state2 = new URL(second.headers.get("location")).searchParams.get("state");
    const cookie2 = second.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const owner = await fetch(`${url}/auth/google/callback?state=${state2}&code=x`, { headers: { cookie: cookie2 } });
    assert.equal(owner.status, 500);
  } finally {
    srv.close();
  }
});

test("/api/suggestions.ics returns the user's own events as a calendar file", async () => {
  const range = "/api/suggestions?from=2030-01-01&to=2030-12-31";
  const mine = (await (await fetch(base + range, { headers: { cookie: cookieFor(alice) } })).json()).suggestions;
  const ids = mine.map((s) => s.id).join(",");

  const res = await fetch(`${base}/api/suggestions.ics?ids=${ids}`, { headers: { cookie: cookieFor(alice) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/calendar/);
  assert.match(res.headers.get("content-disposition"), /attachment/);
  assert.match(await res.text(), /BEGIN:VEVENT/);

  assert.equal((await fetch(`${base}/api/suggestions.ics?ids=${ids}`, { headers: { cookie: cookieFor(bob) } })).status, 404);
  assert.equal((await fetch(`${base}/api/suggestions.ics?ids=${ids}`)).status, 401);
  assert.equal((await fetch(`${base}/api/suggestions.ics?ids=abc`, { headers: { cookie: cookieFor(alice) } })).status, 400);
});
