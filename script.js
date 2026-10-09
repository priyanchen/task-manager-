const STORAGE_KEY = "simple-task-manager-tasks";

const form = document.getElementById("task-form");
const input = document.getElementById("task-input");
const list = document.getElementById("task-list");
const dateInput = document.getElementById("task-date");
const monthLabel = document.getElementById("month-label");
const grid = document.getElementById("calendar-grid");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let tasks = loadTasks();
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let selectedDate = null;

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
}

function render() {
  renderCalendar();
  renderTasks();
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

render();
