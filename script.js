const STORAGE_KEY = "simple-task-manager-tasks";

const form = document.getElementById("task-form");
const input = document.getElementById("task-input");
const list = document.getElementById("task-list");
const dateInput = document.getElementById("task-date");
const monthLabel = document.getElementById("month-label");
const grid = document.getElementById("calendar-grid");

const account = document.getElementById("account");
const signIn = document.getElementById("sign-in");
const accountEmail = document.getElementById("account-email");
const scanButton = document.getElementById("scan-now");
const timeZoneSelect = document.getElementById("time-zone");
const statusLine = document.getElementById("status");
const suggestionsPanel = document.getElementById("suggestions");
const suggestionsTitle = document.getElementById("suggestions-title");
const suggestionList = document.getElementById("suggestion-list");
const topicsInput = document.getElementById("topics");
const digestLabel = document.getElementById("digest-label");
const digestBox = document.getElementById("digest");
const otherDetails = document.getElementById("other-suggestions");
const otherSummary = document.getElementById("other-summary");
const otherList = document.getElementById("other-list");
const monthOverview = document.getElementById("month-overview");
const monthSummary = document.getElementById("month-summary");
const monthList = document.getElementById("month-list");
const monthOther = document.getElementById("month-other");
const monthOtherSummary = document.getElementById("month-other-summary");
const monthOtherList = document.getElementById("month-other-list");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let tasks = loadTasks();
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let selectedDate = null;
let me = null;
let suggestions = [];
let searchTerms = [];
let conflicts = {};

function loadTasks() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toDateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatDateKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function renderCalendar() {
  grid.replaceChildren();
  monthLabel.textContent = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  for (const name of WEEKDAYS) {
    const head = document.createElement("div");
    head.className = "weekday";
    head.textContent = name;
    grid.append(head);
  }

  const leadingBlanks = new Date(viewYear, viewMonth, 1).getDay();
  for (let i = 0; i < leadingBlanks; i++) {
    grid.append(document.createElement("div"));
  }

  const now = new Date();
  const todayKey = toDateKey(now.getFullYear(), now.getMonth(), now.getDate());
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const key = toDateKey(viewYear, viewMonth, day);
    const count = tasks.filter((task) => task.dueDate === key).length;

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "day";
    if (key === todayKey) cell.classList.add("today");
    if (key === selectedDate) cell.classList.add("selected");
    if (count > 0) cell.classList.add("has-tasks");
    if (suggestions.some((suggestion) => suggestion.start_date === key)) cell.classList.add("has-suggestions");
    cell.textContent = day;
    cell.setAttribute(
      "aria-label",
      `${formatDateKey(key)}, ${count} ${count === 1 ? "task" : "tasks"}`,
    );
    cell.setAttribute("aria-pressed", String(key === selectedDate));
    cell.addEventListener("click", () => selectDate(key));
    grid.append(cell);
  }
}

function selectDate(key) {
  selectedDate = selectedDate === key ? null : key;
  dateInput.value = selectedDate ?? "";
  render();
}

function shiftMonth(delta) {
  const shifted = new Date(viewYear, viewMonth + delta, 1);
  viewYear = shifted.getFullYear();
  viewMonth = shifted.getMonth();
  renderCalendar();
  loadSuggestions();
}

function render() {
  renderCalendar();
  renderSuggestions();
  renderTasks();
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { "X-Requested-With": "fetch", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && me) {
    me.authenticated = false;
    renderAccount();
    throw new Error("Google sign-in expired. Connect Google again.");
  }
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function renderAccount() {
  if (!me?.configured) {
    account.hidden = true;
    return;
  }

  account.hidden = false;
  signIn.hidden = me.authenticated && me.connected;
  accountEmail.textContent = me.authenticated ? me.email : "";
  scanButton.hidden = !(me.authenticated && me.connected);
  timeZoneSelect.hidden = !me.authenticated;
  topicsInput.hidden = !(me.authenticated && me.connected);
  digestLabel.hidden = !(me.authenticated && me.connected && me.digestAvailable);
  digestBox.checked = me.digest;

  if (me.authenticated && timeZoneSelect.options.length === 0) {
    const zones = Intl.supportedValuesOf("timeZone");
    for (const zone of zones.includes(me.timeZone) ? zones : [me.timeZone, ...zones]) {
      timeZoneSelect.append(new Option(zone, zone));
    }
  }
  timeZoneSelect.value = me.timeZone;
  renderSuggestions();
}

async function loadSuggestions() {
  if (!me?.authenticated || !me.connected) {
    suggestions = [];
    return;
  }

  const last = new Date(viewYear, viewMonth + 1, 0).getDate();
  const from = toDateKey(viewYear, viewMonth, 1);
  const to = toDateKey(viewYear, viewMonth, last);
  try {
    suggestions = (await api(`/api/suggestions?from=${from}&to=${to}`)).suggestions;
  } catch (error) {
    statusLine.textContent = error.message;
    suggestions = [];
  }
  renderCalendar();
  renderSuggestions();
  await loadConflicts(from, to);
}

async function loadConflicts(from, to) {
  try {
    conflicts = (await api(`/api/conflicts?from=${from}&to=${to}`)).conflicts;
  } catch {
    conflicts = {};
  }
  renderSuggestions();
}

function describeWhen(suggestion) {
  const zone = suggestion.time_zone ?? me.timeZone;
  const days = suggestion.end_date ? `${formatDateKey(suggestion.start_date)} to ${formatDateKey(suggestion.end_date)}` : "";
  const time = suggestion.start_time
    ? `${suggestion.start_time}${suggestion.end_time ? `–${suggestion.end_time}` : ""} (${zone})`
    : "All day";
  return [days, time].filter(Boolean).join(", ");
}

function matchesTopics(suggestion) {
  const text = `${suggestion.name} ${suggestion.organizer} ${suggestion.offer}`.toLowerCase();
  return searchTerms.some((topic) => text.includes(topic.toLowerCase()));
}

function fillMonthGroups(target, items) {
  const byDate = new Map();
  for (const suggestion of items) {
    byDate.set(suggestion.start_date, [...(byDate.get(suggestion.start_date) ?? []), suggestion]);
  }

  for (const [date, group] of byDate) {
    const entry = document.createElement("li");
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "secondary month-date";
    heading.textContent = formatDateKey(date);
    heading.addEventListener("click", () => {
      if (selectedDate !== date) selectDate(date);
      suggestionsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    const rows = document.createElement("ul");
    for (const suggestion of group) {
      const row = document.createElement("li");
      row.textContent = `${suggestion.start_time ?? "All day"} · ${suggestion.name} — ${suggestion.organizer}`;
      rows.append(row);
    }
    entry.append(heading, rows);
    target.append(entry);
  }
}

function renderMonthOverview() {
  monthList.replaceChildren();
  monthOtherList.replaceChildren();
  monthOther.hidden = true;
  monthOverview.hidden = !(me?.authenticated && me.connected && suggestions.length > 0);
  if (monthOverview.hidden) return;

  const searching = searchTerms.length > 0;
  const matches = searching ? suggestions.filter(matchesTopics) : suggestions;
  const others = searching ? suggestions.filter((suggestion) => !matchesTopics(suggestion)) : [];

  monthSummary.textContent = searching
    ? `Matches in ${monthLabel.textContent} (${matches.length})`
    : `All events in ${monthLabel.textContent} (${suggestions.length})`;

  if (matches.length === 0) {
    const none = document.createElement("li");
    none.className = "empty";
    none.textContent = "No events match your search this month.";
    monthList.append(none);
  }
  fillMonthGroups(monthList, matches);

  if (others.length > 0) {
    monthOther.hidden = false;
    monthOtherSummary.textContent = `Other (${others.length})`;
    fillMonthGroups(monthOtherList, others);
  }
}

function renderSuggestions() {
  renderMonthOverview();
  const ticked = new Set(checkedIds());
  suggestionList.replaceChildren();
  otherList.replaceChildren();
  otherDetails.hidden = true;
  suggestionsPanel.hidden = !(me?.authenticated && me.connected && selectedDate);
  if (suggestionsPanel.hidden) return;

  suggestionsTitle.textContent = `Suggested events on ${formatDateKey(selectedDate)}`;
  const forDate = suggestions.filter((suggestion) => suggestion.start_date === selectedDate);

  if (forDate.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No suggested events on this date.";
    suggestionList.append(empty);
  }

  const ranked = searchTerms.length > 0;
  const matching = ranked ? forDate.filter(matchesTopics) : forDate;
  const other = ranked ? forDate.filter((suggestion) => !matchesTopics(suggestion)) : [];

  if (ranked && forDate.length > 0 && matching.length === 0) {
    suggestionList.querySelector(".empty")?.remove();
    const none = document.createElement("li");
    none.className = "empty";
    none.textContent = "No events match your search on this date.";
    suggestionList.append(none);
  }
  if (other.length > 0) {
    otherDetails.hidden = false;
    otherSummary.textContent = `Other (${other.length})`;
  }

  for (const suggestion of forDate) {
    const target = matching.includes(suggestion) ? suggestionList : otherList;
    const item = document.createElement("li");
    item.className = "suggestion";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.id = suggestion.id;
    checkbox.checked = ticked.has(suggestion.id);
    checkbox.setAttribute("aria-label", `Select "${suggestion.name}"`);

    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = suggestion.name;
    const by = document.createElement("div");
    by.className = "due";
    by.textContent = `By ${suggestion.organizer} · ${describeWhen(suggestion)}`;
    body.append(title, by);

    const clashes = conflicts[suggestion.id];
    if (clashes?.duplicate) {
      const note = document.createElement("div");
      note.className = "conflict";
      note.textContent = "Already on your calendar";
      body.append(note);
    }
    if (clashes?.overlaps.length > 0) {
      const note = document.createElement("div");
      note.className = "conflict";
      note.textContent = `Overlaps with: ${clashes.overlaps.join(", ")}`;
      body.append(note);
    }

    if (suggestion.offer) {
      const offer = document.createElement("div");
      offer.textContent = suggestion.offer;
      body.append(offer);
    }
    if (suggestion.url) {
      const link = document.createElement("a");
      link.href = suggestion.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Registration link";
      body.append(link);
    }

    item.append(checkbox, body);
    target.append(item);
  }

  document.getElementById("suggestion-actions").hidden = forDate.length === 0;
}

function checkedIds() {
  return [...suggestionsPanel.querySelectorAll("input[data-id]:checked")].map((box) => Number(box.dataset.id));
}

async function changeSelected(action) {
  const ids = checkedIds();
  if (ids.length === 0) {
    statusLine.textContent = "Tick at least one event first.";
    return;
  }

  const stopProgress = showProgress(action === "add" ? "Adding to Google Calendar…" : "Skipping…");
  try {
    const result = await api(`/api/suggestions/${action}`, { method: "POST", body: { ids } });
    stopProgress();
    if (action === "add") {
      const done = result.results.filter((r) => r.status === "added");
      const already = done.filter((r) => r.alreadyOnCalendar).length;
      const failed = result.results.filter((r) => r.status === "error").length;
      statusLine.textContent =
        `Added ${done.length - already} to Google Calendar` +
        `${already ? `, ${already} already on your calendar (not duplicated)` : ""}` +
        `${failed ? `, ${failed} failed` : ""}.`;
    } else {
      statusLine.textContent = `Skipped ${ids.length}.`;
    }
  } catch (error) {
    stopProgress();
    statusLine.textContent = error.message;
  }
  await loadSuggestions();
}

function showProgress(message) {
  const started = Date.now();
  const tick = () => {
    statusLine.textContent = `${message} ${Math.floor((Date.now() - started) / 1000)}s`;
  };
  statusLine.classList.add("busy");
  tick();
  const timer = setInterval(tick, 1000);
  return () => {
    clearInterval(timer);
    statusLine.classList.remove("busy");
  };
}

async function scanEmails() {
  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";
  const stopProgress = showProgress("Searching your emails for events… this can take a few minutes.");
  try {
    const result = await api("/api/scan", { method: "POST", body: { days: 7 } });
    stopProgress();
    const note = result.rateLimited ? " Rate limit reached; click Scan emails again in a minute to continue." : "";
    const limit = result.limited ? " Daily scan limit reached; the rest will wait until you scan again tomorrow." : "";
    const failed = result.failed ? ` ${result.failed} emails failed and will be retried.` : "";
    statusLine.textContent = `Done. Scanned ${result.scanned} new emails, found ${result.found} events, ${result.added} new.${failed}${note}${limit}`;
  } catch (error) {
    stopProgress();
    statusLine.textContent = error.message;
  }
  scanButton.disabled = false;
  scanButton.textContent = "Scan emails";
  await loadSuggestions();
}

async function loadAccount() {
  try {
    me = await api("/api/me");
  } catch {
    me = null;
  }
  renderAccount();
  await loadSuggestions();
}

function renderTasks() {
  list.replaceChildren();

  const visible = selectedDate ? tasks.filter((task) => task.dueDate === selectedDate) : tasks;

  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = selectedDate ? "No tasks on this date." : "No tasks yet.";
    list.append(empty);
    return;
  }

  for (const task of visible) {
    const item = document.createElement("li");
    item.className = task.completed ? "task completed" : "task";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.completed;
    checkbox.setAttribute("aria-label", `Mark "${task.text}" completed`);
    checkbox.addEventListener("change", () => toggleTask(task.id));

    const label = document.createElement("span");
    label.textContent = task.text;

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => deleteTask(task.id));

    item.append(checkbox, label);
    if (task.dueDate) {
      const due = document.createElement("small");
      due.className = "due";
      due.textContent = formatDateKey(task.dueDate);
      item.append(due);
    }
    item.append(deleteButton);
    list.append(item);
  }
}

function addTask(text, dueDate) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  tasks.push({
    id: createId(),
    text: trimmed,
    completed: false,
    dueDate: dueDate || null,
  });
  saveTasks();
  render();
}

function toggleTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) {
    return;
  }

  task.completed = !task.completed;
  saveTasks();
  render();
}

function deleteTask(id) {
  tasks = tasks.filter((item) => item.id !== id);
  saveTasks();
  render();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  addTask(input.value, dateInput.value);
  input.value = "";
  dateInput.value = selectedDate ?? "";
  input.focus();
});

document.getElementById("prev-month").addEventListener("click", () => shiftMonth(-1));
document.getElementById("next-month").addEventListener("click", () => shiftMonth(1));
document.getElementById("add-selected").addEventListener("click", () => changeSelected("add"));
document.getElementById("skip-selected").addEventListener("click", () => changeSelected("skip"));
scanButton.addEventListener("click", scanEmails);
topicsInput.addEventListener("input", () => {
  searchTerms = topicsInput.value.split(",").map((term) => term.trim()).filter(Boolean);
  renderSuggestions();
});
digestBox.addEventListener("change", async () => {
  try {
    await api("/api/settings", { method: "PUT", body: { digest: digestBox.checked } });
    me.digest = digestBox.checked;
    statusLine.textContent = me.digest
      ? "Daily digest on. You'll get an email at 06:00 your time when events are coming up."
      : "Daily digest off.";
  } catch (error) {
    statusLine.textContent = error.message;
    digestBox.checked = me.digest;
  }
});
timeZoneSelect.addEventListener("change", async () => {
  try {
    await api("/api/settings", { method: "PUT", body: { timeZone: timeZoneSelect.value } });
    me.timeZone = timeZoneSelect.value;
    statusLine.textContent = `Time zone set to ${me.timeZone}.`;
    renderSuggestions();
  } catch (error) {
    statusLine.textContent = error.message;
    timeZoneSelect.value = me.timeZone;
  }
});

render();
loadAccount();
