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
| `ALLOWED_EMAIL` | The only Google account allowed to sign in |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client (below) |
| `ANTHROPIC_API_KEY` | Used to read event details out of email text |
| `EXTRACTION_MODEL` | Optional, default `claude-haiku-5-5` |
| `NODE_ENV` | `production` on Railway (secure cookies) |
| `SCAN_SCHEDULE` | `off` disables the daily and weekly scans |

### Google setup

1. In Google Cloud Console create a project and enable the Gmail API and the Google Calendar API.
2. Configure the OAuth consent screen as External, add your own account as a test user, and add the scopes `gmail.readonly` and `calendar.events`.
3. Create an OAuth client of type Web application with the redirect URI `<BASE_URL>/auth/google/callback`.
4. Put the client ID and secret in the environment variables above.

While the consent screen is in testing mode, Google may expire the login after about 7 days; sign in again from the app.

## Privacy and security

- Gmail access is read-only. Calendar events are created only when you tick an event and press Add.
- Email text is sent to the Claude API to find events. Only the extracted fields are stored (name, organizer, one-line offer, dates and times, link). Email bodies are never stored, and each email is read once.
- The Google refresh token is encrypted at rest and never reaches the browser. Sign-in uses the authorization code flow with PKCE and is limited to `ALLOWED_EMAIL`.
- A link is accepted only if it appears in the email it came from.
- "Disconnect Google" revokes the token and deletes it.
