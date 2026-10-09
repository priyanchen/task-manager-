# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Static task manager: `index.html`, `styles.css`, `script.js`. No build step, package manager, linter, or tests. Run it by opening `index.html` in a browser.

## Architecture

All logic lives in `script.js` as a single-state render loop:

- `tasks` (`{id, text, completed}[]`) is the only state. It is persisted to `localStorage` under `simple-task-manager-tasks`.
- Every mutation (`addTask`, `toggleTask`, `deleteTask`) calls `saveTasks()` then `renderTasks()`. `renderTasks()` rebuilds the whole `#task-list` from scratch, so new UI state must be derivable from `tasks` or it will be lost on re-render.
- `index.html` ships an empty `<ul id="task-list">`; all rows (including the "No tasks yet." empty state) are created in JS. Styling hooks are the `.task`, `.task.completed`, and `.empty` classes in `styles.css`.
- `loadTasks()` tolerates missing/corrupt storage by returning `[]`; `saveTasks()` has no such guard.

