# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Task manager frontend (`index.html`, `styles.css`, `script.js`) that works standalone in a browser, plus an optional Node/Express backend in `server/` (Gmail scan, Claude event extraction, Google Calendar writes). `npm test` runs `test/*.test.js` (node:test, in-memory Postgres via pg-mem, no network). No linter or build step.

The Express app serves only `index.html`, `styles.css`, and `script.js` by explicit route. Do not add a static-directory mount of the project root; it would expose `server/`, `package.json`, and `.git`.

Backend rules that are easy to break: non-GET requests need the `X-Requested-With: fetch` header; suggestions are deduped per event (name + date + organizer), never per sender; only extracted fields are stored, never email bodies; a URL is kept only if it appears in the source email text.

## Architecture

All frontend logic lives in `script.js` as a render loop:

- `tasks` (`{id, text, completed, dueDate}[]`) is persisted to `localStorage` under `simple-task-manager-tasks`. Calendar view state (`viewYear`, `viewMonth`, `selectedDate`) and backend state (`me`, `suggestions`) are in-memory only.
- Every mutation calls `saveTasks()` then `render()`, which re-renders the calendar, the suggestions panel, and the task list from scratch, so new UI state must be derivable from that state or it will be lost on re-render.
- `/api/*` calls go through `api()`; when the backend is absent (static hosting), `loadAccount()` fails quietly and the Google UI stays hidden.
- `index.html` ships an empty `<ul id="task-list">`; all rows (including the "No tasks yet." empty state) are created in JS. Styling hooks are the `.task`, `.task.completed`, and `.empty` classes in `styles.css`.
- `loadTasks()` tolerates missing/corrupt storage by returning `[]`; `saveTasks()` has no such guard.

