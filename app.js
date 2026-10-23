const config = window.RITMO_SUPABASE_CONFIG;
const supabaseClient = window.supabase.createClient(config.url, config.publishableKey);
const STORAGE_KEY = "ritmo-prototype-v1";
let currentUser = null;
let state = { tasks: [], goals: [], habits: [], checkins: [], progress: [], settings: null };
let toastTimer;
let authMode = "signin";
let today = "";

function activeTimezone() {
  return (state.settings && state.settings.timezone) || "America/Sao_Paulo";
}

function dateKeyInZone(date = new Date(), zone = activeTimezone()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = {};
  parts.forEach((part) => { values[part.type] = part.value; });
  return values.year + "-" + values.month + "-" + values.day;
}

function zonedDateTimeToIso(dateKey, timeKey, zone = activeTimezone()) {
  const dateParts = dateKey.split("-").map(Number);
  const timeParts = timeKey.split(":").map(Number);
  const target = Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1]);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(guess));
    const values = {};
    parts.forEach((part) => { values[part.type] = part.value; });
    const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}

function timeKeyInZone(date, zone = activeTimezone()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = {};
  parts.forEach((part) => { values[part.type] = part.value; });
  return values.hour + ":" + values.minute;
}

function dateFromKey(key) {
  const parts = key.split("-").map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
}

function offsetDate(days) {
  const date = dateFromKey(today);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromKey, toKey) {
  const from = dateFromKey(fromKey);
  const to = dateFromKey(toKey);
  return Math.max(0, Math.floor((to - from) / 86400000));
}

function formatDate(dateKey, options = { weekday: "short", day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: "UTC" }).format(dateFromKey(dateKey));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function emptyState(title, message) {
  return '<div class="empty-state"><strong>' + escapeHtml(title) + "</strong>" + escapeHtml(message) + "</div>";
}

function currentProgress(goal) {
  return state.progress
    .filter((entry) => entry.goal_id === goal.id && entry.entry_date === today)
    .reduce((total, entry) => total + Number(entry.amount || 0), 0);
}

function habitDays(habit) {
  return daysBetween(habit.current_streak_started_on, today);
}

function checkinFor(taskId, date) {
  return state.checkins.find((item) => item.task_id === taskId && item.occurrence_date === date);
}

function occurrenceTime(task, date) {
  if (task.repeat_frequency === "once") {
    return timeKeyInZone(new Date(task.scheduled_at));
  }
  return String(task.reminder_time || "").slice(0, 5);
}

function taskOccursOn(task, date) {
  if (!task.is_active) return false;
  if (task.repeat_frequency === "once") {
    return dateKeyInZone(new Date(task.scheduled_at)) === date;
  }
  if (date < task.starts_on || (task.ends_on && date > task.ends_on)) return false;
  if (task.repeat_frequency === "daily") return true;
  if (task.repeat_frequency === "weekly") {
    const weekday = new Date(date + "T00:00:00Z").getUTCDay();
    return (task.repeat_days || []).map(Number).includes(weekday);
  }
  return false;
}

function taskOccurrence(task, date) {
  const checkin = checkinFor(task.id, date);
  return {
    id: task.id,
    title: task.title,
    note: task.description || "",
    date,
    time: occurrenceTime(task, date),
    done: !!checkin && checkin.status === "completed",
    task
  };
}

function occurrencesBetween(start, end) {
  const results = [];
  const startDate = dateFromKey(start);
  const endDate = dateFromKey(end);
  const span = Math.min(370, Math.ceil((endDate - startDate) / 86400000));
  state.tasks.forEach((task) => {
    if (task.repeat_frequency === "once") {
      const date = dateKeyInZone(new Date(task.scheduled_at));
      if (date >= start && date <= end) results.push(taskOccurrence(task, date));
      return;
    }
    for (let i = 0; i <= span; i += 1) {
      const date = offsetDateFrom(start, i);
      if (taskOccursOn(task, date)) results.push(taskOccurrence(task, date));
    }
  });
  return results.sort((a, b) => (a.date + (a.time || "99:99")).localeCompare(b.date + (b.time || "99:99")));
}

function offsetDateFrom(key, days) {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function taskMarkup(occurrence) {
  const dateLabel = occurrence.date === today ? "Hoje" : formatDate(occurrence.date, { day: "numeric", month: "short" });
  const meta = dateLabel + (occurrence.note ? " · " + escapeHtml(occurrence.note) : "");
  return '<div class="task-row ' + (occurrence.done ? "completed" : "") + '">' +
    '<button class="check-button ' + (occurrence.done ? "done" : "") + '" data-action="toggle-task" data-id="' + occurrence.id + '" data-date="' + occurrence.date + '" aria-label="' + (occurrence.done ? "Marcar como pendente" : "Concluir tarefa") + '">' + (occurrence.done ? "✓" : "") + "</button>" +
    '<div class="task-info"><div class="task-title">' + escapeHtml(occurrence.title) + '</div><div class="task-meta">' + meta + "</div></div>" +
    (occurrence.time ? '<time class="task-time">' + escapeHtml(occurrence.time) + "</time>" : "") +
    '<button class="delete-button" data-action="delete-task" data-id="' + occurrence.id + '" aria-label="Excluir tarefa">×</button></div>';
}

function goalMarkup(goal, featured = false) {
  const progress = currentProgress(goal);
  const target = Number(goal.target_value);
  const percent = target > 0 ? Math.min(100, Math.round((progress / target) * 100)) : 0;
  const remaining = Math.max(0, target - progress);
  const areaClass = featured ? "goal-feature" : "goal-card";
  return '<article class="' + areaClass + '">' +
    (featured ? "" : '<div class="goal-card-top"><div class="goal-card-icon">◎</div><div><div class="goal-card-title">' + escapeHtml(goal.name) + '</div><div class="goal-card-sub">Meta diária · ' + target + " " + escapeHtml(goal.unit) + '</div></div><span class="card-spacer"></span><button class="delete-button" data-action="delete-goal" data-id="' + goal.id + '" aria-label="Excluir meta">×</button></div>') +
    (featured ? '<div class="goal-feature-title">' + escapeHtml(goal.name) + '</div><div class="goal-feature-sub">Sua meta é ' + target + " " + escapeHtml(goal.unit) + " por dia.</div>" : "") +
    '<div class="goal-number-row"><span class="goal-number">' + progress + '</span><span class="goal-target">/ ' + target + " " + escapeHtml(goal.unit) + "</span></div>" +
    '<div class="goal-progress"><span style="width:' + percent + '%"></span></div>' +
    '<div class="' + (featured ? "goal-actions" : "goal-card-footer") + '"><span class="small-muted">' + (remaining > 0 ? "Faltam " + remaining + " " + escapeHtml(goal.unit) : "Meta concluída hoje ✦") + '</span><span class="goal-action-buttons"><button class="step-button" data-action="decrement-goal" data-id="' + goal.id + '" aria-label="Diminuir progresso">−</button><button class="step-button" data-action="increment-goal" data-id="' + goal.id + '" aria-label="Adicionar progresso">+</button></span></div>' +
    "</article>";
}

function habitMarkup(habit) {
  const days = habitDays(habit);
  const interval = Number(habit.notification_interval_days || 5);
  const nextMilestone = (Math.floor(days / interval) + 1) * interval;
  const previousMilestone = Math.floor(days / interval) * interval;
  const progress = Math.min(100, Math.max(0, ((days - previousMilestone) / interval) * 100));
  const startedOn = habit.current_streak_started_on;
  const subtitle = startedOn !== habit.started_on
    ? "Recomeçou em " + formatDate(startedOn)
    : "Começou em " + formatDate(habit.started_on);
  return '<article class="habit-card"><div class="habit-card-top"><div class="habit-card-icon">✳</div><div><div class="habit-card-title">' + escapeHtml(habit.name) + '</div><div class="habit-card-sub">' + subtitle + '</div></div><span class="card-spacer"></span><button class="delete-button" data-action="delete-habit" data-id="' + habit.id + '" aria-label="Excluir hábito">×</button></div>' +
    '<div class="habit-days-row"><div class="habit-days">' + days + "<span>" + (days === 1 ? "dia" : "dias") + '</span></div><span class="milestone-tag">' + (days > 0 && days % interval === 0 ? "Marco de " + days + " dias ✦" : "Próximo marco: " + nextMilestone + " dias") + "</span></div>" +
    '<div class="milestone-track"><span style="width:' + progress + '%"></span></div><div class="habit-card-footer"><span>Reinicia a contagem, mantendo o histórico.</span><button class="reset-button" data-action="reset-habit" data-id="' + habit.id + '">↻ Reiniciar</button></div></article>';
}

function renderAllTasks() {
  const filter = document.getElementById("task-filter").value;
  let tasks = [];
  if (filter === "today") {
    tasks = occurrencesBetween(today, today);
  } else if (filter === "upcoming") {
    tasks = occurrencesBetween(offsetDate(1), offsetDate(14));
  } else if (filter === "done") {
    tasks = state.checkins
      .filter((item) => item.status === "completed")
      .map((item) => {
        const task = state.tasks.find((candidate) => candidate.id === item.task_id);
        return task ? taskOccurrence(task, item.occurrence_date) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
  } else {
    const recurringStart = offsetDate(-7);
    const recurringEnd = offsetDate(7);
    tasks = state.tasks
      .filter((task) => task.repeat_frequency === "once")
      .map((task) => taskOccurrence(task, dateKeyInZone(new Date(task.scheduled_at))))
      .concat(occurrencesBetween(recurringStart, recurringEnd).filter((item) => item.task.repeat_frequency !== "once"));
    tasks = tasks.sort((a, b) => (a.date + (a.time || "99:99")).localeCompare(b.date + (b.time || "99:99")));
  }
  return tasks.length ? tasks.map(taskMarkup).join("") : emptyState("Nada por aqui", "Suas tarefas vão aparecer nesta lista.");
}

function render() {
  if (!currentUser || !state.settings) return;
  today = dateKeyInZone();
  document.getElementById("today-label").textContent = formatDate(today, { day: "numeric", month: "short" });
  const hour = Number(timeKeyInZone(new Date()).slice(0, 2));
  document.getElementById("greeting").textContent = hour < 12 ? "BOM DIA" : hour < 18 ? "BOA TARDE" : "BOA NOITE";

  const tasksToday = occurrencesBetween(today, today);
  const doneCount = tasksToday.filter((task) => task.done).length;
  const progressPercent = tasksToday.length ? Math.round(doneCount / tasksToday.length * 100) : 0;
  document.getElementById("day-progress").innerHTML = progressPercent + "<span>%</span>";
  document.getElementById("day-progress-bar").style.width = progressPercent + "%";
  document.getElementById("day-progress-foot").textContent = tasksToday.length
    ? (progressPercent === 100 ? "Tudo concluído. Muito bem!" : "Um passo de cada vez.")
    : "Adicione uma tarefa para começar.";
  document.getElementById("tasks-done").innerHTML = doneCount + '<span class="value-small"> / ' + tasksToday.length + "</span>";
  document.getElementById("task-nav-count").textContent = tasksToday.filter((task) => !task.done).length;

  const featuredGoal = state.goals[0];
  document.getElementById("goal-highlight").textContent = featuredGoal ? featuredGoal.name : "—";
  document.getElementById("goal-highlight-foot").textContent = featuredGoal
    ? currentProgress(featuredGoal) + " de " + featuredGoal.target_value + " " + featuredGoal.unit + " hoje."
    : "Adicione sua primeira meta.";
  document.getElementById("featured-goal").innerHTML = featuredGoal
    ? goalMarkup(featuredGoal, true)
    : emptyState("Sua primeira meta começa aqui", "Crie uma meta diária para acompanhar seu progresso.");
  document.getElementById("today-task-list").innerHTML = tasksToday.length
    ? tasksToday.map(taskMarkup).join("")
    : emptyState("Dia livre por enquanto", "Adicione uma tarefa quando quiser planejar algo.");
  document.getElementById("all-task-list").innerHTML = renderAllTasks();
  document.getElementById("goal-list").innerHTML = state.goals.length
    ? state.goals.map((goal) => goalMarkup(goal)).join("")
    : emptyState("Nenhuma meta ainda", "Crie uma meta diária para acompanhar seu progresso.");
  document.getElementById("habit-list").innerHTML = state.habits.length
    ? state.habits.map(habitMarkup).join("")
    : emptyState("Nenhum hábito ainda", "Adicione um hábito para começar a acompanhar sua jornada.");

  const mainHabit = state.habits[0];
  document.getElementById("highlight-habit-title").textContent = mainHabit ? mainHabit.name : "Hábitos em construção";
  document.getElementById("highlight-habit-days").textContent = mainHabit ? habitDays(mainHabit) : "—";
  document.getElementById("highlight-habit-description").textContent = mainHabit
    ? "Seu próximo marco está a caminho. Continue no seu ritmo."
    : "A consistência não precisa ser perfeita. Só precisa continuar.";
  document.getElementById("profile-email").textContent = currentUser.email || "Conta Ritmo";
  document.getElementById("profile-avatar").textContent = (currentUser.email || "R").slice(0, 1).toUpperCase();
  document.getElementById("sync-status").textContent = "Sincronizado com a nuvem";
}

async function loadData() {
  const owner = currentUser.id;
  const results = await Promise.all([
    supabaseClient.from("ritmo").select("*").eq("user_id", owner).single(),
    supabaseClient.from("tasks").select("*").eq("user_id", owner).eq("is_active", true).order("created_at", { ascending: false }),
    supabaseClient.from("goals").select("*").eq("user_id", owner).eq("is_active", true).order("created_at", { ascending: false }),
    supabaseClient.from("goal_progress_entries").select("*").eq("user_id", owner).order("created_at", { ascending: false }),
    supabaseClient.from("habits").select("*").eq("user_id", owner).eq("is_active", true).order("created_at", { ascending: false }),
    supabaseClient.from("task_checkins").select("*").eq("user_id", owner).order("occurrence_date", { ascending: false }),
    supabaseClient.from("habit_resets").select("*").eq("user_id", owner).order("reset_on", { ascending: false })
  ]);
  const failed = results.find((result) => result.error);
  if (failed) throw failed.error;
  state.settings = results[0].data;
  state.tasks = results[1].data || [];
  state.goals = results[2].data || [];
  state.progress = results[3].data || [];
  state.habits = results[4].data || [];
  state.checkins = results[5].data || [];
  state.resets = results[6].data || [];
  render();
}

async function refreshData() {
  try {
    await loadData();
  } catch (error) {
    console.error("Erro ao carregar dados do Ritmo:", error);
    showToast("Não foi possível sincronizar: " + (error.message || "erro no banco."));
  }
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  const form = dialog.querySelector("form");
  form.reset();
  if (form.elements.date) form.elements.date.value = today;
  if (form.elements.startDate) form.elements.startDate.value = today;
  if (form.elements.repeat) form.elements.repeat.value = "once";
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

function setAuthMode(mode) {
  authMode = mode;
  document.getElementById("auth-title").textContent = mode === "signin" ? "Entre no seu espaço" : "Crie sua conta";
  document.getElementById("auth-submit").textContent = mode === "signin" ? "Entrar" : "Criar conta";
  document.getElementById("auth-mode-toggle").textContent = mode === "signin" ? "Primeiro acesso? Criar conta" : "Já tem conta? Entrar";
  document.getElementById("auth-message").textContent = "";
}

async function activateUser(user) {
  currentUser = user;
  document.getElementById("auth-screen").hidden = true;
  document.getElementById("app-shell").hidden = false;
  await refreshData();
}

function setSignedOut() {
  currentUser = null;
  state = { tasks: [], goals: [], habits: [], checkins: [], progress: [], settings: null };
  document.getElementById("app-shell").hidden = true;
  document.getElementById("auth-screen").hidden = false;
}

async function runAction(action) {
  try {
    const result = await action();
    if (result && result.error) throw result.error;
    await loadData();
    return true;
  } catch (error) {
    console.error("Erro no Ritmo:", error);
    showToast(error.message || "Não foi possível salvar.");
    return false;
  }
}

function initializeEvents() {
  document.getElementById("auth-mode-toggle").addEventListener("click", () => {
    setAuthMode(authMode === "signin" ? "signup" : "signin");
  });

  document.getElementById("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    const message = document.getElementById("auth-message");
    const submit = document.getElementById("auth-submit");
    submit.disabled = true;
    message.textContent = authMode === "signin" ? "Entrando..." : "Criando sua conta...";
    try {
      if (authMode === "signin") {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await activateUser(data.user);
      } else {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.href.split("#")[0] }
        });
        if (error) throw error;
        if (data.session && data.user) {
          await activateUser(data.user);
        } else {
          message.textContent = "Conta criada. Confirme o e-mail enviado para entrar.";
        }
      }
    } catch (error) {
      message.textContent = error.message || "Não foi possível autenticar.";
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById("sign-out").addEventListener("click", async () => {
    const { error } = await supabaseClient.auth.signOut();
    if (error) showToast(error.message);
    else setSignedOut();
  });

  document.getElementById("settings-open").addEventListener("click", () => {
    const form = document.getElementById("settings-form");
    form.elements.discordUserId.value = state.settings.discord_user_id || "";
    form.elements.timezone.value = state.settings.timezone || "America/Sao_Paulo";
    form.elements.summaryTime.value = String(state.settings.daily_summary_time || "21:00").slice(0, 5);
    form.elements.summaryEnabled.checked = !!state.settings.daily_summary_enabled;
    document.getElementById("settings-dialog").showModal();
  });

  document.getElementById("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const discordUserId = String(form.elements.discordUserId.value || "").trim();
    const timezone = String(form.elements.timezone.value || "").trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      showToast("Informe um fuso válido, por exemplo America/Sao_Paulo.");
      return;
    }
    if (discordUserId && !/^\d{17,20}$/.test(discordUserId)) {
      showToast("O ID do Discord deve conter apenas 17 a 20 números.");
      return;
    }
    const { error } = await supabaseClient.from("ritmo").update({
      discord_user_id: discordUserId || null,
      timezone,
      daily_summary_enabled: form.elements.summaryEnabled.checked,
      daily_summary_time: form.elements.summaryTime.value || "21:00"
    }).eq("user_id", currentUser.id);
    if (error) {
      showToast(error.message);
      return;
    }
    document.getElementById("settings-dialog").close();
    await refreshData();
    showToast("Configurações salvas.");
  });

  document.addEventListener("click", async (event) => {
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
    if (!actionButton || !currentUser) return;
    const { action, id, date } = actionButton.dataset;
    const owner = currentUser.id;

    if (action === "toggle-task") {
      const occurrence = taskOccurrence(state.tasks.find((task) => task.id === id), date);
      const completed = !occurrence.done;
      const ok = await runAction(() => supabaseClient.from("task_checkins").upsert({
        task_id: id,
        user_id: owner,
        occurrence_date: date,
        status: completed ? "completed" : "pending",
        completed_at: completed ? new Date().toISOString() : null
      }, { onConflict: "task_id,occurrence_date" }));
      if (ok) showToast(completed ? "Tarefa concluída." : "Tarefa marcada como pendente.");
    }

    if (action === "delete-task") {
      const task = state.tasks.find((item) => item.id === id);
      if (task && window.confirm('Excluir a tarefa "' + task.title + '" e seus registros?')) {
        const ok = await runAction(() => supabaseClient.from("tasks").delete().eq("id", id).eq("user_id", owner));
        if (ok) showToast("Tarefa removida.");
      }
    }

    if (action === "increment-goal") {
      const ok = await runAction(() => supabaseClient.from("goal_progress_entries").insert({
        goal_id: id, user_id: owner, entry_date: today, amount: 1
      }));
      if (ok) showToast("Progresso atualizado.");
    }

    if (action === "decrement-goal") {
      const entry = state.progress.find((item) => item.goal_id === id && item.entry_date === today);
      if (entry) {
        const ok = await runAction(() => supabaseClient.from("goal_progress_entries").delete().eq("id", entry.id).eq("user_id", owner));
        if (ok) showToast("Progresso atualizado.");
      }
    }

    if (action === "delete-goal") {
      const goal = state.goals.find((item) => item.id === id);
      if (goal && window.confirm('Excluir a meta "' + goal.name + '" e seu progresso?')) {
        const ok = await runAction(() => supabaseClient.from("goals").delete().eq("id", id).eq("user_id", owner));
        if (ok) showToast("Meta removida.");
      }
    }

    if (action === "reset-habit") {
      const habit = state.habits.find((item) => item.id === id);
      if (habit && window.confirm('Reiniciar a contagem de "' + habit.name + '" hoje? O histórico anterior será mantido.')) {
        const result = await supabaseClient.rpc("reset_habit", {
          p_habit_id: id, p_reset_on: today, p_note: null
        });
        if (result.error) showToast(result.error.message);
        else {
          await refreshData();
          showToast("Contagem reiniciada. Seu histórico foi mantido.");
        }
      }
    }

    if (action === "delete-habit") {
      const habit = state.habits.find((item) => item.id === id);
      if (habit && window.confirm('Excluir o hábito "' + habit.name + '" e seu histórico?')) {
        const ok = await runAction(() => supabaseClient.from("habits").delete().eq("id", id).eq("user_id", owner));
        if (ok) showToast("Hábito removido.");
      }
    }
  });

  document.getElementById("task-filter").addEventListener("change", () => {
    document.getElementById("all-task-list").innerHTML = renderAllTasks();
  });

  document.getElementById("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const repeat = String(data.get("repeat") || "once");
    const date = String(data.get("date"));
    const time = String(data.get("time"));
    if (!date || !time) {
      showToast("Escolha o dia e o horário da tarefa.");
      return;
    }
    const record = {
      user_id: currentUser.id,
      title: String(data.get("title")).trim(),
      description: String(data.get("note") || "").trim() || null,
      repeat_frequency: repeat,
      reminder_enabled: true
    };
    if (repeat === "once") {
      record.scheduled_at = zonedDateTimeToIso(date, time);
    } else {
      record.starts_on = date;
      record.reminder_time = time;
      if (repeat === "weekly") record.repeat_days = [new Date(date + "T00:00:00Z").getUTCDay()];
    }
    const ok = await runAction(() => supabaseClient.from("tasks").insert(record));
    if (ok) {
      form.closest("dialog").close();
      switchView("tarefas");
      showToast("Tarefa adicionada.");
    }
  });

  document.getElementById("goal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const record = {
      user_id: currentUser.id,
      name: String(data.get("title")).trim(),
      target_value: Number(data.get("target")),
      unit: String(data.get("unit")).trim(),
      period: "daily",
      starts_on: today
    };
    const ok = await runAction(() => supabaseClient.from("goals").insert(record));
    if (ok) {
      event.currentTarget.closest("dialog").close();
      switchView("metas");
      showToast("Meta criada.");
    }
  });

  document.getElementById("habit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const startDate = String(data.get("startDate"));
    const record = {
      user_id: currentUser.id,
      name: String(data.get("title")).trim(),
      started_on: startDate,
      current_streak_started_on: startDate,
      notification_interval_days: 5
    };
    const ok = await runAction(() => supabaseClient.from("habits").insert(record));
    if (ok) {
      event.currentTarget.closest("dialog").close();
      switchView("habitos");
      showToast("Hábito adicionado.");
    }
  });

  document.getElementById("quick-add").addEventListener("click", () => openDialog("task-dialog"));
}

async function initialize() {
  document.getElementById("auth-message").textContent = "";
  const secure = window.isSecureContext || ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!secure) {
    document.getElementById("auth-form").hidden = true;
    document.getElementById("auth-mode-toggle").hidden = true;
    document.getElementById("auth-message").textContent = "Para entrar com segurança, abra a versão HTTPS do site. O endereço HTTP do servidor Waifly não protege sua sessão.";
  }

  initializeEvents();
  supabaseClient.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      if (session && session.user) activateUser(session.user);
      else if (event === "SIGNED_OUT") setSignedOut();
    }, 0);
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    document.getElementById("auth-message").textContent = error.message;
    return;
  }
  if (data.session && data.session.user && secure) await activateUser(data.session.user);
  else setSignedOut();

  setInterval(() => {
    if (currentUser) {
      const nextToday = dateKeyInZone();
      if (nextToday !== today) refreshData();
      else render();
    }
  }, 60000);
}

document.addEventListener("DOMContentLoaded", initialize);
