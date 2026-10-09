# Simple Task Manager

A browser task list with a calendar, plus an optional backend that scans your Gmail for event announcements and lets you add the ones you choose to Google Calendar.

## Features

- Tasks with optional due dates, saved in the browser (`localStorage`).
- Month calendar: days with tasks get a dot; click a day to filter tasks to it.
- With the backend connected: daily and weekly Gmail scans (06:00 Jerusalem time, plus a "Scan emails" button) find upcoming events. Click a date to see its suggested events (name, organizer, one-line offer, dates, registration link), tick the ones you want and add them to Google Calendar, or skip them.
- Skipping hides only that event. Later events from the same sender are still suggested.
- Time zone setting, default Asia/Jerusalem.

## Run the frontend only

Open `index.html`, or `python3 -m http.server 8000`. The Google features stay hidden without the backend.

## Run the backend

```sh
npm install
npm test
npm start
```

Environment variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `TOKEN_ENC_KEY` | `openssl rand -base64 32`; encrypts the stored Google token |
| `BASE_URL` | Public URL of this app, no trailing slash |
| `ALLOWED_EMAIL` | Optional, comma-separated. When set, only these Google accounts may sign in; when empty, any account that Google lets through can |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client (below) |
| `ANTHROPIC_API_KEY` | Used to read event details out of email text |
| `ANTHROPIC_WORKSPACE_ID` | Only if the API key is not tied to a workspace (the API then asks for an `anthropic-workspace-id` header) |
| `EXTRACTION_MODEL` | Optional, default `claude-haiku-5-5` |
| `NODE_ENV` | `production` on Railway (secure cookies) |
| `SCAN_SCHEDULE` | `off` disables the daily and weekly scans |
| `DAILY_EXTRACTION_LIMIT` | Optional, default 200. Most emails each user can have read by Claude per day |
| `RESEND_API_KEY`, `DIGEST_FROM` | Optional. Enables the daily email digest through Resend. `DIGEST_FROM` defaults to Resend's test sender `Task Manager <onboarding@resend.dev>`, which can only deliver to the Resend account owner's own address; verify a domain in Resend to send to anyone |
| `INBOX_DOMAIN`, `INBOUND_SECRET` | Optional, for forwarding. `INBOX_DOMAIN` is the domain that receives forwarded mail (each user gets `u<16 hex>@INBOX_DOMAIN`). `INBOUND_SECRET` protects `POST /inbound/email`, which an email provider calls as JSON with `{to, from, subject, text}` (Postmark field names also work) and an `Authorization: Bearer <secret>` header. Without a secret the webhook stays off |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Optional PostHog project key (and host, default `https://us.i.posthog.com`). Sends counts only (scan results, adds, skips) under a hashed user id; never emails or addresses |

### Google setup

1. In Google Cloud Console create a project and enable the Gmail API and the Google Calendar API.
2. Configure the OAuth consent screen as External, add your own account as a test user, and add the scopes `gmail.readonly` and `calendar.events`.
3. Create an OAuth client of type Web application with the redirect URI `<BASE_URL>/auth/google/callback`.
4. Put the client ID and secret in the environment variables above.

Scans run hourly-checked: each user's daily scan (last 2 days) happens at 06:00 in their own time zone, and the weekly scan (last 8 days) on Sundays.

While the consent screen is in testing mode, Google may expire the login after about 7 days; sign in again from the app.

### Cloudflare (optional, free)

Add your domain to Cloudflare, point a proxied CNAME at the Railway domain, and set SSL/TLS mode to Full (strict). Update `BASE_URL` and the Google redirect URI to the new domain.

### Tests in CI

`.github/workflows/test.yml` runs `npm test` on pushes and pull requests to `dev` and `main`.

## Privacy and security

- Gmail access is read-only. Calendar events are created only when you tick an event and press Add.
- Suggested events that overlap something already on your calendar show "Overlaps with: ...". Your calendar is read for this when you open a month, and the titles are shown to you but never stored.
- Email text is sent to the Claude API to find events. Only the extracted fields are stored (name, organizer, one-line offer, dates and times, link). Email bodies are never stored, and each email is read once.
- The Google refresh token is encrypted at rest and never reaches the browser. Sign-in uses the authorization code flow with PKCE and can be limited to `ALLOWED_EMAIL`.
- The optional daily digest is plain text, sent only to the signed-in user's own address, at 06:00 in their time zone, and only on days with suggested events in the next 7 days. It is off until the user ticks "Email me a daily digest".
- "Download .ics" turns ticked events into a standard calendar file for Apple Calendar, Outlook or any other calendar app. Text is escaped so email content cannot add lines to the file, and the events stay in your list until you add or skip them.
- Forwarding preview: each user has a private forwarding address, and a box where an event email can be pasted to try the same reading step. Forwarded and pasted emails go through the same extraction as scanned ones; only the extracted fields are stored, and each email is read once. Gmail's forwarding confirmation code is picked up and shown to the user.
- Two ways to sign in: "Sign in with Google" asks only for your identity (no Gmail or Calendar access, no token stored), and works with forwarded or pasted emails and .ics downloads; "Connect Gmail & Calendar" adds inbox scanning and one-click Google Calendar adds. "Delete my account" removes every row stored for you and revokes the Google token if there is one.
- Every user's suggestions, scan history and token are stored under their own user id, and every query filters on it.
- A link is accepted only if it appears in the email it came from.
- "Disconnect Google" revokes the token and deletes it.
