const config = window.RITMO_SUPABASE_CONFIG;
const supabaseClient = window.supabase.createClient(config.url, config.publishableKey);
const STORAGE_KEY = "ritmo-prototype-v1";
let currentUser = null;
let state = { tasks: [], goals: [], habits: [], checkins: [], progress: [], countEntries: [], resets: [], settings: null };
let toastTimer;
let today = "";
let calendarCursor = null;
let selectedCalendarDate = null;

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
    (featured ? "" : '<div class="goal-card-top"><div class="goal-card-icon">◎</div><div><div class="goal-card-title">' + escapeHtml(goal.name) + '</div><div class="goal-card-sub">Meta diária · ' + target + " " + escapeHtml(goal.unit) + '</div><div class="goal-card-sub">Válida de ' + escapeHtml(formatDate(goal.starts_on)) + (goal.ends_on ? ' até ' + escapeHtml(formatDate(goal.ends_on)) : ' · sem data final') + '</div></div><span class="card-spacer"></span><button class="delete-button" data-action="delete-goal" data-id="' + goal.id + '" aria-label="Excluir meta">×</button></div>') +
    (featured ? '<div class="goal-feature-title">' + escapeHtml(goal.name) + '</div><div class="goal-feature-sub">Sua meta é ' + target + " " + escapeHtml(goal.unit) + " por dia.</div>" : "") +
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
    return '<article class="habit-card"><div class="habit-card-top"><div class="habit-card-icon">↻</div><div><div class="habit-card-title">'+escapeHtml(habit.name)+'</div><div class="habit-card-sub">Contagem · '+(negative?"negativa":"positiva")+'</div></div><span class="card-spacer"></span><button class="delete-button" data-action="delete-habit" data-id="'+habit.id+'" aria-label="Excluir hábito">×</button></div>'+
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
  return '<article class="habit-card"><div class="habit-card-top"><div class="habit-card-icon">✳</div><div><div class="habit-card-title">'+escapeHtml(habit.name)+'</div><div class="habit-card-sub">'+escapeHtml(subtitle)+'</div></div><span class="card-spacer"></span><button class="delete-button" data-action="delete-habit" data-id="'+habit.id+'" aria-label="Excluir hábito">×</button></div>'+
  '<div class="habit-days-row"><div class="habit-days">'+elapsed+"<span>"+(elapsed===1?"dia":"dias")+'</span></div><span class="milestone-tag">'+(isMilestoneToday?"Marco de "+previous.label+" ✦":"Próximo marco: "+next.label)+'</span></div><div class="milestone-track"><span style="width:'+progress+'%"></span></div><div class="habit-card-footer"><span>O histórico continua guardado ao recomeçar.</span><button class="reset-button" data-action="reset-habit" data-id="'+habit.id+'">↻ Reiniciar</button></div></article>';
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

function upcomingPreviewMarkup() {
  const all=occurrencesBetween(today,offsetDate(35)).filter((event)=>event.date>=today);
  const events=all.slice(0,3),monthly=all.find((event)=>event.task.repeat_frequency==="monthly");
  if(monthly&&!events.some((event)=>event.id===monthly.id&&event.date===monthly.date))events.push(monthly);
  events.sort((a,b)=>(a.date+(a.time||"99:99")).localeCompare(b.date+(b.time||"99:99")));
  return events.length?events.slice(0,4).map((event)=>'<div class="preview-row"><span class="preview-date">'+escapeHtml(event.date===today?"Hoje":formatDate(event.date))+'</span><div><strong>'+escapeHtml(event.title)+'</strong><small>'+escapeHtml(event.task.repeat_frequency==="monthly"?"Tarefa mensal · ":"") + escapeHtml(event.time||"Sem horário")+'</small></div></div>').join(""):emptyState("Sem tarefas próximas","Tarefas futuras aparecerão aqui.");
}
function calendarDurationEntries(date) {
  const goals=state.goals.filter((item)=>item.starts_on<=date&&(!item.ends_on||item.ends_on>=date)).map((item)=>({kind:"goal",label:"Meta · "+item.name}));
  const habits=state.habits.filter((item)=>(item.started_on||today)<=date).map((item)=>({kind:"habit",label:(item.category==="quit"?"Parar · ":"Contagem · ")+item.name}));
  const resets=(state.resets||[]).filter((item)=>item.reset_on===date).map((item)=>({kind:"reset",label:"Recomeço · "+(state.habits.find((habit)=>habit.id===item.habit_id)||{}).name}));
  return goals.concat(habits,resets);
}
function renderCalendar() {
  const grid=document.getElementById("calendar-grid");if(!grid)return;
  if(!calendarCursor)calendarCursor=today.slice(0,7)+"-01";if(!selectedCalendarDate)selectedCalendarDate=today;
  const monthStart=dateFromKey(calendarCursor),offset=(monthStart.getUTCDay()+6)%7,gridStart=offsetDateFrom(calendarCursor,-offset),gridEnd=offsetDateFrom(gridStart,41),occurrences=occurrencesBetween(gridStart,gridEnd);
  const heading=new Intl.DateTimeFormat("pt-BR",{month:"long",year:"numeric",timeZone:"UTC"}).format(monthStart);
  document.getElementById("calendar-month-label").textContent=heading.charAt(0).toUpperCase()+heading.slice(1);
  let output=["Seg","Ter","Qua","Qui","Sex","Sáb","Dom"].map((day)=>'<div class="calendar-weekday">'+day+'</div>').join("");
  for(let i=0;i<42;i+=1){
    const date=offsetDateFrom(gridStart,i),tasks=occurrences.filter((event)=>event.date===date),spans=calendarDurationEntries(date);
    const chips=tasks.slice(0,2).map((event)=>'<span class="calendar-chip task-chip">'+escapeHtml(event.time||"")+' '+escapeHtml(event.title)+'</span>').concat(spans.slice(0,Math.max(0,3-Math.min(2,tasks.length))).map((event)=>'<span class="calendar-chip '+event.kind+'-chip">'+escapeHtml(event.label)+'</span>'));
    output+='<button type="button" class="calendar-day '+(date.slice(0,7)!==calendarCursor.slice(0,7)?"outside-month ":"")+(date===today?"is-today ":"")+(date===selectedCalendarDate?"is-selected":"")+'" data-calendar-date="'+date+'"><span class="calendar-day-number">'+Number(date.slice(8,10))+'</span><span class="calendar-day-events">'+(chips.join("")||'<span class="calendar-no-events">—</span>')+'</span></button>';
  }
  grid.innerHTML=output;
  const dayEvents=occurrences.filter((event)=>event.date===selectedCalendarDate),spans=calendarDurationEntries(selectedCalendarDate);
  const taskDetails=dayEvents.length?dayEvents.map((event)=>'<div class="calendar-detail-row"><span class="calendar-detail-icon">◷</span><div><strong>'+escapeHtml(event.title)+'</strong><small>'+escapeHtml(event.time||"Sem horário")+(event.note?" · "+escapeHtml(event.note):"")+'</small></div><span class="calendar-detail-type">Tarefa</span></div>').join(""):emptyState("Nenhuma tarefa","Nada agendado para este dia.");
  const spanDetails=spans.map((event)=>'<div class="calendar-detail-row"><span class="calendar-detail-icon">'+(event.kind==="goal"?"◎":"✳")+'</span><div><strong>'+escapeHtml(event.label.replace(/^(Meta|Parar|Contagem) · /,""))+'</strong><small>Ativa nesta data</small></div><span class="calendar-detail-type">'+(event.kind==="goal"?"Meta":"Hábito")+'</span></div>').join("");
  document.getElementById("calendar-selected-label").textContent=formatDate(selectedCalendarDate,{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  document.getElementById("calendar-selected-details").innerHTML=taskDetails+spanDetails;
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
    supabaseClient.from("habit_resets").select("*").eq("user_id", owner).order("reset_on", { ascending: false }),
    supabaseClient.from("habit_count_entries").select("*").eq("user_id", owner).order("entry_date", { ascending: false })
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
  if (form.elements.countStartDate) form.elements.countStartDate.value = today;
  if (form.elements.startTime) form.elements.startTime.value = timeKeyInZone(new Date());
  if (form.elements.repeat) form.elements.repeat.value = "once";
  if (id === "task-dialog") updateTaskRepeatFields();
  if (id === "habit-dialog") updateHabitCategoryFields();
  dialog.showModal();
  const firstInput = form.querySelector("input");
  if (firstInput) firstInput.focus();
}

function switchView(name) {
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "view-" + name));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  const labels = { hoje: "Visão geral", tarefas: "Tarefas", metas: "Metas", habitos: "Hábitos", calendario: "Calendário" };
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
  state = { tasks: [], goals: [], habits: [], checkins: [], progress: [], countEntries: [], resets: [], settings: null };
  document.getElementById("app-shell").hidden = true;
  document.getElementById("auth-screen").hidden = false;
}

async function activateUser(user) {
  currentUser = user;
  const discord = discordIdentity(user);
  document.getElementById("auth-screen").hidden = true;
  document.getElementById("app-shell").hidden = false;
  try {
    if (!discord.id || !/^\d{17,20}$/.test(discord.id)) throw new Error("Não foi possível identificar sua conta do Discord. Saia e entre novamente.");
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
    await refreshData(); updateDiscordProfile();
  } catch (error) {
    console.error("Não foi possível preparar a conta do Ritmo:", error);
    showToast(error.message || "Não foi possível preparar sua conta.");
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
    const form = document.getElementById("settings-form");
    form.elements.notificationsEnabled.checked = !!state.settings.discord_notifications_enabled;
    form.elements.notifyHabitMilestones.checked = !!state.settings.notify_habit_milestones;
    form.elements.notifyGoals.checked = !!state.settings.notify_goals;
    form.elements.notifyTasks.checked = !!state.settings.notify_tasks;
    form.elements.summaryEnabled.checked = !!state.settings.daily_summary_enabled;
    form.elements.timezone.value = state.settings.timezone || "America/Sao_Paulo";
    form.elements.summaryTime.value = String(state.settings.daily_summary_time || "21:00").slice(0, 5);
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

    if (action === "delete-task") {
      const task = state.tasks.find((item) => item.id === id);
      if (task && await confirmInSite({ title:"Excluir tarefa?", message:'Excluir a tarefa "' + task.title + '" e seus registros?', accept:"Excluir", danger:true })) {
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
      if (goal && await confirmInSite({ title:"Excluir meta?", message:'Excluir a meta "' + goal.name + '" e seu progresso?', accept:"Excluir", danger:true })) {
        const ok = await runAction(() => supabaseClient.from("goals").delete().eq("id", id).eq("user_id", owner));
        if (ok) showToast("Meta removida.");
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

    if (action === "delete-habit") {
      const habit = state.habits.find((item) => item.id === id);
      if (habit && await confirmInSite({ title:"Excluir hábito?", message:'Excluir o hábito "' + habit.name + '" e seu histórico?', accept:"Excluir", danger:true })) {
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
      if (repeat === "monthly") record.repeat_month_day = Number(data.get("monthDay") || date.slice(8, 10));
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
    const startsOn=String(data.get("startDate")||today),endsOn=String(data.get("endDate")||"")||null;
    if(endsOn&&endsOn<startsOn){showToast("A data final deve ser igual ou posterior à data inicial.");return;}
    const record = {
      user_id: currentUser.id,
      name: String(data.get("title")).trim(),
      target_value: Number(data.get("target")),
      unit: String(data.get("unit")).trim(),
      period: "daily",
      starts_on: startsOn,
      ends_on: endsOn
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
    const form=event.currentTarget,data=new FormData(form),category=String(data.get("category")||"quit");
    const startDate=String(data.get(category==="quit"?"startDate":"countStartDate")||today);
    const record={user_id:currentUser.id,name:String(data.get("title")).trim(),category,started_on:startDate,current_streak_started_on:startDate};
    if(category==="quit"){
      record.quit_started_at=zonedDateTimeToIso(startDate,String(data.get("startTime")||"00:00"));
      record.notify_milestones=form.elements.notifyMilestones.checked;
      record.notification_interval_days=5;
    }else{
      const unit=String(data.get("periodUnit")||"day"),measure=String(data.get("measureUnit")||"vezes");
      record.count_polarity=String(data.get("polarity")||"positive");
      record.target_count=Number(data.get("targetCount")||1);
      record.measure_unit=(measure==="custom"?String(data.get("customUnit")||"unidades"):measure).trim();
      record.period_unit=unit;
      record.period_interval=Math.max(1,Number(data.get("periodInterval")||1));
      record.schedule_mode=unit==="day"?String(data.get("scheduleMode")||"all_days"):"all_days";
      record.repeat_days=record.schedule_mode==="specific_weekdays"?Array.from(form.querySelectorAll('[name="repeatDays"]:checked')).map((input)=>Number(input.value)):[];
      record.days_per_week=record.schedule_mode==="days_per_week"?Number(data.get("daysPerWeek")):null;
      if(record.schedule_mode==="specific_weekdays"&&!record.repeat_days.length){showToast("Selecione pelo menos um dia da semana.");return;}
    }
    const ok=await runAction(()=>supabaseClient.from("habits").insert(record));
    if(ok){form.closest("dialog").close();switchView("habitos");showToast("Hábito adicionado.");}
  });

  document.getElementById("quick-add").addEventListener("click", () => openDialog("task-dialog"));
  document.getElementById("task-repeat").addEventListener("change", updateTaskRepeatFields);
  document.querySelector('#task-form [name="date"]').addEventListener("change", updateTaskRepeatFields);
  document.getElementById("habit-category").addEventListener("change", updateHabitCategoryFields);
  document.getElementById("habit-period-unit").addEventListener("change", updateHabitPeriodFields);
  document.getElementById("habit-measure-unit").addEventListener("change", updateHabitMeasureFields);
  document.getElementById("habit-schedule-mode").addEventListener("change", updateHabitScheduleFields);
  document.querySelectorAll("[data-dialog-cancel]").forEach((button)=>button.addEventListener("click",()=>requestDialogClose(button.closest("dialog"))));
  document.querySelectorAll("#task-dialog,#goal-dialog,#habit-dialog").forEach((dialog)=>dialog.addEventListener("cancel",(event)=>{event.preventDefault();requestDialogClose(dialog);}));
  document.getElementById("calendar-grid").addEventListener("click",(event)=>{
    const day=event.target.closest("[data-calendar-date]");
    if(day){selectedCalendarDate=day.dataset.calendarDate;renderCalendar();}
  });
  document.querySelectorAll("[data-calendar-shift]").forEach((button)=>button.addEventListener("click",()=>{
    const date=dateFromKey(calendarCursor);date.setUTCMonth(date.getUTCMonth()+Number(button.dataset.calendarShift));calendarCursor=date.toISOString().slice(0,7)+"-01";renderCalendar();
  }));
}

async function initialize() {
  document.getElementById("auth-message").textContent = "";
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
function updateTaskRepeatFields(){
 const repeat=document.getElementById("task-repeat").value,wrap=document.getElementById("task-month-day-wrap"),input=wrap.querySelector("input");
 wrap.hidden=repeat!=="monthly";
 if(repeat==="monthly"){const date=document.querySelector('#task-form [name="date"]').value;if(date)input.value=Number(date.slice(8,10));}
}
function updateHabitCategoryFields(){
 const count=document.getElementById("habit-category").value==="count";
 setSectionDisabled("quit-habit-fields",count);setSectionDisabled("count-habit-fields",!count);
 updateHabitPeriodFields();updateHabitMeasureFields();
}
function updateHabitPeriodFields(){
 const daily=document.getElementById("habit-period-unit").value==="day";
 setSectionDisabled("habit-schedule-wrap",!daily);updateHabitScheduleFields();
}
function updateHabitScheduleFields(){
 const mode=document.getElementById("habit-schedule-mode").value;
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

function requestDialogClose(dialog){if(await confirmInSite({title:"Cancelar alterações?",message:"Quer mesmo fechar? As informações preenchidas serão descartadas.",accept:"Descartar",danger:true})){const form=dialog.querySelector("form");if(form)form.reset();dialog.close();}}
document.addEventListener("DOMContentLoaded", initialize);
