const config = window.RITMO_SUPABASE_CONFIG;
function takeOAuthError() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const text = query.get("error_description") || hash.get("error_description") || query.get("error") || hash.get("error");
  if (!text) return "";
  try { window.history.replaceState(null, "", window.location.pathname); } catch (error) { /* ignore */ }
  return text;
}
const initialOAuthError = takeOAuthError();
const supabaseClient = window.supabase.createClient(config.url, config.publishableKey);
const STORAGE_KEY = "ritmo-prototype-v1";
let currentUser = null;
let activation = null;
let activationUserId = null;
let state = { tasks: [], reminders: [], goals: [], habits: [], checkins: [], progress: [], countEntries: [], resets: [], settings: null };
let toastTimer;
let today = "";
let calendarCursor = null;
let selectedCalendarDate = null;
let currentView = "hoje";
const calendarGroupOpen = { tasks: true, goals: true, habits: true };

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
  if (task.repeat_frequency === "monthly") {
    return new Date(date + "T00:00:00Z").getUTCDate() === Number(task.repeat_month_day || 0);
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

function reminderOccurrence(reminder, date) {
  return { id: reminder.id, title: reminder.title, note: reminder.description || "", date, time: occurrenceTime(reminder, date), done: false, task: reminder };
}

function reminderOccurrencesBetween(start, end) {
  return occurrencesBetween(start, end, state.reminders, reminderOccurrence);
}

function occurrencesBetween(start, end, source = state.tasks, build = taskOccurrence) {
  const results = [];
  const startDate = dateFromKey(start);
  const endDate = dateFromKey(end);
  const span = Math.min(370, Math.ceil((endDate - startDate) / 86400000));
  source.forEach((task) => {
    if (task.repeat_frequency === "once") {
      const date = dateKeyInZone(new Date(task.scheduled_at));
      if (date >= start && date <= end) results.push(build(task, date));
      return;
    }
    for (let i = 0; i <= span; i += 1) {
      const date = offsetDateFrom(start, i);
      if (taskOccursOn(task, date)) results.push(build(task, date));
    }
  });
  return results.sort((a, b) => (a.date + (a.time || "99:99")).localeCompare(b.date + (b.time || "99:99")));
}

function offsetDateFrom(key, days) {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const BELL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const BELL_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>';

function notificationOff(type, item) {
  if (!item) return false;
  if (type === "task") return item.reminder_enabled === false;
  if (type === "goal") return item.notify_enabled === false;
  if (type === "habit") return item.category === "quit" && item.notify_milestones === false;
  return false;
}

function mutedBell(type, item) {
  return notificationOff(type, item)
    ? '<span class="muted-bell" role="img" tabindex="0" aria-label="Notificação do Discord desligada" data-tip="Notificação do Discord desligada">' + BELL_OFF_SVG + "</span>"
    : "";
}

function moreButton(type, id) {
  return '<button class="more-button" type="button" data-action="edit-item" data-item-type="' + type + '" data-id="' + id + '" aria-label="Configurações (' + ITEM_META[type].noun + ')" title="Configurações">⋯</button>';
}

function reminderRepeatLabel(reminder) {
  return { once: "Único", daily: "Diário", weekly: "Semanal", monthly: "Mensal" }[reminder.repeat_frequency] || "";
}

function reminderMarkup(occurrence) {
  return '<article class="reminder-card" data-item-type="reminder" data-id="' + occurrence.id + '">' +
    '<div class="reminder-card-top"><span class="reminder-icon">' + BELL_SVG + '</span><time class="reminder-time">' + escapeHtml(occurrence.time || "--:--") + '</time><span class="card-spacer"></span>' + moreButton("reminder", occurrence.id) + "</div>" +
    '<div class="reminder-title">' + escapeHtml(occurrence.title) + '</div><div class="reminder-meta">' + reminderRepeatLabel(occurrence.task) + "</div>" +
    (occurrence.note ? '<p class="reminder-note">' + escapeHtml(occurrence.note) + "</p>" : "") + "</article>";
}

function reminderRow(occurrence) {
  return '<div class="calendar-detail-row" data-item-type="reminder" data-id="' + occurrence.id + '"><span class="calendar-detail-icon">' + BELL_SVG.replace("<svg ", '<svg width="16" height="16" ') + "</span><div><strong>" + escapeHtml(occurrence.title) + "</strong><small>" + escapeHtml(occurrence.time || "--:--") + " · " + reminderRepeatLabel(occurrence.task) + "</small></div>" + moreButton("reminder", occurrence.id) + "</div>";
}

function taskMarkup(occurrence, options = {}) {
  const showDate = options.showDate !== false;
  const repeatLabel = { once: "Única", daily: "Diária", weekly: "Semanal", monthly: "Mensal" }[occurrence.task.repeat_frequency] || "";
  const dateLabel = occurrence.date === today ? "Hoje" : formatDate(occurrence.date, { day: "numeric", month: "short" });
  const note = occurrence.note ? " · " + escapeHtml(occurrence.note) : "";
  const meta = showDate ? dateLabel + note : repeatLabel + note;
  return '<div class="task-row ' + (occurrence.done ? "completed" : "") + '" data-item-type="task" data-id="' + occurrence.id + '">' +
    '<button class="check-button ' + (occurrence.done ? "done" : "") + '" data-action="toggle-task" data-id="' + occurrence.id + '" data-date="' + occurrence.date + '" aria-label="' + (occurrence.done ? "Marcar como pendente" : "Concluir tarefa") + '">' + (occurrence.done ? "✓" : "") + "</button>" +
    '<div class="task-info"><div class="task-title-line"><div class="task-title">' + escapeHtml(occurrence.title) + "</div>" + mutedBell("task", occurrence.task) + '</div><div class="task-meta">' + meta + "</div></div>" +
    (occurrence.time ? '<time class="task-time">' + escapeHtml(occurrence.time) + "</time>" : "") +
    moreButton("task", occurrence.id) + "</div>";
}

function goalMarkup(goal, featured = false) {
  const progress = currentProgress(goal);
  const target = Number(goal.target_value);
  const percent = target > 0 ? Math.min(100, Math.round((progress / target) * 100)) : 0;
  const remaining = Math.max(0, target - progress);
  const areaClass = featured ? "goal-feature" : "goal-card";
  return '<article class="' + areaClass + '" data-item-type="goal" data-id="' + goal.id + '">' +
    (featured ? "" : '<div class="goal-card-top"><div class="goal-card-icon">◎</div><div><div class="goal-card-title">' + escapeHtml(goal.name) + mutedBell("goal", goal) + '</div><div class="goal-card-sub">Meta diária · ' + target + " " + escapeHtml(goal.unit) + '</div><div class="goal-card-sub">Válida de ' + escapeHtml(formatDate(goal.starts_on)) + (goal.ends_on ? ' até ' + escapeHtml(formatDate(goal.ends_on)) : ' · sem data final') + '</div></div><span class="card-spacer"></span>' + moreButton("goal", goal.id) + '</div>') +
    (featured ? '<div class="goal-feature-title">' + escapeHtml(goal.name) + mutedBell("goal", goal) + '</div><div class="goal-feature-sub">Sua meta é ' + target + " " + escapeHtml(goal.unit) + " por dia.</div>" : "") +
    '<div class="goal-number-row"><span class="goal-number">' + progress + '</span><span class="goal-target">/ ' + target + " " + escapeHtml(goal.unit) + "</span></div>" +
    '<div class="goal-progress"><span style="width:' + percent + '%"></span></div>' +
    '<div class="' + (featured ? "goal-actions" : "goal-card-footer") + '"><span class="small-muted">' + (remaining > 0 ? "Faltam " + remaining + " " + escapeHtml(goal.unit) : "Meta concluída hoje ✦") + '</span><span class="goal-action-buttons"><button class="step-button" data-action="decrement-goal" data-id="' + goal.id + '" aria-label="Diminuir progresso">−</button><button class="step-button" data-action="increment-goal" data-id="' + goal.id + '" aria-label="Adicionar progresso">+</button></span></div>' +
    "</article>";
}

function addPeriodMonths(dateKey, months) {
  const source=dateFromKey(dateKey);
  const first=new Date(Date.UTC(source.getUTCFullYear(),source.getUTCMonth()+months,1,12));
  const lastDay=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0,12)).getUTCDate();
  first.setUTCDate(Math.min(source.getUTCDate(),lastDay));
  return first.toISOString().slice(0,10);
}

function habitPeriodRange(habit,date) {
  const anchor=habit.started_on||date,unit=habit.period_unit||"day",interval=Math.max(1,Number(habit.period_interval||1));
  let start=anchor,next;
  if(unit==="day"||unit==="week"){
    const length=interval*(unit==="week"?7:1);
    start=offsetDateFrom(anchor,Math.floor(daysBetween(anchor,date)/length)*length);
    next=offsetDateFrom(start,length);
  }else{
    const months=interval*(unit==="year"?12:1);
    let count=Math.max(0,Math.floor(((Number(date.slice(0,4))-Number(anchor.slice(0,4)))*12+Number(date.slice(5,7))-Number(anchor.slice(5,7)))/months));
    start=addPeriodMonths(anchor,count*months);
    while(start>date&&count>0)start=addPeriodMonths(anchor,--count*months);
    while(addPeriodMonths(anchor,(count+1)*months)<=date)start=addPeriodMonths(anchor,++count*months);
    next=addPeriodMonths(anchor,(count+1)*months);
  }
  return {start,end:offsetDateFrom(next,-1)};
}

function habitCount(habit,date=today) {
  const range=habitPeriodRange(habit,date);
  return state.countEntries.filter((entry)=>entry.habit_id===habit.id&&entry.entry_date>=range.start&&entry.entry_date<=range.end).reduce((sum,entry)=>sum+Number(entry.amount||0),0);
}

function habitMilestoneDates(startIso){
  const start=new Date(startIso),dates=[];
  for(const days of [1,2,3,7,14,21,28]){const d=new Date(start);d.setUTCDate(d.getUTCDate()+days);dates.push({date:d,label:days<7?days+" dia(s)":(days/7)+" semana(s)"});}
  for(let months=1;months<=6;months+=1){const d=new Date(start),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);const max=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,max));dates.push({date:d,label:months+" mês(es)"});}
  for(let years=1;years<=100;years+=1){const d=new Date(start),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+years*12);const max=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,max));dates.push({date:d,label:years+" ano(s)"});}
  return dates;
}
function habitMarkup(habit) {
  if(habit.category==="count"){
    const amount=habitCount(habit),target=Number(habit.target_count||1),negative=habit.count_polarity==="negative";
    const achieved=negative?amount<target:amount>=target;
    const percent=negative?(achieved?100:Math.max(0,100-Math.min(100,amount/target*100))):Math.min(100,amount/target*100);
    const range=habitPeriodRange(habit,today),unit=habit.measure_unit||"vezes";
    const cadence="A cada "+(habit.period_interval>1?habit.period_interval+" ":"")+({day:"dia(s)",week:"semana(s)",month:"mês(es)",year:"ano(s)"}[habit.period_unit||"day"]);
    const schedule=habit.schedule_mode==="specific_weekdays"?"Dias: "+(habit.repeat_days||[]).map(Number).map((day)=>["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"][day]).join(", "):habit.schedule_mode==="days_per_week"?"Em "+habit.days_per_week+" dia(s) por semana":"Registros no período";
    return '<article class="habit-card" data-item-type="habit" data-id="'+habit.id+'"><div class="habit-card-top"><div class="habit-card-icon">↻</div><div><div class="habit-card-title">'+escapeHtml(habit.name)+mutedBell("habit",habit)+'</div><div class="habit-card-sub">Contagem · '+(negative?"negativa":"positiva")+'</div></div><span class="card-spacer"></span>'+moreButton("habit",habit.id)+'</div>'+
    '<div class="count-habit-rule">'+(negative?"Menos de ":"Pelo menos ")+target+" "+escapeHtml(unit)+" · "+cadence+'</div><div class="habit-days-row"><div class="habit-days">'+amount+'<span>'+escapeHtml(unit)+'</span></div><span class="milestone-tag">'+(achieved?"Alvo do período atingido ✦":escapeHtml(formatDate(range.start,{day:"numeric",month:"short"}))+" — "+escapeHtml(formatDate(range.end,{day:"numeric",month:"short"})))+'</span></div>'+
    '<div class="milestone-track"><span style="width:'+percent+'%"></span></div><div class="habit-card-footer"><span>'+escapeHtml(schedule)+'</span><button class="reset-button" data-action="increment-habit" data-id="'+habit.id+'">＋ Registrar</button></div></article>';
  }
  const start=habit.current_streak_started_on||habit.started_on;
  const startedAt=habit.quit_started_at||new Date(start+"T00:00:00Z").toISOString();
  const nowMs=Date.now(),startMs=new Date(startedAt).getTime();
  const elapsed=Math.max(0,Math.floor((nowMs-startMs)/86400000));
  const milestones=habitMilestoneDates(startedAt),previous=milestones.filter((item)=>item.date.getTime()<=nowMs).slice(-1)[0],next=milestones.find((item)=>item.date.getTime()>nowMs)||milestones[milestones.length-1];
  const previousMs=previous?previous.date.getTime():startMs,progress=Math.min(100,Math.max(0,(nowMs-previousMs)/(next.date.getTime()-previousMs)*100));
  const isMilestoneToday=previous&&dateKeyInZone(previous.date)===today;
  const subtitle=habit.quit_started_at?"Parou em "+new Intl.DateTimeFormat("pt-BR",{dateStyle:"medium",timeStyle:"short",timeZone:activeTimezone()}).format(new Date(habit.quit_started_at)):"Começou em "+formatDate(start);
  return '<article class="habit-card" data-item-type="habit" data-id="'+habit.id+'"><div class="habit-card-top"><div class="habit-card-icon">✳</div><div><div class="habit-card-title">'+escapeHtml(habit.name)+mutedBell("habit",habit)+'</div><div class="habit-card-sub">'+escapeHtml(subtitle)+'</div></div><span class="card-spacer"></span>'+moreButton("habit",habit.id)+'</div>'+
  '<div class="habit-days-row"><div class="habit-days">'+elapsed+"<span>"+(elapsed===1?"dia":"dias")+'</span></div><span class="milestone-tag">'+(isMilestoneToday?"Marco de "+previous.label+" ✦":"Próximo marco: "+next.label)+'</span></div><div class="milestone-track"><span style="width:'+progress+'%"></span></div><div class="habit-card-footer"><span>O histórico continua guardado ao recomeçar.</span><button class="reset-button" data-action="reset-habit" data-id="'+habit.id+'">↻ Reiniciar</button></div></article>';
}

function capitalize(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }
function weekdayLabel(date) { return capitalize(formatDate(date, { weekday: "short" }).replace(".", "")); }

const dayPickers = { task: { selected: null, start: null }, reminder: { selected: null, start: null } };

function focusPickerDay(kind, date) {
  const picker = dayPickers[kind];
  picker.selected = date;
  const visible = picker.start && [0, 1, 2].some((index) => offsetDateFrom(picker.start, index) === date);
  if (!visible) picker.start = offsetDateFrom(date, -1);
}

function focusTaskDay(date) { focusPickerDay("task", date); }

function renderDayPicker(kind) {
  const picker = dayPickers[kind];
  if (!picker.selected) picker.selected = today;
  if (!picker.start) picker.start = offsetDateFrom(picker.selected, -1);
  const days = [0, 1, 2].map((index) => offsetDateFrom(picker.start, index));
  const busy = kind === "task" ? occurrencesBetween(days[0], days[2]) : reminderOccurrencesBetween(days[0], days[2]);
  document.getElementById(kind + "-day-days").innerHTML = days.map((date) =>
    '<button type="button" class="carousel-day' + (date === picker.selected ? " is-selected" : "") + (date === today ? " is-today" : "") + '" data-day="' + date + '" aria-pressed="' + (date === picker.selected) + '" aria-label="' + escapeHtml(formatDate(date, { weekday: "long", day: "numeric", month: "long" })) + '">' +
    "<small>" + weekdayLabel(date) + "</small><strong>" + Number(date.slice(8, 10)) + '</strong><i class="day-dot' + (busy.some((item) => item.date === date) ? " has" : "") + '"></i></button>').join("");
  document.getElementById(kind + "-today-jump").hidden = days.includes(today);
  const label = capitalize(formatDate(picker.selected, { weekday: "long", day: "numeric", month: "long" }));
  document.getElementById(kind + "-day-label").textContent = (picker.selected === today ? "Hoje · " : "") + label;
  return picker.selected;
}

function renderTaskDay() {
  const date = renderDayPicker("task");
  const tasks = occurrencesBetween(date, date);
  document.getElementById("all-task-list").innerHTML = tasks.length
    ? tasks.map((task) => taskMarkup(task, { showDate: false })).join("")
    : emptyState("Nada marcado para este dia", "As tarefas deste dia vão aparecer aqui.");
}

function renderReminderDay() {
  const date = renderDayPicker("reminder");
  const items = reminderOccurrencesBetween(date, date);
  document.getElementById("reminder-list").innerHTML = items.length
    ? items.map(reminderMarkup).join("")
    : emptyState("Nenhum lembrete neste dia", "Os lembretes do dia aparecem aqui como cartões.");
}

function upcomingPreviewMarkup() {
  let events = occurrencesBetween(today, today);
  if (!events.length) {
    const future = occurrencesBetween(offsetDate(1), offsetDate(370));
    if (future.length) events = future.filter((event) => event.date === future[0].date);
  }
  if (!events.length) return emptyState("Você não tem atividades chegando.", "");
  const names = { once: "", daily: "Tarefa diária · ", weekly: "Tarefa semanal · ", monthly: "Tarefa mensal · " };
  return events.map((event) => '<div class="preview-row' + (event.done ? " is-upcoming-done" : "") + '" data-item-type="task" data-id="' + event.id + '"><span class="preview-date">' + escapeHtml(event.date === today ? "Hoje" : formatDate(event.date)) + "</span><div><strong>" + escapeHtml(event.title) + mutedBell("task", event.task) + "</strong><small>" + escapeHtml(names[event.task.repeat_frequency] || "") + escapeHtml(event.time || "Sem horário") + "</small></div></div>").join("");
}

function goalActiveOn(goal, date) {
  return goal.starts_on <= date && (!goal.ends_on || goal.ends_on >= date);
}

function habitActiveOn(habit, date) {
  if (date < (habit.started_on || today)) return false;
  if (habit.category === "quit") return date <= today;
  if ((habit.period_unit || "day") === "day" && habit.schedule_mode === "specific_weekdays") {
    return (habit.repeat_days || []).map(Number).includes(new Date(date + "T00:00:00Z").getUTCDay());
  }
  return true;
}

function plural(count, one, many) { return count + " " + (count === 1 ? one : many); }

function detailGroup(key, title, count, rows, emptyText) {
  return '<details class="detail-group" data-group="' + key + '"' + (calendarGroupOpen[key] ? " open" : "") + "><summary><span>" + title + "</span><em>" + count + '</em></summary><div class="detail-group-body">' + (rows || '<p class="detail-empty">' + emptyText + "</p>") + "</div></details>";
}

function goalDetailRow(goal) {
  return '<div class="calendar-detail-row" data-item-type="goal" data-id="' + goal.id + '"><span class="calendar-detail-icon">◎</span><div><strong>' + escapeHtml(goal.name) + mutedBell("goal", goal) + "</strong><small>Meta diária · " + Number(goal.target_value) + " " + escapeHtml(goal.unit) + "</small></div>" + moreButton("goal", goal.id) + "</div>";
}

function habitDetailRow(habit) {
  const info = habit.category === "count" ? "Contagem · " + Number(habit.target_count) + " " + escapeHtml(habit.measure_unit || "vezes") : "Parar um hábito";
  return '<div class="calendar-detail-row" data-item-type="habit" data-id="' + habit.id + '"><span class="calendar-detail-icon">' + (habit.category === "count" ? "↻" : "✳") + "</span><div><strong>" + escapeHtml(habit.name) + mutedBell("habit", habit) + "</strong><small>" + info + "</small></div>" + moreButton("habit", habit.id) + "</div>";
}

function renderCalendar() {
  const grid = document.getElementById("calendar-grid");
  if (!grid) return;
  if (!calendarCursor) calendarCursor = today.slice(0, 7) + "-01";
  if (!selectedCalendarDate) selectedCalendarDate = today;
  const monthStart = dateFromKey(calendarCursor), offset = (monthStart.getUTCDay() + 6) % 7;
  const gridStart = offsetDateFrom(calendarCursor, -offset), gridEnd = offsetDateFrom(gridStart, 41), occurrences = occurrencesBetween(gridStart, gridEnd);
  const heading = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(monthStart);
  document.getElementById("calendar-month-label").textContent = capitalize(heading);
  let output = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((day) => '<div class="calendar-weekday">' + day + "</div>").join("");
  for (let i = 0; i < 42; i += 1) {
    const date = offsetDateFrom(gridStart, i);
    const tasks = occurrences.filter((event) => event.date === date).length;
    const goals = state.goals.filter((goal) => goalActiveOn(goal, date)).length;
    const habits = state.habits.filter((habit) => habitActiveOn(habit, date)).length;
    const chips = (tasks ? '<span class="calendar-chip task-chip">' + plural(tasks, "tarefa", "tarefas") + "</span>" : "") +
      (goals ? '<span class="calendar-chip goal-chip">' + plural(goals, "meta", "metas") + "</span>" : "") +
      (habits ? '<span class="calendar-chip habit-chip">' + plural(habits, "hábito", "hábitos") + "</span>" : "");
    output += '<div class="calendar-day ' + (date.slice(0, 7) !== calendarCursor.slice(0, 7) ? "outside-month " : "") + (date === today ? "is-today " : "") + (date === selectedCalendarDate ? "is-selected" : "") + '" role="button" tabindex="0" data-calendar-date="' + date + '" aria-label="' + escapeHtml(formatDate(date, { weekday: "long", day: "numeric", month: "long" })) + '">' +
      '<span class="calendar-day-number">' + Number(date.slice(8, 10)) + '</span><button type="button" class="day-add" data-calendar-add="' + date + '" aria-label="Adicionar atividade neste dia" aria-haspopup="menu">＋</button><span class="calendar-day-events">' + chips + "</span></div>";
  }
  grid.innerHTML = output;

  const date = selectedCalendarDate;
  const dayTasks = occurrencesBetween(date, date);
  const dayGoals = state.goals.filter((goal) => goalActiveOn(goal, date));
  const dayHabits = state.habits.filter((habit) => habitActiveOn(habit, date));
  const dayResets = (state.resets || []).filter((item) => item.reset_on === date).map((item) => {
    const habit = state.habits.find((candidate) => candidate.id === item.habit_id);
    return '<div class="calendar-detail-row"><span class="calendar-detail-icon">↺</span><div><strong>Recomeço · ' + escapeHtml(habit ? habit.name : "hábito") + "</strong><small>Contagem reiniciada neste dia</small></div></div>";
  }).join("");
  document.getElementById("calendar-selected-label").textContent = capitalize(formatDate(date, { weekday: "long", day: "numeric", month: "long" }));
  document.getElementById("calendar-selected-details").innerHTML =
    detailGroup("tasks", "Tarefas", dayTasks.length, dayTasks.map((task) => taskMarkup(task, { showDate: false })).join(""), "Nenhuma tarefa neste dia.") +
    detailGroup("goals", "Metas", dayGoals.length, dayGoals.map(goalDetailRow).join(""), "Nenhuma meta neste dia.") +
    detailGroup("habits", "Hábitos", dayHabits.length, dayHabits.map(habitDetailRow).join("") + dayResets, "Nenhum hábito neste dia.");
  const dayReminders = reminderOccurrencesBetween(date, date);
  document.getElementById("calendar-reminders").hidden = !dayReminders.length;
  document.getElementById("calendar-reminder-list").innerHTML = dayReminders.map(reminderRow).join("");
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
  renderTaskDay();
  renderReminderDay();
  document.getElementById("upcoming-preview").innerHTML = upcomingPreviewMarkup();
  renderCalendar();
  document.getElementById("goal-list").innerHTML = state.goals.length
    ? state.goals.map((goal) => goalMarkup(goal)).join("")
    : emptyState("Nenhuma meta ainda", "Crie uma meta diária para acompanhar seu progresso.");
  document.getElementById("habit-list").innerHTML = state.habits.length
    ? state.habits.map(habitMarkup).join("")
    : emptyState("Nenhum hábito ainda", "Adicione um hábito para começar a acompanhar sua jornada.");

  const mainHabit = state.habits[0];
  document.getElementById("highlight-habit-title").textContent = mainHabit ? mainHabit.name : "Hábitos em construção";
  document.getElementById("highlight-habit-days").textContent = mainHabit ? (mainHabit.category === "count" ? habitCount(mainHabit) : habitDays(mainHabit)) : "—";
  document.getElementById("highlight-habit-unit").textContent = mainHabit && mainHabit.category === "count" ? (mainHabit.measure_unit || "registros") : "dias";
  document.getElementById("highlight-habit-description").textContent = mainHabit
    ? (mainHabit.category === "count" ? "Acompanhe seus registros e avance no período atual." : "Seu próximo marco está a caminho. Continue no seu ritmo.")
    : "A consistência não precisa ser perfeita. Só precisa continuar.";
  updateDiscordProfile();
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
    supabaseClient.from("habit_resets").select("*").eq("user_id", owner).order("reset_on", { ascending: false }),
    supabaseClient.from("habit_count_entries").select("*").eq("user_id", owner).order("entry_date", { ascending: false }),
    supabaseClient.from("reminders").select("*").eq("user_id", owner).eq("is_active", true).order("created_at", { ascending: false })
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
  state.countEntries = results[7].data || [];
  state.reminders = results[8].data || [];
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

const ITEM_META = {
  task: { table: "tasks", dialog: "task-dialog", noun: "tarefa", create: ["Nova tarefa", "Adicionar tarefa"], edit: "Configurações da tarefa" },
  goal: { table: "goals", dialog: "goal-dialog", noun: "meta", create: ["Nova meta", "Criar meta"], edit: "Configurações da meta" },
  habit: { table: "habits", dialog: "habit-dialog", noun: "hábito", create: ["Novo hábito", "Criar hábito"], edit: "Configurações do hábito" },
  reminder: { table: "reminders", dialog: "reminder-dialog", noun: "lembrete", create: ["Novo lembrete", "Adicionar lembrete"], edit: "Configurações do lembrete" }
};

function itemsOf(type) { return type === "task" ? state.tasks : type === "reminder" ? state.reminders : type === "goal" ? state.goals : state.habits; }
function findItem(type, id) { return itemsOf(type).find((item) => item.id === id); }

function setDialogMode(dialog, type, item) {
  const meta = ITEM_META[type];
  if (item) dialog.dataset.editId = item.id; else delete dialog.dataset.editId;
  dialog.querySelector(".dialog-top h2").textContent = item ? meta.edit : meta.create[0];
  dialog.querySelector('form button[type="submit"]').textContent = item ? "Salvar alterações" : meta.create[1];
  dialog.querySelector("[data-dialog-delete]").hidden = !item;
  if (type === "habit") document.getElementById("habit-category").disabled = !!item;
}

function prepareDialog(id) {
  const dialog = document.getElementById(id);
  const form = dialog.querySelector("form");
  form.reset();
  if (form.elements.date) form.elements.date.value = today;
  if (form.elements.startDate) form.elements.startDate.value = today;
  if (form.elements.countStartDate) form.elements.countStartDate.value = today;
  if (form.elements.startTime) form.elements.startTime.value = timeKeyInZone(new Date());
  if (form.elements.repeat) form.elements.repeat.value = "once";
  if (id === "task-dialog" || id === "reminder-dialog") updateRepeatFields(id.replace("-dialog", ""));
  if (id === "habit-dialog") { updateHabitCategoryFields(); document.getElementById("habit-interval-wrap").hidden = true; }
  setDialogMode(dialog, id.replace("-dialog", ""), null);
  return dialog;
}

function openDialog(id, presetDate) {
  const dialog = prepareDialog(id);
  const form = dialog.querySelector("form");
  if (presetDate) {
    if (form.elements.date) form.elements.date.value = presetDate;
    if (form.elements.startDate) form.elements.startDate.value = presetDate;
    if (form.elements.countStartDate) form.elements.countStartDate.value = presetDate;
    if (id === "task-dialog" || id === "reminder-dialog") updateRepeatFields(id.replace("-dialog", ""));
  }
  dialog.showModal();
  const firstInput = form.querySelector("input");
  if (firstInput) firstInput.focus();
}

function openEditDialog(type, id) {
  const item = findItem(type, id);
  if (!item) return;
  const dialog = prepareDialog(ITEM_META[type].dialog), form = dialog.querySelector("form"), f = form.elements;
  if (type === "task" || type === "reminder") {
    f.title.value = item.title;
    if (item.repeat_frequency === "once") {
      const moment = new Date(item.scheduled_at);
      f.date.value = dateKeyInZone(moment); f.time.value = timeKeyInZone(moment);
    } else {
      f.date.value = item.starts_on; f.time.value = String(item.reminder_time || "").slice(0, 5);
    }
    f.repeat.value = item.repeat_frequency;
    updateRepeatFields(type);
    if (item.repeat_frequency === "monthly") f.monthDay.value = item.repeat_month_day;
    f.note.value = item.description || "";
    if (type === "task") f.notify.checked = item.reminder_enabled !== false;
  } else if (type === "goal") {
    f.title.value = item.name; f.target.value = Number(item.target_value); f.unit.value = item.unit;
    f.startDate.value = item.starts_on; f.endDate.value = item.ends_on || "";
    f.notify.checked = item.notify_enabled !== false;
  } else {
    f.title.value = item.name; f.category.value = item.category;
    if (item.category === "quit") {
      const since = new Date(item.quit_started_at || item.current_streak_started_on + "T00:00:00Z");
      f.startDate.value = dateKeyInZone(since); f.startTime.value = timeKeyInZone(since);
      f.notifyMilestones.checked = item.notify_milestones !== false;
    } else {
      f.polarity.value = item.count_polarity; f.targetCount.value = Number(item.target_count);
      if (["vezes", "minutos", "horas"].includes(item.measure_unit)) f.measureUnit.value = item.measure_unit;
      else { f.measureUnit.value = "custom"; f.customUnit.value = item.measure_unit; }
      f.periodUnit.value = item.period_unit; f.periodInterval.value = item.period_interval;
      form.querySelectorAll('[name="scheduleMode"]').forEach((radio) => { radio.checked = radio.value === item.schedule_mode; });
      document.getElementById("habit-interval-wrap").hidden = Number(item.period_interval || 1) === 1;
      form.querySelectorAll('[name="repeatDays"]').forEach((box) => { box.checked = (item.repeat_days || []).map(Number).includes(Number(box.value)); });
      if (item.days_per_week) f.daysPerWeek.value = item.days_per_week;
      f.countStartDate.value = item.started_on;
    }
    updateHabitCategoryFields();
  }
  setDialogMode(dialog, type, item);
  dialog.showModal();
}

function taskRecordFromForm(form) {
  const data = new FormData(form), repeat = String(data.get("repeat") || "once");
  const date = String(data.get("date") || ""), time = String(data.get("time") || "");
  if (!date || !time) { showToast("Escolha o dia e o horário da tarefa."); return null; }
  const record = {
    title: String(data.get("title")).trim(), description: String(data.get("note") || "").trim() || null,
    repeat_frequency: repeat,
    scheduled_at: null, starts_on: null, reminder_time: null, repeat_days: [], repeat_month_day: null
  };
  if (form.elements.notify) record.reminder_enabled = form.elements.notify.checked;
  if (repeat === "once") record.scheduled_at = zonedDateTimeToIso(date, time);
  else {
    record.starts_on = date; record.reminder_time = time;
    if (repeat === "weekly") record.repeat_days = [new Date(date + "T00:00:00Z").getUTCDay()];
    if (repeat === "monthly") record.repeat_month_day = Number(data.get("monthDay") || date.slice(8, 10));
  }
  return record;
}

function goalRecordFromForm(form) {
  const data = new FormData(form);
  const startsOn = String(data.get("startDate") || today), endsOn = String(data.get("endDate") || "") || null;
  if (endsOn && endsOn < startsOn) { showToast("A data final deve ser igual ou posterior à data inicial."); return null; }
  return {
    name: String(data.get("title")).trim(), target_value: Number(data.get("target")), unit: String(data.get("unit")).trim(),
    period: "daily", starts_on: startsOn, ends_on: endsOn, notify_enabled: form.elements.notify.checked
  };
}

function habitRecordFromForm(form, editItem) {
  const data = new FormData(form), category = editItem ? editItem.category : String(data.get("category") || "quit");
  const startDate = String(data.get(category === "quit" ? "startDate" : "countStartDate") || today);
  const record = { name: String(data.get("title")).trim() };
  if (category === "quit") {
    record.quit_started_at = zonedDateTimeToIso(startDate, String(data.get("startTime") || "00:00"));
    record.current_streak_started_on = startDate;
    record.started_on = editItem && editItem.started_on < startDate ? editItem.started_on : startDate;
    record.notify_milestones = form.elements.notifyMilestones.checked;
    if (!editItem) record.notification_interval_days = 5;
  } else {
    const unit = String(data.get("periodUnit") || "day"), measure = String(data.get("measureUnit") || "vezes");
    record.started_on = startDate; record.current_streak_started_on = startDate;
    record.count_polarity = String(data.get("polarity") || "positive");
    record.target_count = Number(data.get("targetCount") || 1);
    record.measure_unit = (measure === "custom" ? String(data.get("customUnit") || "unidades") : measure).trim();
    record.period_unit = unit;
    record.period_interval = Math.max(1, Number(data.get("periodInterval") || 1));
    record.schedule_mode = unit === "day" ? String(data.get("scheduleMode") || "all_days") : "all_days";
    record.repeat_days = record.schedule_mode === "specific_weekdays" ? Array.from(form.querySelectorAll('[name="repeatDays"]:checked')).map((input) => Number(input.value)) : [];
    record.days_per_week = record.schedule_mode === "days_per_week" ? Number(data.get("daysPerWeek")) : null;
    if (record.schedule_mode === "specific_weekdays" && !record.repeat_days.length) { showToast("Selecione pelo menos um dia da semana."); return null; }
  }
  if (!editItem) record.category = category;
  return record;
}

function notificationState(type, item) {
  return type === "task" ? item.reminder_enabled !== false : type === "goal" ? item.notify_enabled !== false : item.notify_milestones !== false;
}

async function toggleItemNotification(type, id) {
  const item = findItem(type, id);
  if (!item) return;
  const on = notificationState(type, item), column = { task: "reminder_enabled", goal: "notify_enabled", habit: "notify_milestones" }[type];
  const ok = await runAction(() => supabaseClient.from(ITEM_META[type].table).update({ [column]: !on }).eq("id", id).eq("user_id", currentUser.id));
  if (ok) showToast(on ? "Notificação desativada." : "Notificação ativada.");
}

async function deleteItem(type, id) {
  const item = findItem(type, id);
  if (!item) return false;
  const name = type === "task" || type === "reminder" ? item.title : item.name;
  const text = {
    task: ["Excluir tarefa?", 'Excluir a tarefa "' + name + '" e seus registros?', "Tarefa removida."],
    goal: ["Excluir meta?", 'Excluir a meta "' + name + '" e seu progresso?', "Meta removida."],
    habit: ["Excluir hábito?", 'Excluir o hábito "' + name + '" e seu histórico?', "Hábito removido."],
    reminder: ["Excluir lembrete?", 'Excluir o lembrete "' + name + '"?', "Lembrete removido."]
  }[type];
  if (!await confirmInSite({ title: text[0], message: text[1], accept: "Excluir", danger: true })) return false;
  const ok = await runAction(() => supabaseClient.from(ITEM_META[type].table).delete().eq("id", id).eq("user_id", currentUser.id));
  if (ok) showToast(text[2]);
  return ok;
}

let siteMenuActions = [];
function hideSiteMenu() {
  const menu = document.getElementById("site-menu");
  if (!menu) return;
  menu.hidden = true; menu.innerHTML = ""; siteMenuActions = [];
}

function showSiteMenu(x, y, items, label) {
  const menu = document.getElementById("site-menu");
  siteMenuActions = items.map((item) => item.run);
  menu.setAttribute("aria-label", label || "Menu");
  menu.innerHTML = items.map((item, index) => '<button type="button" role="menuitem" class="site-menu-item' + (item.danger ? " danger" : "") + '" data-menu-index="' + index + '">' + escapeHtml(item.label) + "</button>").join("");
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + "px";
  const first = menu.querySelector("button");
  if (first) first.focus({ preventScroll: true });
}

function itemMenuItems(type, id) {
  const item = findItem(type, id);
  const items = [{ label: "Configurações", run: () => openEditDialog(type, id) }];
  if (item && type !== "reminder" && (type !== "habit" || item.category === "quit")) {
    items.push({ label: notificationState(type, item) ? "Desativar Notificação" : "Ativar Notificação", run: () => toggleItemNotification(type, id) });
  }
  items.push({ label: "Excluir", danger: true, run: () => deleteItem(type, id) });
  return items;
}

function openAddMenu(date, anchor) {
  const box = anchor.getBoundingClientRect();
  showSiteMenu(box.left, box.bottom + 6, [
    { label: "Criar tarefa", run: () => openDialog("task-dialog", date) },
    { label: "Criar meta", run: () => openDialog("goal-dialog", date) },
    { label: "Criar hábito", run: () => openDialog("habit-dialog", date) },
    { label: "Criar lembrete", run: () => openDialog("reminder-dialog", date) }
  ], "Adicionar ao dia");
}

function switchView(name) {
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "view-" + name));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  currentView = name;
  const labels = { hoje: "Visão geral", tarefas: "Tarefas", metas: "Metas", habitos: "Hábitos", lembretes: "Lembretes", calendario: "Calendário" };
  document.getElementById("breadcrumb-current").textContent = labels[name] || labels.hoje;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function discordIdentity(user = currentUser) {
  if (!user) return {};
  const identity = (user.identities || []).find((item) => item.provider === "discord") || {};
  const metadata = identity.identity_data || user.user_metadata || {};
  const id = String(identity.provider_id || metadata.provider_id || metadata.sub || metadata.id || "");
  const username = metadata.global_name || metadata.full_name || metadata.name || metadata.username || metadata.user_name || metadata.preferred_username || "Discord";
  const handle = metadata.username || metadata.user_name || metadata.preferred_username || username;
  let avatar = metadata.avatar_url || metadata.picture || "";
  if (!avatar && id && metadata.avatar) avatar = "https://cdn.discordapp.com/avatars/" + encodeURIComponent(id) + "/" + encodeURIComponent(metadata.avatar) + ".png";
  if (!/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(avatar)) avatar = "";
  return { id, username: String(username), handle: String(handle), avatar };
}

function updateDiscordProfile() {
  if (!currentUser) return;
  const discord = discordIdentity(), name = discord.username || "Discord";
  document.getElementById("profile-name").textContent = name;
  document.getElementById("profile-username").textContent = "@" + (discord.handle || name);
  const avatar = document.getElementById("profile-avatar");
  if (discord.avatar) avatar.src = discord.avatar; else avatar.removeAttribute("src");
  avatar.alt = "Foto de " + name;
  const accountAvatar = document.getElementById("account-avatar");
  if (discord.avatar) accountAvatar.src = discord.avatar; else accountAvatar.removeAttribute("src");
  document.getElementById("account-display-name").textContent = name;
  document.getElementById("account-username").textContent = "@" + (discord.handle || name);
  document.getElementById("account-discord-id").textContent = discord.id || state.settings?.discord_user_id || "Não disponível";
  document.getElementById("account-email").textContent = currentUser.email || "Não compartilhado pelo Discord";
  const created = currentUser.created_at ? new Date(currentUser.created_at) : null;
  document.getElementById("account-created-at").textContent = created && !Number.isNaN(created.getTime())
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(created) : "Não disponível";
}

function setSignedOut() {
  currentUser = null;
  state = { tasks: [], reminders: [], goals: [], habits: [], checkins: [], progress: [], countEntries: [], resets: [], settings: null };
  document.getElementById("app-shell").hidden = true;
  document.getElementById("auth-screen").hidden = false;
}

function showAuthMessage(text) {
  document.getElementById("auth-message").textContent = text || "";
  document.getElementById("discord-login").disabled = false;
}

async function rejectSession(message) {
  try { await supabaseClient.auth.signOut(); } catch (error) { console.error("Erro ao encerrar sessão:", error); }
  setSignedOut();
  showAuthMessage(message);
}

function activateUser(user) {
  if (activation && activationUserId === user.id) return activation;
  if (currentUser && currentUser.id === user.id && !document.getElementById("app-shell").hidden) {
    currentUser = user;
    return Promise.resolve(true);
  }
  activationUserId = user.id;
  activation = prepareUser(user).finally(() => { activation = null; activationUserId = null; });
  return activation;
}

async function prepareUser(user) {
  const discord = discordIdentity(user);
  if (!discord.id || !/^\d{17,20}$/.test(discord.id)) {
    await rejectSession("Esta sessão não veio do Discord. Entre com sua conta do Discord para usar o Ritmo.");
    return false;
  }
  try {
    const created = await supabaseClient.from("ritmo").upsert({
      user_id: user.id, discord_user_id: discord.id,
      discord_linked_at: new Date().toISOString(), timezone: "America/Sao_Paulo"
    }, { onConflict: "user_id", ignoreDuplicates: true });
    if (created.error) throw created.error;
    const { data: profile, error: profileError } = await supabaseClient.from("ritmo").select("discord_user_id,discord_linked_at").eq("user_id", user.id).single();
    if (profileError) throw profileError;
    if (profile.discord_user_id !== discord.id || !profile.discord_linked_at) {
      const linked = await supabaseClient.from("ritmo").update({
        discord_user_id: discord.id, discord_linked_at: new Date().toISOString(), discord_setup_notified_at: null
      }).eq("user_id", user.id);
      if (linked.error) throw linked.error;
    }
    currentUser = user;
    await loadData();
    document.getElementById("auth-screen").hidden = true;
    document.getElementById("app-shell").hidden = false;
    document.getElementById("auth-message").textContent = "";
    updateDiscordProfile();
    return true;
  } catch (error) {
    console.error("Não foi possível preparar a conta do Ritmo:", error);
    await rejectSession("Não foi possível preparar sua conta: " + (error.message || "erro desconhecido") + ". Tente entrar novamente.");
    return false;
  }
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
  document.getElementById("discord-login").addEventListener("click", async () => {
    const message = document.getElementById("auth-message"), button = document.getElementById("discord-login");
    button.disabled = true; message.textContent = "Conectando ao Discord...";
    try {
      const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: "discord", options: { redirectTo: window.location.href.split("#")[0], scopes: "identify email" }
      });
      if (error) throw error;
    } catch (error) { message.textContent = error.message || "Não foi possível iniciar o login com Discord."; button.disabled = false; }
  });

  document.getElementById("confirm-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const wrap = document.getElementById("confirm-input-wrap");
    settleConfirmation(wrap.hidden ? true : document.getElementById("confirm-input").value);
  });
  document.getElementById("confirm-cancel").addEventListener("click", () => settleConfirmation(null));
  document.getElementById("confirm-dialog").addEventListener("cancel", (event) => { event.preventDefault(); settleConfirmation(null); });
  document.getElementById("settings-open").addEventListener("click", () => {
    const form = document.getElementById("settings-form"), settings = state.settings || {};
    form.elements.notificationsEnabled.checked = settings.discord_notifications_enabled !== false;
    form.elements.notifyHabitMilestones.checked = settings.notify_habit_milestones !== false;
    form.elements.notifyGoals.checked = settings.notify_goals !== false;
    form.elements.notifyTasks.checked = settings.notify_tasks !== false;
    form.elements.summaryEnabled.checked = !!settings.daily_summary_enabled;
    form.elements.timezone.value = settings.timezone || "America/Sao_Paulo";
    form.elements.summaryTime.value = String(settings.daily_summary_time || "21:00").slice(0, 5);
    document.querySelector('[data-settings-tab="notifications"]').click();
    setNotificationControls(false); updateDiscordProfile();
    document.getElementById("settings-dialog").showModal();
  });

  document.getElementById("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, timezone = String(form.elements.timezone.value || "").trim();
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
    catch { showToast("Informe um fuso válido, por exemplo America/Sao_Paulo."); return; }
    const enabled = form.elements.notificationsEnabled.checked;
    const { error } = await supabaseClient.from("ritmo").update({
      discord_notifications_enabled: enabled,
      notify_habit_milestones: enabled && form.elements.notifyHabitMilestones.checked,
      notify_goals: enabled && form.elements.notifyGoals.checked,
      notify_tasks: enabled && form.elements.notifyTasks.checked,
      daily_summary_enabled: enabled && form.elements.summaryEnabled.checked,
      daily_summary_time: form.elements.summaryTime.value || "21:00", timezone
    }).eq("user_id", currentUser.id);
    if (error) { showToast(error.message); return; }
    document.getElementById("settings-dialog").close(); await refreshData(); showToast("Preferências de notificações salvas.");
  });

  document.getElementById("settings-close").addEventListener("click", () => document.getElementById("settings-dialog").close());
  document.querySelectorAll("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => {
    const account = button.dataset.settingsTab === "account";
    document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
      const selected = tab === button; tab.classList.toggle("active", selected); tab.setAttribute("aria-selected", String(selected));
    });
    const notifications = document.getElementById("settings-notifications"), accountPanel = document.getElementById("settings-account");
    notifications.hidden = account; notifications.classList.toggle("active", !account);
    accountPanel.hidden = !account; accountPanel.classList.toggle("active", account);
    if (account) updateDiscordProfile();
  }));
  document.getElementById("settings-form").elements.notificationsEnabled.addEventListener("change", () => setNotificationControls(true));
  document.getElementById("account-logout").addEventListener("click", async () => {
    if (!await confirmInSite({ title:"Fazer logout?", message:"Você sairá do Ritmo neste dispositivo. Seus dados serão mantidos.", accept:"Fazer logout" })) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) showToast(error.message); else { document.getElementById("settings-dialog").close(); setSignedOut(); }
  });
  document.getElementById("account-delete").addEventListener("click", async () => {
    if (!await confirmInSite({ title:"Excluir sua conta?", message:"Essa ação apaga permanentemente sua conta Ritmo e todas as tarefas, metas, hábitos e registros associados.", accept:"Excluir conta", danger:true })) return;
    const { error } = await supabaseClient.rpc("delete_ritmo_account");
    if (error) { showToast(error.message || "Não foi possível excluir a conta."); return; }
    await supabaseClient.auth.signOut(); document.getElementById("settings-dialog").close(); setSignedOut(); showToast("Conta e dados excluídos.");
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

    if (action === "edit-item") {
      openEditDialog(actionButton.dataset.itemType, id);
      return;
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

    if (action === "increment-habit") {
      const habit=state.habits.find((item)=>item.id===id);
      const raw=await inputInSite("Registrar atividade","Quanto deseja registrar?","Informe a quantidade em "+(habit&&habit.measure_unit||"unidades")+".");
      if(raw===null)return;
      const amount=Number(raw.replace(",",".").trim());
      if(!Number.isFinite(amount)||amount<=0){showToast("Informe um valor maior que zero.");return;}
      const ok=await runAction(()=>supabaseClient.from("habit_count_entries").insert({habit_id:id,user_id:owner,entry_date:today,amount}));
      if(ok)showToast("Registro de hábito adicionado.");
    }

    if (action === "reset-habit") {
      const habit = state.habits.find((item) => item.id === id);
      if (habit && await confirmInSite({title:"Reiniciar contagem?",message:'Reiniciar a contagem de "' + habit.name + '" hoje? O histórico anterior será mantido.',accept:"Reiniciar"})) {
        const result = await supabaseClient.rpc("reset_quit_habit", {
          p_habit_id: id, p_reset_at: new Date().toISOString(), p_note: null
        });
        if (result.error) showToast(result.error.message);
        else {
          await refreshData();
          showToast("Contagem reiniciada. Seu histórico foi mantido.");
        }
      }
    }
  });

  document.getElementById("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, dialog = form.closest("dialog"), editId = dialog.dataset.editId;
    const record = taskRecordFromForm(form);
    if (!record) return;
    const ok = await runAction(() => editId
      ? supabaseClient.from("tasks").update(record).eq("id", editId).eq("user_id", currentUser.id)
      : supabaseClient.from("tasks").insert({ ...record, user_id: currentUser.id }));
    if (ok) {
      dialog.close();
      focusTaskDay(record.repeat_frequency === "once" ? dateKeyInZone(new Date(record.scheduled_at)) : record.starts_on);
      renderTaskDay();
      if (!editId && currentView !== "calendario") switchView("tarefas");
      showToast(editId ? "Tarefa atualizada." : "Tarefa adicionada.");
    }
  });

  document.getElementById("goal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, dialog = form.closest("dialog"), editId = dialog.dataset.editId;
    const record = goalRecordFromForm(form);
    if (!record) return;
    const ok = await runAction(() => editId
      ? supabaseClient.from("goals").update(record).eq("id", editId).eq("user_id", currentUser.id)
      : supabaseClient.from("goals").insert({ ...record, user_id: currentUser.id }));
    if (ok) {
      dialog.close();
      if (!editId && currentView !== "calendario") switchView("metas");
      showToast(editId ? "Meta atualizada." : "Meta criada.");
    }
  });

  document.getElementById("habit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, dialog = form.closest("dialog"), editId = dialog.dataset.editId;
    const editItem = editId ? findItem("habit", editId) : null;
    const record = habitRecordFromForm(form, editItem);
    if (!record) return;
    const ok = await runAction(() => editId
      ? supabaseClient.from("habits").update(record).eq("id", editId).eq("user_id", currentUser.id)
      : supabaseClient.from("habits").insert({ ...record, user_id: currentUser.id }));
    if (ok) {
      dialog.close();
      if (!editId && currentView !== "calendario") switchView("habitos");
      showToast(editId ? "Hábito atualizado." : "Hábito adicionado.");
    }
  });

  document.getElementById("reminder-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, dialog = form.closest("dialog"), editId = dialog.dataset.editId;
    const record = taskRecordFromForm(form);
    if (!record) return;
    const ok = await runAction(() => editId
      ? supabaseClient.from("reminders").update(record).eq("id", editId).eq("user_id", currentUser.id)
      : supabaseClient.from("reminders").insert({ ...record, user_id: currentUser.id }));
    if (ok) {
      dialog.close();
      focusPickerDay("reminder", record.repeat_frequency === "once" ? dateKeyInZone(new Date(record.scheduled_at)) : record.starts_on);
      renderReminderDay();
      if (!editId && currentView !== "calendario") switchView("lembretes");
      showToast(editId ? "Lembrete atualizado." : "Lembrete criado.");
    }
  });

  document.querySelectorAll("[data-dialog-delete]").forEach((button) => button.addEventListener("click", async () => {
    const dialog = button.closest("dialog"), type = dialog.id.replace("-dialog", "");
    if (dialog.dataset.editId && await deleteItem(type, dialog.dataset.editId)) dialog.close();
  }));

  ["task", "reminder"].forEach((kind) => {
    const picker = dayPickers[kind], redraw = () => (kind === "task" ? renderTaskDay() : renderReminderDay());
    document.getElementById(kind + "-day-prev").addEventListener("click", () => { picker.start = offsetDateFrom(picker.start || today, -1); redraw(); });
    document.getElementById(kind + "-day-next").addEventListener("click", () => { picker.start = offsetDateFrom(picker.start || today, 1); redraw(); });
    document.getElementById(kind + "-day-days").addEventListener("click", (event) => {
      const day = event.target.closest("[data-day]");
      if (day) { picker.selected = day.dataset.day; redraw(); }
    });
    document.getElementById(kind + "-today-jump").addEventListener("click", () => { picker.selected = today; picker.start = offsetDateFrom(today, -1); redraw(); });
    document.getElementById(kind + "-day-calendar").addEventListener("click", () => {
      selectedCalendarDate = picker.selected || today;
      calendarCursor = selectedCalendarDate.slice(0, 7) + "-01";
      renderCalendar(); switchView("calendario");
    });
  });

  const siteMenu = document.getElementById("site-menu");
  siteMenu.addEventListener("click", (event) => {
    const entry = event.target.closest("[data-menu-index]");
    if (!entry) return;
    const run = siteMenuActions[Number(entry.dataset.menuIndex)];
    hideSiteMenu();
    if (run) run();
  });
  document.addEventListener("click", (event) => { if (!event.target.closest("#site-menu")) hideSiteMenu(); }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideSiteMenu(); });
  window.addEventListener("resize", hideSiteMenu);
  window.addEventListener("scroll", hideSiteMenu, true);
  document.addEventListener("contextmenu", (event) => {
    const target = event.target.closest("[data-item-type][data-id]");
    if (!target || !currentUser || document.querySelector("dialog[open]")) { hideSiteMenu(); return; }
    event.preventDefault();
    showSiteMenu(event.clientX, event.clientY, itemMenuItems(target.dataset.itemType, target.dataset.id), "Opções da atividade");
  });

  document.getElementById("quick-add").addEventListener("click", () => openDialog("task-dialog"));
  document.getElementById("task-repeat").addEventListener("change", updateTaskRepeatFields);
  document.querySelector('#task-form [name="date"]').addEventListener("change", updateTaskRepeatFields);
  document.getElementById("reminder-repeat").addEventListener("change", () => updateRepeatFields("reminder"));
  document.querySelector('#reminder-form [name="date"]').addEventListener("change", () => updateRepeatFields("reminder"));
  document.getElementById("habit-category").addEventListener("change", updateHabitCategoryFields);
  document.getElementById("habit-period-unit").addEventListener("change", updateHabitPeriodFields);
  document.getElementById("habit-measure-unit").addEventListener("change", updateHabitMeasureFields);
  document.getElementById("habit-schedule-wrap").addEventListener("change", updateHabitScheduleFields);
  document.getElementById("habit-polarity").addEventListener("change", updatePolarityPhrase);
  document.querySelectorAll("[data-dialog-cancel]").forEach((button)=>button.addEventListener("click",()=>requestDialogClose(button.closest("dialog"))));
  document.querySelectorAll("#task-dialog,#goal-dialog,#habit-dialog").forEach((dialog)=>dialog.addEventListener("cancel",(event)=>{event.preventDefault();requestDialogClose(dialog);}));
  const calendarGrid = document.getElementById("calendar-grid");
  calendarGrid.addEventListener("click", (event) => {
    const add = event.target.closest("[data-calendar-add]");
    if (add) { openAddMenu(add.dataset.calendarAdd, add); return; }
    const day = event.target.closest("[data-calendar-date]");
    if (day) { selectedCalendarDate = day.dataset.calendarDate; renderCalendar(); }
  });
  calendarGrid.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-calendar-date]")) {
      event.preventDefault(); selectedCalendarDate = event.target.dataset.calendarDate; renderCalendar();
      const again = calendarGrid.querySelector('[data-calendar-date="' + selectedCalendarDate + '"]'); if (again) again.focus();
    }
  });
  document.getElementById("calendar-add").addEventListener("click", (event) => openAddMenu(selectedCalendarDate || today, event.currentTarget));
  document.getElementById("calendar-selected-details").addEventListener("toggle", (event) => {
    const group = event.target.closest("details[data-group]");
    if (group) calendarGroupOpen[group.dataset.group] = group.open;
  }, true);
  document.querySelectorAll("[data-calendar-shift]").forEach((button) => button.addEventListener("click", () => {
    const date = dateFromKey(calendarCursor); date.setUTCMonth(date.getUTCMonth() + Number(button.dataset.calendarShift));
    calendarCursor = date.toISOString().slice(0, 7) + "-01"; renderCalendar();
  }));
}

async function initialize() {
  document.getElementById("auth-message").textContent = initialOAuthError ? "Não foi possível entrar com o Discord: " + initialOAuthError : "";
  const secure = window.isSecureContext || ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!secure) {
    document.getElementById("discord-login").hidden = true;
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

function setSectionDisabled(id,disabled){
 const section=document.getElementById(id);section.hidden=disabled;
 section.querySelectorAll("input,select,textarea").forEach((field)=>{field.disabled=disabled;});
}
function updateRepeatFields(prefix){
 const repeat=document.getElementById(prefix+"-repeat").value,wrap=document.getElementById(prefix+"-month-day-wrap"),input=wrap.querySelector("input");
 wrap.hidden=repeat!=="monthly";
 if(repeat==="monthly"){const date=document.querySelector("#"+prefix+'-form [name="date"]').value;if(date)input.value=Number(date.slice(8,10));}
}
function updateTaskRepeatFields(){updateRepeatFields("task");}
function updatePolarityPhrase(){
 const negative=document.getElementById("habit-polarity").value==="negative";
 document.getElementById("habit-polarity-phrase").textContent=negative?"Menos de":"Pelo menos";
}
function updateHabitCategoryFields(){
 const count=document.getElementById("habit-category").value==="count";
 setSectionDisabled("quit-habit-fields",count);setSectionDisabled("count-habit-fields",!count);
 updateHabitPeriodFields();updateHabitMeasureFields();updatePolarityPhrase();
}
function updateHabitPeriodFields(){
 const daily=document.getElementById("habit-period-unit").value==="day";
 setSectionDisabled("habit-schedule-wrap",!daily);updateHabitScheduleFields();
}
function updateHabitScheduleFields(){
 const checked=document.querySelector('#habit-form [name="scheduleMode"]:checked'),mode=checked?checked.value:"all_days";
 setSectionDisabled("habit-weekdays-wrap",mode!=="specific_weekdays");
 setSectionDisabled("habit-days-per-week-wrap",mode!=="days_per_week");
}
function updateHabitMeasureFields(){
 const custom=document.getElementById("habit-measure-unit").value==="custom";
 setSectionDisabled("custom-unit-wrap",!custom);
}
let confirmResolver = null;
function setNotificationControls(changed) {
  const form = document.getElementById("settings-form");
  const enabled = form.elements.notificationsEnabled.checked;
  const options = ["notifyHabitMilestones","notifyGoals","notifyTasks","summaryEnabled"];
  if (changed && enabled && options.every((name) => !form.elements[name].checked)) {
    options.forEach((name) => { form.elements[name].checked = true; });
  }
  options.forEach((name) => {
    const input = form.elements[name];
    if (!enabled) input.checked = false;
    input.disabled = !enabled;
  });
  form.elements.summaryTime.disabled = !enabled;
  document.getElementById("notification-options").classList.toggle("disabled", !enabled);
}

function confirmInSite(options = {}) {
  const dialog = document.getElementById("confirm-dialog");
  const form = document.getElementById("confirm-form");
  document.getElementById("confirm-title").textContent = options.title || "Confirmar ação?";
  document.getElementById("confirm-message").textContent = options.message || "";
  const accept = document.getElementById("confirm-accept");
  accept.textContent = options.accept || "Confirmar";
  accept.classList.toggle("danger-button", !!options.danger);
  accept.classList.toggle("primary-button", !options.danger);
  const wrap = document.getElementById("confirm-input-wrap");
  wrap.hidden = !options.inputLabel;
  if (options.inputLabel) {
    document.getElementById("confirm-input-label").textContent = options.inputLabel;
    document.getElementById("confirm-input").value = "1";
  }
  return new Promise((resolve) => {
    confirmResolver = resolve;
    dialog.showModal();
    if (options.inputLabel) document.getElementById("confirm-input").focus();
    else accept.focus();
  });
}

function settleConfirmation(value) {
  if (confirmResolver) confirmResolver(value);
  confirmResolver = null;
  const dialog = document.getElementById("confirm-dialog");
  if (dialog.open) dialog.close();
}

function inputInSite(title, message, inputLabel) {
  return confirmInSite({ title, message, inputLabel, accept: "Registrar" });
}

async function requestDialogClose(dialog){if(await confirmInSite({title:"Cancelar alterações?",message:"Quer mesmo fechar? As informações preenchidas serão descartadas.",accept:"Descartar",danger:true})){const form=dialog.querySelector("form");if(form)form.reset();dialog.close();}}
document.addEventListener("DOMContentLoaded", initialize);
