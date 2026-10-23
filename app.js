const STORAGE_KEY = "ritmo-prototype-v1";
const today = localDateKey(new Date());

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function offsetDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (error) {
    console.warn("Não foi possível ler os dados locais.", error);
  }
  return {
    tasks: [
      { id: makeId(), title: "Alongar por 10 minutos", date: today, time: "08:30", note: "", done: true },
      { id: makeId(), title: "Ler 20 páginas", date: today, time: "19:00", note: "Um pouco por dia já conta.", done: false },
      { id: makeId(), title: "Preparar o dia de amanhã", date: today, time: "21:00", note: "", done: false }
    ],
    goals: [
      { id: makeId(), title: "Beber água", target: 8, unit: "copos", progress: { [today]: 5 } },
      { id: makeId(), title: "Ler", target: 20, unit: "páginas", progress: { [today]: 12 } }
    ],
    habits: [
      { id: makeId(), title: "Parar de fumar", startDate: offsetDate(-20), resets: [] },
      { id: makeId(), title: "Cuidar de mim", startDate: offsetDate(-8), resets: [] }
    ]
  };
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

let state = loadState();
let toastTimer;

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function formatDate(dateKey, options = { weekday: "short", day: "numeric", month: "short" }) {
  const parts = dateKey.split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return new Intl.DateTimeFormat("pt-BR", options).format(date);
}

function daysBetween(fromKey, toKey) {
  const from = new Date(fromKey + "T12:00:00");
  const to = new Date(toKey + "T12:00:00");
  return Math.max(0, Math.floor((to - from) / 86400000));
}

function activeStart(habit) {
  const latestReset = (habit.resets || []).filter((date) => date <= today).sort().at(-1);
  return latestReset && latestReset > habit.startDate ? latestReset : habit.startDate;
}

function habitDays(habit) {
  return daysBetween(activeStart(habit), today);
}

function currentProgress(goal) {
  return Number((goal.progress || {})[today] || 0);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function emptyState(title, message) {
  return '<div class="empty-state"><strong>' + escapeHtml(title) + '</strong>' + escapeHtml(message) + "</div>";
}

function taskMarkup(task) {
  const dateLabel = task.date === today ? "Hoje" : formatDate(task.date, { day: "numeric", month: "short" });
  const meta = dateLabel + (task.note ? " · " + escapeHtml(task.note) : "");
  return '<div class="task-row ' + (task.done ? "completed" : "") + '">' +
    '<button class="check-button ' + (task.done ? "done" : "") + '" data-action="toggle-task" data-id="' + task.id + '" aria-label="' + (task.done ? "Marcar como pendente" : "Concluir tarefa") + '">' + (task.done ? "✓" : "") + "</button>" +
    '<div class="task-info"><div class="task-title">' + escapeHtml(task.title) + '</div><div class="task-meta">' + meta + "</div></div>" +
    (task.time ? '<time class="task-time">' + escapeHtml(task.time) + "</time>" : "") +
    '<button class="delete-button" data-action="delete-task" data-id="' + task.id + '" aria-label="Excluir tarefa">×</button></div>';
}

function goalMarkup(goal, featured = false) {
  const progress = currentProgress(goal);
  const percent = goal.target > 0 ? Math.min(100, Math.round((progress / goal.target) * 100)) : 0;
  const remaining = Math.max(0, goal.target - progress);
  const areaClass = featured ? "goal-feature" : "goal-card";
  return '<article class="' + areaClass + '">' +
    (featured ? "" : '<div class="goal-card-top"><div class="goal-card-icon">◎</div><div><div class="goal-card-title">' + escapeHtml(goal.title) + '</div><div class="goal-card-sub">Meta diária · ' + goal.target + " " + escapeHtml(goal.unit) + '</div></div><span class="card-spacer"></span><button class="delete-button" data-action="delete-goal" data-id="' + goal.id + '" aria-label="Excluir meta">×</button></div>') +
    (featured ? '<div class="goal-feature-title">' + escapeHtml(goal.title) + '</div><div class="goal-feature-sub">Sua meta é ' + goal.target + " " + escapeHtml(goal.unit) + " por dia.</div>" : "") +
    '<div class="goal-number-row"><span class="goal-number">' + progress + '</span><span class="goal-target">/ ' + goal.target + " " + escapeHtml(goal.unit) + "</span></div>" +
    '<div class="goal-progress"><span style="width:' + percent + '%"></span></div>' +
    '<div class="' + (featured ? "goal-actions" : "goal-card-footer") + '"><span class="small-muted">' + (remaining > 0 ? "Faltam " + remaining + " " + escapeHtml(goal.unit) : "Meta concluída hoje ✦") + '</span><span class="goal-action-buttons"><button class="step-button" data-action="decrement-goal" data-id="' + goal.id + '" aria-label="Diminuir progresso">−</button><button class="step-button" data-action="increment-goal" data-id="' + goal.id + '" aria-label="Adicionar progresso">+</button></span></div>' +
    "</article>";
}

function habitMarkup(habit) {
  const days = habitDays(habit);
  const nextMilestone = (Math.floor(days / 5) + 1) * 5;
  const previousMilestone = Math.floor(days / 5) * 5;
  const progress = Math.min(100, Math.max(0, ((days - previousMilestone) / 5) * 100));
  const start = activeStart(habit);
  const latestReset = (habit.resets || []).filter((date) => date <= today).sort().at(-1);
  const subtitle = latestReset && latestReset === start && latestReset !== habit.startDate
    ? "Recomeçou em " + formatDate(start)
    : "Começou em " + formatDate(habit.startDate);
  return '<article class="habit-card"><div class="habit-card-top"><div class="habit-card-icon">✳</div><div><div class="habit-card-title">' + escapeHtml(habit.title) + '</div><div class="habit-card-sub">' + subtitle + '</div></div><span class="card-spacer"></span><button class="delete-button" data-action="delete-habit" data-id="' + habit.id + '" aria-label="Excluir hábito">×</button></div>' +
    '<div class="habit-days-row"><div class="habit-days">' + days + '<span>' + (days === 1 ? "dia" : "dias") + '</span></div><span class="milestone-tag">' + (days % 5 === 0 && days > 0 ? "Marco de " + days + " dias ✦" : "Próximo marco: " + nextMilestone + " dias") + '</span></div>' +
    '<div class="milestone-track"><span style="width:' + progress + '%"></span></div><div class="habit-card-footer"><span>Reinicia a contagem, mantendo o histórico.</span><button class="reset-button" data-action="reset-habit" data-id="' + habit.id + '">↻ Reiniciar</button></div></article>';
}

function render() {
  const tasksToday = state.tasks.filter((task) => task.date === today).sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
  const doneCount = tasksToday.filter((task) => task.done).length;
  const progressPercent = tasksToday.length ? Math.round(doneCount / tasksToday.length * 100) : 0;
  document.getElementById("day-progress").innerHTML = progressPercent + '<span>%</span>';
  document.getElementById("day-progress-bar").style.width = progressPercent + "%";
  document.getElementById("day-progress-foot").textContent = tasksToday.length ? (progressPercent === 100 ? "Tudo concluído. Muito bem!" : "Um passo de cada vez.") : "Adicione uma tarefa para começar.";
  document.getElementById("tasks-done").innerHTML = doneCount + '<span class="value-small"> / ' + tasksToday.length + "</span>";
  document.getElementById("task-nav-count").textContent = state.tasks.filter((task) => !task.done).length;

  const featuredGoal = state.goals[0];
  document.getElementById("goal-highlight").textContent = featuredGoal ? featuredGoal.title : "—";
  document.getElementById("goal-highlight-foot").textContent = featuredGoal ? currentProgress(featuredGoal) + " de " + featuredGoal.target + " " + featuredGoal.unit + " hoje." : "Adicione sua primeira meta.";
  document.getElementById("featured-goal").innerHTML = featuredGoal ? goalMarkup(featuredGoal, true) : emptyState("Sua primeira meta começa aqui", "Crie uma meta diária para acompanhar seu progresso.");
  document.getElementById("today-task-list").innerHTML = tasksToday.length ? tasksToday.map(taskMarkup).join("") : emptyState("Dia livre por enquanto", "Adicione uma tarefa quando quiser planejar algo.");
  document.getElementById("all-task-list").innerHTML = renderAllTasks();
  document.getElementById("goal-list").innerHTML = state.goals.length ? state.goals.map((goal) => goalMarkup(goal)).join("") : emptyState("Nenhuma meta ainda", "Crie uma meta diária para acompanhar seu progresso.");
  document.getElementById("habit-list").innerHTML = state.habits.length ? state.habits.map(habitMarkup).join("") : emptyState("Nenhum hábito ainda", "Adicione um hábito para começar a acompanhar sua jornada.");

  const mainHabit = state.habits[0];
  document.getElementById("highlight-habit-title").textContent = mainHabit ? mainHabit.title : "Hábitos em construção";
  document.getElementById("highlight-habit-days").textContent = mainHabit ? habitDays(mainHabit) : "—";
  document.getElementById("highlight-habit-description").textContent = mainHabit
    ? "Seu próximo marco de 5 dias está a caminho. Continue no seu ritmo."
    : "A consistência não precisa ser perfeita. Só precisa continuar.";
}

function renderAllTasks() {
  const filter = document.getElementById("task-filter").value;
  let tasks = [...state.tasks];
  if (filter === "today") tasks = tasks.filter((task) => task.date === today);
  if (filter === "upcoming") tasks = tasks.filter((task) => task.date > today && !task.done);
  if (filter === "done") tasks = tasks.filter((task) => task.done);
  tasks.sort((a, b) => (a.date + (a.time || "99:99")).localeCompare(b.date + (b.time || "99:99")));
  return tasks.length ? tasks.map(taskMarkup).join("") : emptyState("Nada por aqui", "Suas tarefas vão aparecer nesta lista.");
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  const form = dialog.querySelector("form");
  form.reset();
  if (form.elements.date) form.elements.date.value = today;
  if (form.elements.startDate) form.elements.startDate.value = today;
  dialog.showModal();
  const firstInput = form.querySelector("input");
  if (firstInput) firstInput.focus();
}

function switchView(name) {
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "view-" + name));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  const labels = { hoje: "Visão geral", tarefas: "Tarefas", metas: "Metas", habitos: "Hábitos" };
  document.getElementById("breadcrumb-current").textContent = labels[name] || labels.hoje;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initialize() {
  document.getElementById("today-label").textContent = formatDate(today, { day: "numeric", month: "short" });
  const hour = new Date().getHours();
  document.getElementById("greeting").textContent = hour < 12 ? "BOM DIA" : hour < 18 ? "BOA TARDE" : "BOA NOITE";
  render();

  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      switchView(viewButton.dataset.view);
      return;
    }
    const openButton = event.target.closest("[data-open]");
    if (openButton) {
      openDialog(openButton.dataset.open);
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const { action, id } = actionButton.dataset;

    if (action === "toggle-task") {
      const task = state.tasks.find((item) => item.id === id);
      if (task) task.done = !task.done;
      saveState();
    }
    if (action === "delete-task") {
      state.tasks = state.tasks.filter((item) => item.id !== id);
      saveState();
      showToast("Tarefa removida.");
    }
    if (action === "increment-goal" || action === "decrement-goal") {
      const goal = state.goals.find((item) => item.id === id);
      if (goal) {
        goal.progress = goal.progress || {};
        goal.progress[today] = Math.max(0, currentProgress(goal) + (action === "increment-goal" ? 1 : -1));
      }
      saveState();
    }
    if (action === "delete-goal") {
      state.goals = state.goals.filter((item) => item.id !== id);
      saveState();
      showToast("Meta removida.");
    }
    if (action === "reset-habit") {
      const habit = state.habits.find((item) => item.id === id);
      if (habit && window.confirm("Reiniciar a contagem de "" + habit.title + "" hoje? O histórico anterior será mantido.")) {
        habit.resets = habit.resets || [];
        if (habit.resets.at(-1) !== today) habit.resets.push(today);
        saveState();
        showToast("Contagem reiniciada. Seu histórico foi mantido.");
      }
    }
    if (action === "delete-habit") {
      const habit = state.habits.find((item) => item.id === id);
      if (habit && window.confirm("Excluir o hábito "" + habit.title + "" e seu histórico?")) {
        state.habits = state.habits.filter((item) => item.id !== id);
        saveState();
        showToast("Hábito removido.");
      }
    }
  });

  document.getElementById("task-filter").addEventListener("change", () => {
    document.getElementById("all-task-list").innerHTML = renderAllTasks();
  });

  document.getElementById("task-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    state.tasks.push({ id: makeId(), title: data.get("title").trim(), date: data.get("date"), time: data.get("time"), note: data.get("note").trim(), done: false });
    form.closest("dialog").close();
    saveState();
    switchView("tarefas");
    showToast("Tarefa adicionada.");
  });

  document.getElementById("goal-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.goals.push({ id: makeId(), title: data.get("title").trim(), target: Number(data.get("target")), unit: data.get("unit").trim(), progress: {} });
    event.currentTarget.closest("dialog").close();
    saveState();
    switchView("metas");
    showToast("Meta criada.");
  });

  document.getElementById("habit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.habits.push({ id: makeId(), title: data.get("title").trim(), startDate: data.get("startDate"), resets: [] });
    event.currentTarget.closest("dialog").close();
    saveState();
    switchView("habitos");
    showToast("Hábito adicionado.");
  });

  document.getElementById("quick-add").addEventListener("click", () => openDialog("task-dialog"));
}

document.addEventListener("DOMContentLoaded", initialize);
