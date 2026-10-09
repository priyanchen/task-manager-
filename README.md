# Simple Task Manager

A small browser-based task list built with plain HTML, CSS, and JavaScript. No framework, build step, or dependencies.

## Run locally

Open `index.html` directly in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

Then visit http://localhost:8000/.

## Features

- Add tasks; empty or whitespace-only input is ignored.
- Mark tasks as completed or uncompleted.
- Delete tasks.
- Tasks persist across page reloads using the browser's `localStorage`.
- Empty-state message when there are no tasks.

## Files

- `index.html` — page structure
- `styles.css` — styling
- `script.js` — task state, rendering, and storage
