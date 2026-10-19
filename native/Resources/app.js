/* WLSAPlus native interface. Original implementation; no runtime dependencies. */
(function (root) {
  'use strict';

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ACCENTS = [
    ['Teal', '#00677a'], ['Red', '#b9363e'], ['Orange', '#bd5b12'], ['Yellow', '#8c710c'],
    ['Green', '#287a50'], ['Blue', '#315fbc'], ['Purple', '#7754ae'], ['Pink', '#b43d82'], ['Rose', '#ad4b63']
  ];
  const ACCENT_NAMES = ['default','red','orange','yellow','green','blue','purple','pink','rose'];
  const TODO_ICONS = ['✓', '📚', '📝', '🎯', '💡', '🔔', '🏃', '⭐'];
  const LANGUAGES = [['en','English'],['zh-Hans','Chinese (Simplified)'],['zh-Hant','Chinese (Traditional)'],['es','Spanish'],['fr','French'],['de','German'],['ja','Japanese'],['ko','Korean'],['ru','Russian'],['ar','Arabic'],['pt','Portuguese'],['it','Italian']];
  const ICONS = {
    up: '<path d="m5 15 7-7 7 7"/>',
    down: '<path d="m5 9 7 7 7-7"/>',
    minus: '<path d="M5 12h14"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-13 4h2m4 0h2m-8 3h2"/>',
    progress: '<path d="M4 4v16h17M8 15l4-5 4 2 5-7"/>',
    forum: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 1-7a8 8 0 0 1-1-4 9 9 0 0 1 19 0Z"/><path d="M7 10h10m-10 4h6"/>',
    tools: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    settings: '<path d="m9 3-.7 3-2 1.2L3.4 7l-1.5 3L4 12l-2.1 2 1.5 3 2.9-.2 2 1.2.7 3h6l.7-3 2-1.2 2.9.2 1.5-3-2.1-2 2.1-2-1.5-3-2.9.2-2-1.2L15 3Z"/><circle cx="12" cy="12" r="3"/>',
    sync: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    left: '<path d="m15 5-7 7 7 7"/>',
    right: '<path d="m9 5 7 7-7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
    book: '<path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
    assignment: '<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4V2h6v2M9 9h6m-6 4h6m-6 4h4"/>',
    shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z"/><path d="m8 12 3 3 5-6"/>',
    translate: '<path d="M2 5h12M8 2v3m4 0c-1 6-4 10-9 12m1-9c1 4 4 7 8 9m1 5 5-14 5 14m-8-4h6"/>',
    map: '<path d="m2 5 7-3 6 3 7-3v17l-7 3-6-3-7 3Zm7-3v17m6-14v17"/>',
    todo: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    swap: '<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3m-10 0 1 15h12l1-15M10 10v7m4-7v7"/>',
    edit: '<path d="m15 4 5 5M4 20l4-1L21 6l-5-5L3 14 2 21Z"/>',
    external: '<path d="M14 3h7v7m0-7L10 14m1-11H3v18h18v-8"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5"/>',
    wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r="1"/>',
    lock: '<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    logout: '<path d="M9 3H3v18h6m5-15 6 6-6 6m-6-6h12"/>',
    attendance: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 12-5m1 4 3 3 5-7"/>'
  };

  function h(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function icon(name, cls) { return `<svg${cls ? ` class="${h(cls)}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`; }
  function errorText(error) { return error instanceof Error ? error.message : typeof error === 'object' && error ? String(error.message || error.error || 'The request failed.') : String(error || 'The request failed.'); }
  function createNativeBridge(transport, timeout = 120000) {
    let counter = 0;
    const pending = new Map();
    return {
      call(method, args = {}) {
        return new Promise((resolve, reject) => {
          if (!/^[a-z]+(?:\.[a-z]+)*$/i.test(method)) { reject(new Error('Invalid native method.')); return; }
          const id = `wlsa-${Date.now()}-${++counter}`;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('The native service did not respond. Please try again.')); }, timeout);
          pending.set(id, {resolve, reject, timer});
          try { transport({id, method, args}); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      },
      reply(message) {
        if (!message || !pending.has(message.id)) return false;
        const job = pending.get(message.id);
        clearTimeout(job.timer); pending.delete(message.id);
        if (message.error != null && message.error !== '') job.reject(new Error(errorText(message.error)));
        else job.resolve(message.result);
        return true;
      },
      cancelAll(message = 'The request was cancelled.') {
        for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(message)); }
        pending.clear();
      },
      get pendingCount() { return pending.size; }
    };
  }
  function isNativeAvailable() { return typeof root.webkit?.messageHandlers?.wlsaplus?.postMessage === 'function'; }
  const bridge = createNativeBridge(message => {
    if (!isNativeAvailable()) throw new Error('The native Mac service is unavailable in this browser preview. Open WLSAPlus.app to use this feature.');
    root.webkit.messageHandlers.wlsaplus.postMessage(message);
  });
  function native(method, args) { return bridge.call(method, args); }
  root.nativeReply = message => bridge.reply(message);

  function parseDate(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
    if (!value || typeof value !== 'string') return null;
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const date = dateOnly ? new Date(+dateOnly[1], +dateOnly[2]-1, +dateOnly[3]) : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    if (dateOnly && (date.getFullYear() !== +dateOnly[1] || date.getMonth() !== +dateOnly[2]-1 || date.getDate() !== +dateOnly[3])) return null;
    return date;
  }
  function dateKey(value) {
    const date = parseDate(value);
    return date ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` : '';
  }
  function formatDate(value, options = {}) { const date = parseDate(value); return date ? new Intl.DateTimeFormat('en', {month:'short',day:'numeric',...options}).format(date) : 'Not provided'; }
  function formatTime(value) {
    if (typeof value === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) {
      const [hour, minute] = value.split(':').map(Number);
      if (hour > 23 || minute > 59) return 'Not provided';
      return `${hour % 12 || 12}:${String(minute).padStart(2,'0')} ${hour < 12 ? 'AM' : 'PM'}`;
    }
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat('en', {hour:'numeric',minute:'2-digit'}).format(date) : 'Not provided';
  }
  function format24(value) {
    const date=parseDate(value);
    return date?new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false}).format(date):'Not provided';
  }
  function currentAndNext(items, value) {
    const now=parseDate(value);if(!now)return {current:null,next:null,following:null};
    const scheduled=items.filter(item=>{const start=parseDate(item.start),end=parseDate(item.end);return start && end && end>start;}).sort((a,b)=>parseDate(a.start)-parseDate(b.start));
    const current=scheduled.find(item=>parseDate(item.start)<=now && parseDate(item.end)>now) || null;
    const future=scheduled.filter(item=>parseDate(item.start)>now);
    return {current,next:future[0] || null,following:future[1] || null};
  }
  function addDays(value, count) { const date = parseDate(value); if (!date) return null; date.setDate(date.getDate()+count); return date; }
  function weekDates(value) { const date = parseDate(value); if (!date) return []; const monday = addDays(date, -((date.getDay()+6)%7)); return Array.from({length:5}, (_,i) => addDays(monday,i)); }
  function dayMatches(day, date) {
    if (Array.isArray(day)) return day.some(item => dayMatches(item, date));
    if (typeof day === 'number' || /^\d$/.test(String(day))) return +day === (date.getDay() || 7);
    return String(day || '').split(/[,;|]/).some(item => item.trim().toLowerCase().slice(0,3) === DAY_NAMES[date.getDay()].slice(0,3).toLowerCase());
  }
  function scheduleForDate(items, value) {
    const day = parseDate(value); if (!day) return [];
    return (Array.isArray(items) ? items : []).filter(item => {
      const start = parseDate(item.start);
      if (start) return dateKey(start) === dateKey(day);
      return /^\d{1,2}:\d{2}/.test(String(item.start)) && dayMatches(item.day ?? item.days, day);
    }).sort((a,b) => {
      const minutes = item => { const parsed=parseDate(item.start); if (parsed) return parsed.getHours()*60+parsed.getMinutes(); const parts=String(item.start || '').split(':').map(Number); return parts[0]*60+parts[1]; };
      return minutes(a)-minutes(b);
    });
  }
  function unplacedSchedule(items) { return items.filter(item => !parseDate(item.start) && !(item.day != null || item.days != null)); }
  function scoreText(item) { const score = item.score; const total = item.total; return score != null && score !== '' ? `${score}${total != null && total !== '' ? ` / ${total}` : ''}` : 'Not graded'; }
  function percentage(value) { if (value == null || value === '') return null; const num = Number(String(value).replace(/%$/, '')); return Number.isFinite(num) ? num : null; }
  function dueDescription(value, now = new Date()) {
    const date = parseDate(value); if (!date) return {text:'No due date',kind:''};
    const today = new Date(now.getFullYear(),now.getMonth(),now.getDate());
    const target = new Date(date.getFullYear(),date.getMonth(),date.getDate());
    const delta = Math.round((target - today)/86400000);
    return {text:delta === 0 ? 'Today' : delta === 1 ? 'Tomorrow' : formatDate(date),kind:delta < 0 ? 'past' : delta === 0 ? 'today' : ''};
  }
  function normalizeTodo(item) {
    if (!item || typeof item !== 'object') throw new Error('Invalid to-do.');
    const title = String(item.title ?? item.text ?? '').trim();
    if (!title) throw new Error('Enter a title for your to-do.');
    if (title.length > 500) throw new Error('Keep the to-do title under 500 characters.');
    const details = String(item.details ?? '');
    if (details.length > 20000) throw new Error('Keep to-do details under 20,000 characters.');
    const endAt = item.endAt || item.due || '';
    if (endAt && !parseDate(endAt)) throw new Error('Choose a valid date and time.');
    return {
      id:String(item.id || (root.crypto?.randomUUID?.() || `todo-${Date.now()}-${Math.random().toString(36).slice(2,9)}`)),
      title, details, done:Boolean(item.done ?? item.completed), color:/^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : ACCENTS[0][1],
      icon:TODO_ICONS.includes(item.icon) ? item.icon : TODO_ICONS[0], endAt,
      timeType:item.timeType === 'time' ? 'time' : 'deadline', createdAt:item.createdAt || new Date().toISOString()
    };
  }
  function toggleTodo(items, id) { return items.map(item => item.id === id ? {...item,done:!item.done} : {...item}); }
  function filterTodos(items, filter) { return items.filter(item => filter === 'active' ? !item.done : filter === 'completed' ? item.done : true); }
  function moveTodo(items, id, direction, filter = 'all') {
    const visible = filterTodos(items, filter), current = visible.findIndex(item => String(item.id) === String(id));
    const neighbor = current + (direction === 'up' ? -1 : 1);
    if (current < 0 || neighbor < 0 || neighbor >= visible.length) return items.map(item=>({...item}));
    const result = items.map(item=>({...item})), first = result.findIndex(item=>String(item.id)===String(id)), second = result.findIndex(item=>String(item.id)===String(visible[neighbor].id));
    [result[first],result[second]]=[result[second],result[first]];
    return result;
  }
  function timelineEvents(snapshot, todos, startValue, hours) {
    const start = parseDate(startValue); if (!start || !Number.isFinite(hours) || hours <= 0) return [];
    const finish = start.getTime() + hours * 3600000, events = [];
    for (const item of snapshot.schedule || []) {
      const begins = parseDate(item.start), ends = parseDate(item.end);
      if (begins && ends && ends > begins && begins.getTime() < finish && ends > start) events.push({id:`class-${item.id}`,kind:'class',title:item.title || item.name || 'Class',start:begins,end:ends,detail:[item.room,item.teacher].filter(Boolean).join(' · ')});
    }
    for (const todo of todos) {
      const at = parseDate(todo.endAt || todo.due);
      if (!todo.done && at && at >= start && at.getTime() < finish) events.push({id:`todo-${todo.id}`,kind:'todo',title:todo.title,start:at,end:at,detail:todo.timeType==='time'?'Scheduled to-do':'To-do deadline'});
    }
    for (const item of snapshot.assignments || []) {
      const at = parseDate(item.due);
      if (at && at >= start && at.getTime() < finish) events.push({id:`assignment-${item.id}`,kind:'assignment',title:item.title || 'Assignment',start:at,end:at,detail:[item.course, /^\d{4}-\d{2}-\d{2}$/.test(item.due)?'Due date · time not provided':'Assignment deadline'].filter(Boolean).join(' · '),dateOnly:/^\d{4}-\d{2}-\d{2}$/.test(item.due)});
    }
    return events.sort((a,b)=>a.start-b.start);
  }
  function validateSchoolURL(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch (_) { throw new Error('Enter a complete PowerSchool address, beginning with https://.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use your school’s secure https:// PowerSchool address.');
    return url.href;
  }
  function normalizeState(value = {}) {
    const snapshot = value.snapshot || {};
    return {
      ...value, version:String(value.version || ''), appearance:['system','light','dark'].includes(value.appearance) ? value.appearance : 'system',
      accent:ACCENTS.some(([,color]) => color === value.accent) ? value.accent : ACCENTS[Math.max(0,ACCENT_NAMES.indexOf(value.accent))][1],
      reminders:value.reminders !== false, autostart:Boolean(value.autostart), tuningEnabled:Boolean(value.tuningEnabled), tunedTime:value.tunedTime || '',
      school:{baseURL:String(value.school?.baseURL || ''),username:String(value.school?.username || ''),connected:value.school?.connected===true}, snapshot:{...snapshot,courses:Array.isArray(snapshot.courses)?snapshot.courses:[],assignments:Array.isArray(snapshot.assignments)?snapshot.assignments:[],attendance:Array.isArray(snapshot.attendance)?snapshot.attendance:[],schedule:Array.isArray(snapshot.schedule)?snapshot.schedule:[]},
      todos:Array.isArray(value.todos) ? value.todos : [], vpn:value.vpn || {}, update:value.update || {}, notice:value.notice || null
    };
  }

  const api = {createNativeBridge,native,bridge,h,parseDate,dateKey,formatDate,formatTime,format24,currentAndNext,addDays,weekDates,dayMatches,scheduleForDate,unplacedSchedule,scoreText,percentage,dueDescription,normalizeTodo,toggleTodo,filterTodos,moveTodo,timelineEvents,validateSchoolURL,normalizeState,ACCENTS,TODO_ICONS};
  root.WLSA = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  let app = normalizeState();
  const ui = {page:'home',tool:'',scheduleMode:'day',date:new Date(),progressTab:'grades',query:'',courseFilter:'all',todoFilter:'all',quickTitle:'',roomQuery:'',tunedInput:'',nodes:[],selectedNode:'',translation:{from:'auto',to:'en',input:'',output:'',detected:''},pending:new Set(),dismissedNotice:'',vpnCheck:'',vpnError:'',updateLog:'',loadError:'',mapResult:null,timelineHours:72,timelineStart:''};
  let toastTimer;
  const $ = selector => document.querySelector(selector);
  const busy = key => ui.pending.has(key);
  function btn(label, action, options = {}) { return `<button type="button" class="button${options.primary?' primary':''}${options.danger?' danger':''}${options.subtle?' subtle':''}${options.iconOnly?' icon-button':''}" data-action="${h(action)}"${options.value!=null?` data-value="${h(options.value)}"`:''}${options.disabled?' disabled':''}${options.iconOnly?` aria-label="${h(label)}" title="${h(label)}"`:''}>${options.icon?icon(options.icon):''}${options.iconOnly?'':h(label)}</button>`; }
  function empty(symbol,title,text,action = '') { return `<div class="empty-state"><div class="empty-icon">${icon(symbol)}</div><h3>${h(title)}</h3><p>${h(text)}</p>${action}</div>`; }
  function heading(title,subtitle,action = '') { return `<div class="page-heading"><div><h1>${h(title)}</h1><p class="subtitle">${h(subtitle)}</p></div>${action}</div>`; }
  function badge(text,type = '') { return `<span class="badge ${h(type)}">${h(text)}</span>`; }
  function toast(message, isError = false) { const node = $('#toast'); node.textContent = String(message); node.className = `toast${isError?' error':''}`; node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 7000 : 4500); }
  function announce(message) { $('#announcer').textContent = message; }
  function referenceNow() { return app.tuningEnabled && parseDate(app.tunedTime) ? parseDate(app.tunedTime) : new Date(); }
  function accountExists() { return Boolean(app.school.username); }
  function applyAppearance() {
    const dark = app.appearance === 'dark' || (app.appearance === 'system' && root.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--accent', app.accent);
    const rgb = app.accent.slice(1).match(/.{2}/g).map(value => parseInt(value,16));
    document.documentElement.style.setProperty('--accent-rgb', rgb.join(','));
  }
  function setEnvironment(message) { const node = $('#environment-banner'); node.textContent = message; node.hidden = !message; }
  function renderChrome() {
    applyAppearance();
    const nav = [['home','home','Home'],['schedule','calendar','Schedule'],['progress','progress','Progress'],['forum','forum','Forum'],['tools','tools','Tools'],['settings','settings','Settings']];
    $('#navigation').innerHTML = nav.map(([page,symbol,label]) => `<a href="#${page}" class="nav-link"${ui.page === page?' aria-current="page"':''} title="${label}">${icon(symbol)}<span class="nav-label">${label}</span></a>`).join('');
    $('#breadcrumb').textContent = nav.find(item => item[0] === ui.page)?.[2] || 'Home';
    $('.local-indicator').innerHTML = isNativeAvailable() ? '<span></span> Saved on your Mac' : '<span></span> Browser preview';
    $('#version').textContent = `WLSAPlus${app.version ? ` · ${app.version}` : ''}`;
    $('#sync-button').innerHTML = busy('sync') ? '<span class="spinner"></span>' : icon('sync');
    $('#sync-button').disabled = busy('sync') || !accountExists();
    $('#sync-label').textContent = app.snapshot.syncedAt ? `Synced ${formatDate(app.snapshot.syncedAt)} · ${formatTime(app.snapshot.syncedAt)}` : 'PowerSchool not synced';
    $('#account-button').innerHTML = icon('user');
    $('#account-button').title = accountExists() ? app.school.username : 'Connect PowerSchool';
    const notice = app.notice;
    const showNotice = notice && (notice.title || notice.content) && notice.id !== ui.dismissedNotice;
    $('#notice').hidden = !showNotice;
    $('#notice').innerHTML = showNotice ? `<div class="notice">${icon(notice.type === 'warning'?'bell':'info','inline-icon')}<div class="notice-body"><div class="notice-title">${h(notice.title || 'Notice')}</div><p>${h(notice.content || '')}</p></div><button class="notice-dismiss" data-action="dismiss-notice" aria-label="Dismiss notice">${icon('close')}</button></div>` : '';
  }
  function render() {
    const active = document.activeElement;
    const inputState = active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName) && active.id && !active.closest('dialog') ? {id:active.id,start:active.selectionStart,end:active.selectionEnd} : null;
    renderChrome();
    const views = {home:homeView,schedule:scheduleView,progress:progressView,forum:forumView,tools:toolsView,settings:settingsView};
    $('#view').innerHTML = (views[ui.page] || homeView)();
    $('#view').setAttribute('aria-busy', 'false');
    if (inputState) { const field = document.getElementById(inputState.id); if (field) { field.focus({preventScroll:true}); if (inputState.start != null && field.setSelectionRange && field.type !== 'date') { try { field.setSelectionRange(inputState.start,inputState.end); } catch (_) {} } } }
  }
  function classList(items) { return items.map(item => `<div class="schedule-item"><div class="schedule-time"><strong>${h(formatTime(item.start))}</strong><br>${h(formatTime(item.end))}</div><div class="schedule-detail"><h3>${h(item.title || item.name || 'Untitled class')}</h3><p>${[item.room ? `${icon('pin','inline-icon')}${h(item.room)}` : '',item.teacher ? h(item.teacher) : ''].filter(Boolean).join(' · ')}</p></div></div>`).join(''); }
  function assignmentsList(items) { return items.map(item => `<div class="list-item"><div class="mini-icon">${icon('assignment')}</div><div class="list-body"><h3>${h(item.title || 'Untitled assignment')}</h3><p>${h(item.course || 'Course not provided')}</p></div>${badge(dueDescription(item.due,referenceNow()).text, dueDescription(item.due,referenceNow()).kind === 'today' ? 'accent' : '')}</div>`).join(''); }
  function homeView() {
    const now = referenceNow(), today = scheduleForDate(app.snapshot.schedule,now);
    const assignments = app.snapshot.assignments.filter(item => parseDate(item.due)).sort((a,b) => parseDate(a.due)-parseDate(b.due));
    const dueToday = assignments.filter(item => dateKey(item.due) === dateKey(now));
    const nextDue = assignments.filter(item => dateKey(item.due) >= dateKey(now)).slice(0,4);
    const todos = app.todos.filter(item => !item.done).slice(0,3);
    const welcome = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
    return heading(welcome,formatDate(now,{weekday:'long',year:'numeric'}),btn('Sync PowerSchool','sync',{icon:'sync',disabled:busy('sync') || !accountExists()})) +
      (app.tuningEnabled ? `<div class="info-box">${icon('clock','inline-icon')}Display time is set to ${h(formatDate(now,{year:'numeric'}))}, ${h(formatTime(now))}. Notifications use the actual time.</div>` : '') +
      (currentAndNext(app.snapshot.schedule,now).current || currentAndNext(app.snapshot.schedule,now).next ? currentClassView(now) : `<section class="hero"><div><p class="eyebrow">YOUR SCHOOL, CONNECTED</p><h2>${accountExists()?'Your school day, at a glance.':'Make room for a better school day.'}</h2><p>${accountExists()?'Your timetable, assignments and campus essentials, together in one place. Your last sync stays available offline.':'Connect PowerSchool to bring your classes, grades and attendance into your workspace.'}</p>${accountExists()?btn('View schedule','navigate',{value:'schedule',icon:'calendar'}):btn('Connect PowerSchool','account',{primary:true,icon:'plus'})}</div><div class="hero-icon">${icon('calendar')}</div></section>`) +
      `<div class="stats-grid"><div class="card stat-card"><div class="stat-icon">${icon('calendar')}</div><div><div class="stat-number">${today.length}</div><div class="stat-label">Classes today</div></div></div><div class="card stat-card"><div class="stat-icon">${icon('assignment')}</div><div><div class="stat-number">${dueToday.length}</div><div class="stat-label">Assignments due today</div></div></div><div class="card stat-card"><div class="stat-icon">${icon('todo')}</div><div><div class="stat-number">${app.todos.filter(item=>!item.done).length}</div><div class="stat-label">To-dos remaining</div></div></div></div>` +
      timelineView() + `<div class="two-columns"><section class="card"><div class="card-header"><h2>Today's schedule</h2><button class="link-button" data-action="navigate" data-value="schedule">View all ${icon('right')}</button></div>${today.length?classList(today):empty('calendar','No classes to show',accountExists()?'There are no synced classes for this date.':'Your classes will appear after you connect PowerSchool.')}</section><div class="stack"><section class="card"><div class="card-header"><h2>Upcoming assignments</h2><button class="link-button" data-action="progress-assignments">View all ${icon('right')}</button></div>${nextDue.length?assignmentsList(nextDue):empty('assignment','Nothing coming up','Upcoming dated assignments from PowerSchool appear here.')}</section><section class="card"><div class="card-header"><h2>Your to-dos</h2><button class="link-button" data-action="open-tool" data-value="todos">View all ${icon('right')}</button></div>${todos.length?todos.map(todo=>`<div class="list-item"><label class="todo-checkbox"><input type="checkbox" data-todo-toggle="${h(todo.id)}" aria-label="Complete ${h(todo.title)}"${busy('todos')?' disabled':''}></label><div class="list-body"><h3>${h(todo.title)}</h3>${todo.endAt?`<p>${h(formatDate(todo.endAt))}</p>`:''}</div></div>`).join(''):empty('todo','A little space to plan','Add a to-do for anything you want to remember.',btn('Add a to-do','new-todo',{subtle:true,icon:'plus'}))}</section></div></div>`;
  }
  function currentClassView(now) {
    const classes=currentAndNext(app.snapshot.schedule,now), focus=classes.current || classes.next, next=classes.current?classes.next:classes.following;
    if(!focus)return '';
    const start=parseDate(focus.start),end=parseDate(focus.end),isCurrent=Boolean(classes.current),remaining=Math.max(0,Math.ceil(((isCurrent?end:start)-now)/60000));
    const progress=isCurrent?Math.max(0,Math.min(100,(now-start)/(end-start)*100)):0;
    const countdown=remaining<60?`${remaining}`:remaining<1440?`${Math.floor(remaining/60)}h ${remaining%60}m`:`${Math.floor(remaining/1440)}d ${Math.floor(remaining%1440/60)}h`;
    return `<section class="hero current-class-card"><div class="class-overview-main"><div class="class-overview-content"><div><p class="eyebrow">${isCurrent?'CURRENT CLASS':'NEXT CLASS'}</p><h2>${h(focus.title || focus.name || 'Class')}</h2><div class="class-overview-meta"><span>${icon('clock')}${h(format24(start))} – ${h(format24(end))}</span>${dateKey(start)!==dateKey(now)?`<span>${icon('calendar')}${h(formatDate(start,{weekday:'short'}))}</span>`:''}${focus.room?`<button type="button" class="link-button" data-action="find-room" data-value="${h(focus.room)}">${icon('pin')}${h(focus.room)}</button>`:''}${focus.teacher?`<span>${icon('user')}${h(focus.teacher)}</span>`:''}</div></div><div class="class-countdown"><strong>${h(countdown)}</strong><span>${isCurrent?(remaining<60?'minutes remaining':'remaining'):(remaining<60?'minutes until class':'until class')}</span></div></div>${isCurrent?`<div class="class-progress" role="progressbar" aria-label="Class progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${progress}%"></span></div>`:`<p class="class-next-note">${dateKey(start)===dateKey(now)?'A little time before your next class.':'Your next synchronized class.'}</p>`}${next?`<div class="next-class-row"><span class="small muted">${isCurrent?'Up next':'After that'}</span><strong>${h(next.title || next.name || 'Class')}</strong><span>${h(format24(next.start))} – ${h(format24(next.end))}${dateKey(next.start)!==dateKey(now)?` · ${h(formatDate(next.start))}`:''}</span>${next.room?`<button type="button" class="link-button" data-action="find-room" data-value="${h(next.room)}">${icon('pin')}${h(next.room)}</button>`:''}</div>`:''}</div></section>`;
  }
  function timelineView() {
    const initial=referenceNow();initial.setHours(0,0,0,0);
    const start=parseDate(ui.timelineStart) || initial, hours=ui.timelineHours, end=new Date(start.getTime()+hours*3600000);
    const events=timelineEvents(app.snapshot,app.todos,start,hours), ticks=6;
    const now=referenceNow(), nowPercent=(now-start)/(hours*3600000)*100;
    const label=event=>`${formatDate(event.start)}${event.dateOnly?'':` · ${formatTime(event.start)}`}${event.kind==='class'?` – ${formatTime(event.end)}`:''}`;
    return `<section class="card timeline-card"><div class="card-header"><div><h2>Planning timeline</h2><p class="small muted no-margin">Classes, assignments and your to-do deadlines.</p></div><div class="button-row">${btn('Previous timeline window','timeline-previous',{icon:'left',iconOnly:true})}${btn('Now','timeline-now')}${btn('Next timeline window','timeline-next',{icon:'right',iconOnly:true})}<span class="timeline-control-divider"></span>${btn('Zoom in','timeline-zoom-in',{icon:'plus',iconOnly:true,disabled:hours<=6})}${btn('Zoom out','timeline-zoom-out',{icon:'minus',iconOnly:true,disabled:hours>=168})}</div></div><div class="timeline-range">${h(formatDate(start,{year:'numeric'}))}, ${h(formatTime(start))} – ${h(formatDate(end,{year:'numeric'}))}, ${h(formatTime(end))}<span>${hours} hours</span></div>${events.length?`<div class="timeline-scroll" tabindex="0" role="region" aria-label="Planning timeline, scroll horizontally for details"><div class="timeline"><div class="timeline-axis"><div class="timeline-label muted">${events.length} ${events.length===1?'event':'events'}</div><div class="timeline-track">${Array.from({length:ticks+1},(_,index)=>{const at=new Date(start.getTime()+hours*3600000*index/ticks);return `<span class="timeline-tick" style="left:${index/ticks*100}%">${h(formatDate(at))}<br>${h(formatTime(at))}</span>`;}).join('')}</div></div>${events.map(event=>{const left=Math.max(0,(event.start-start)/(hours*3600000)*100),width=Math.max(.8,Math.min(100,((event.end-start)/(hours*3600000)*100))-left);return `<div class="timeline-row"><div class="timeline-label"><span class="timeline-event-kind">${icon(event.kind==='class'?'calendar':event.kind==='todo'?'todo':'assignment')}${h(event.kind==='class'?'Class':event.kind==='todo'?'To-do':'Assignment')}</span><strong>${h(event.title)}</strong><span>${h(label(event))}</span><span>${h(event.detail)}</span></div><div class="timeline-track" title="${h(event.title)} · ${h(label(event))}"><div class="timeline-bar ${event.kind}" style="left:${left}%;width:${width}%">${event.kind==='class'?'<span></span>':icon(event.kind==='todo'?'todo':'assignment')}</div>${nowPercent>=0&&nowPercent<=100?`<div class="timeline-now" style="left:${nowPercent}%" aria-label="Current display time"></div>`:''}</div></div>`;}).join('')}</div></div>`:empty('clock','A little room in your timeline','No dated classes, assignments or active to-dos fall in this window. Add a to-do deadline, sync PowerSchool, or move to another date.')}<p class="inline-note no-margin" style="margin-top:14px">${icon('calendar','inline-icon')} Classes <span class="timeline-legend-space">${icon('todo','inline-icon')} To-do deadlines</span> <span class="timeline-legend-space">${icon('assignment','inline-icon')} Assignments</span> · Dates without a time appear at the start of that day.</p></section>`;
  }
  function scheduleView() {
    const dayItems = scheduleForDate(app.snapshot.schedule,ui.date), unplaced = unplacedSchedule(app.snapshot.schedule);
    const dates = weekDates(ui.date);
    return heading('Schedule','A little structure for your school day.',btn('Sync schedule','sync',{icon:'sync',disabled:busy('sync') || !accountExists()})) +
      `<div class="section-toolbar"><div class="date-controls">${btn('Previous','previous-date',{icon:'left',iconOnly:true})}<span class="date-label">${ui.scheduleMode==='week'?`${h(formatDate(dates[0]))} – ${h(formatDate(dates[4],{year:'numeric'}))}`:h(formatDate(ui.date,{weekday:'long',year:'numeric'}))}</span>${btn('Next','next-date',{icon:'right',iconOnly:true})}${btn('Today','today')}</div><div class="segmented" role="tablist" aria-label="Schedule view"><button role="tab" aria-selected="${ui.scheduleMode==='day'}" data-action="schedule-mode" data-value="day">Day</button><button role="tab" aria-selected="${ui.scheduleMode==='week'}" data-action="schedule-mode" data-value="week">Week</button></div></div>` +
      (!app.snapshot.schedule.length ? `<section class="card">${empty('calendar','Your schedule starts here','Connect PowerSchool or sync your account to see your timetable.',btn(accountExists()?'Sync PowerSchool':'Connect PowerSchool',accountExists()?'sync':'account',{primary:true,icon:'calendar',disabled:busy('sync')}))}</section>` : ui.scheduleMode==='week' ? `<div class="schedule-week">${dates.map(date=>`<section class="day-column${dateKey(date)===dateKey(referenceNow())?' today':''}"><div class="day-heading">${h(formatDate(date,{weekday:'short',month:undefined,day:undefined}))}<strong>${date.getDate()}</strong></div>${scheduleForDate(app.snapshot.schedule,date).length?scheduleForDate(app.snapshot.schedule,date).map(item=>`<div class="week-class"><p>${h(formatTime(item.start))} – ${h(formatTime(item.end))}</p><h3>${h(item.title || item.name || 'Untitled class')}</h3><p>${h(item.room || 'Room not provided')}${item.teacher?`<br>${h(item.teacher)}`:''}</p>${item.room?`<button class="link-button tiny" data-action="find-room" data-value="${h(item.room)}">Find room</button>`:''}</div>`).join(''):'<p class="week-empty">No classes</p>'}</section>`).join('')}</div>` : `<section class="card schedule-day"><div class="card-header"><h2>${dateKey(ui.date)===dateKey(referenceNow())?'Today’s classes':'Classes'}</h2>${badge(`${dayItems.length} ${dayItems.length===1?'class':'classes'}`)}</div>${dayItems.length?classList(dayItems):empty('calendar','A clear day','No classes were provided by PowerSchool for this date.')}</section>`) +
      (unplaced.length?`<section class="card schedule-unplaced"><div class="card-header"><h2>Classes without a date</h2></div><p class="small muted">PowerSchool did not provide a usable day for these entries.</p>${classList(unplaced)}</section>`:'') +
      `<p class="inline-note">${app.snapshot.syncedAt?`Last synchronized ${h(formatDate(app.snapshot.syncedAt,{year:'numeric'}))} at ${h(formatTime(app.snapshot.syncedAt))}.`:'No synchronized timetable yet.'} ${app.reminders?'Class reminders are enabled; macOS will notify you about five minutes before class.':'Class reminders are off.'}</p>`;
  }
  function progressView() {
    const query = ui.query.toLowerCase();
    const courses = app.snapshot.courses.filter(item => `${item.name} ${item.teacher}`.toLowerCase().includes(query));
    const assignments = app.snapshot.assignments.filter(item => `${item.title} ${item.course}`.toLowerCase().includes(query) && (ui.courseFilter==='all' || item.course===ui.courseFilter));
    const attendance = app.snapshot.attendance.filter(item => `${item.course} ${item.status} ${item.date}`.toLowerCase().includes(query));
    const courseNames = [...new Set(app.snapshot.assignments.map(item=>item.course).filter(Boolean))].sort();
    return heading('Progress','See the details behind your school day.',btn('Sync progress','sync',{icon:'sync',disabled:busy('sync') || !accountExists()})) +
      `<div class="section-toolbar"><div class="segmented" role="tablist" aria-label="Progress section">${[['grades','Grades'],['assignments','Assignments'],['attendance','Attendance']].map(([key,label])=>`<button role="tab" aria-selected="${ui.progressTab===key}" data-action="progress-tab" data-value="${key}">${label}</button>`).join('')}</div><div class="course-filters">${ui.progressTab==='assignments'&&courseNames.length?`<select id="course-filter" aria-label="Filter by course"><option value="all">All courses</option>${courseNames.map(name=>`<option value="${h(name)}"${ui.courseFilter===name?' selected':''}>${h(name)}</option>`).join('')}</select>`:''}<div class="search-field">${icon('search')}<input id="progress-search" type="search" aria-label="Search progress" placeholder="Search ${ui.progressTab}…" value="${h(ui.query)}"></div></div></div>` +
      (ui.progressTab==='grades' ? (courses.length?`<div class="course-grid">${courses.map(course=>{const percent=percentage(course.percent);return `<button class="course-card" data-action="course" data-value="${h(course.id)}"><div class="course-top"><div><h3>${h(course.name || 'Untitled course')}</h3><p>${h(course.teacher || 'Teacher not provided')}</p></div>${icon('right','inline-icon')}</div><div class="grade">${h(course.grade || '—')}</div><div class="grade-meter"><span style="width:${percent==null?0:Math.max(0,Math.min(100,percent))}%"></span></div><div class="course-bottom"><span>${course.room?`${icon('pin','inline-icon')}${h(course.room)}`:'Room not provided'}</span><span class="course-score">${percent!=null?`${h(percent)}%`:'No percentage'}</span></div></button>`;}).join('')}</div>`: `<section class="card">${empty('progress',query?'No matching courses':'Your courses will appear here',query?'Try searching by course or teacher.':'Connect PowerSchool and sync to see your course grades.',query?'':btn(accountExists()?'Sync PowerSchool':'Connect PowerSchool',accountExists()?'sync':'account',{primary:true,disabled:busy('sync')}))}</section>`) :
      ui.progressTab==='assignments' ? `<section class="card table-card">${assignments.length?assignmentTable(assignments):empty('assignment',query?'No matching assignments':'No assignments to show','Assignments and their scores appear after a PowerSchool sync.')}</section>` :
      `<section class="card">${attendance.length?`<div class="attendance-summary">${Object.entries(attendance.reduce((counts,item)=>{const key=item.status || 'Unspecified';counts[key]=(counts[key]||0)+1;return counts;},{})).map(([status,count])=>badge(`${status}: ${count}`)).join('')}</div><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Course</th><th>Status</th></tr></thead><tbody>${attendance.map(item=>`<tr><td class="nowrap">${h(formatDate(item.date,{year:'numeric'}))}</td><td>${h(item.course || 'Not provided')}</td><td>${badge(item.status || 'Not provided')}</td></tr>`).join('')}</tbody></table></div>`:empty('attendance',query?'No matching attendance':'No attendance records','Attendance records from PowerSchool appear here.')}</section>`) +
      '<p class="inline-note">Grades and attendance reflect your last PowerSchool sync. Select a course to view its description, assignments and teacher comments.</p>';
  }
  function assignmentTable(items) { return `<div class="table-wrap"><table class="table"><thead><tr><th>Assignment</th><th>Due</th><th>Score</th></tr></thead><tbody>${items.map(item=>`<tr><td>${h(item.title || 'Untitled assignment')}<div class="cell-subtitle">${h(item.course || '')}</div></td><td class="nowrap">${h(parseDate(item.due)?formatDate(item.due,{year:'numeric'}):'Not provided')}${parseDate(item.due)?`<div class="cell-subtitle">${h(dueDescription(item.due,referenceNow()).kind==='past'?'Due date passed':dueDescription(item.due,referenceNow()).text)}</div>`:''}</td><td class="nowrap course-score">${h(scoreText(item))}</td></tr>`).join('')}</tbody></table></div>`; }
  function forumView() { return heading('Forum','A space for your school community.') + `<section class="card forum-card"><div class="tool-icon">${icon('forum')}</div><h2>Good conversations start here.</h2><p>Explore the WLSAPlus forum, share ideas and see what your school community is talking about. The forum opens inside WLSAPlus.</p>${btn(busy('forum')?'Opening forum…':'Open forum','forum-open',{primary:true,icon:'forum',disabled:busy('forum')})}<div class="forum-facts"><span>${icon('lock')}Separate forum session</span><span>${icon('sun')}Follows your appearance</span><span>${icon('user')}Anonymous posts</span></div><p class="inline-note">${accountExists()?'Your current PowerSchool session can be used to sign in. Your password is not sent to the forum.':'Connect PowerSchool in Settings to enable forum sign-in.'}</p></section>`; }
  function toolsView() {
    if (ui.tool) return toolView();
    return heading('Tools','Small essentials. A little more ease.') + `<div class="tools-grid">${[['vpn','shield','VPN','Choose a node, test latency and manage your connection.','Network'],['translate','translate','Translator','A little help finding the right words, in another language.','Languages'],['map','map','Campus map','Open the campus map and look up a classroom.','Find your way'],['todos','todo','To-dos','Keep track of what you want to get done.','Stay organized']].map(([key,symbol,title,description,tag])=>`<button class="tool-card" data-action="open-tool" data-value="${key}"><div class="tool-icon">${icon(symbol)}</div><div><h2>${title}</h2><p>${description}</p>${badge(tag)}</div>${icon('right','tool-arrow')}</button>`).join('')}</div>`;
  }
  function toolView() {
    const details = {vpn:['VPN','Your connection, in your control.'],translate:['Translator','Make yourself understood.'],map:['Campus map','Find your next classroom.'],todos:['To-dos','One thing at a time.']};
    const detail = details[ui.tool] || details.todos;
    return `<button class="back-link" data-action="tools-back">${icon('back')}All tools</button>` + heading(detail[0],detail[1]) + ({vpn:vpnView,translate:translatorView,map:mapView,todos:todosView}[ui.tool] || todosView)();
  }
  function vpnState() { return String(app.vpn.state || app.vpn.status || 'disconnected').toLowerCase(); }
  function vpnConnected() { return app.vpn.connected === true || ['connected','running'].includes(vpnState()); }
  function vpnView() {
    const connected = vpnConnected(), transitioning = ['connecting','disconnecting','starting','stopping'].includes(vpnState());
    const recoverable = !connected && (app.vpn.cleanupRequired === true || app.vpn.canDisconnect === true), disconnectAction = connected || recoverable;
    const title = connected?'Connected':transitioning?(vpnState().includes('disconnect')||vpnState()==='stopping'?'Disconnecting…':'Connecting…'):'Not connected';
    return `<div class="narrow"><section class="card connection-status"><div class="vpn-emblem${connected?' connected':''}">${icon('shield')}</div><div><h2>${title}</h2><p>${h(app.vpn.message || (connected?app.vpn.nodeName || 'Native VPN is active.':'Choose a node to get started.'))}</p>${connected&&app.vpn.connectedAt?`<p class="tiny">Since ${h(formatTime(app.vpn.connectedAt))}</p>`:''}</div>${btn(recoverable?'Recover network':connected?'Disconnect':busy('vpn-connect')?'Connecting…':'Connect',disconnectAction?'vpn-disconnect':'vpn-connect',{primary:!disconnectAction,icon:disconnectAction?'close':'shield',disabled:transitioning || busy('vpn-connect') || busy('vpn-disconnect') || (!disconnectAction&&!ui.selectedNode)})}</section>${ui.vpnError?`<div class="error-message" role="alert">${h(ui.vpnError)}</div>`:''}<section class="card"><div class="card-header"><h2>Available nodes</h2><div class="button-row">${btn('Test latency','vpn-latency',{icon:'wifi',disabled:busy('vpn-latency') || !ui.nodes.length})}${btn('Refresh nodes','vpn-nodes',{icon:'sync',iconOnly:true,disabled:busy('vpn-nodes')})}</div></div>${busy('vpn-nodes')?'<div class="loading-inline"><span class="spinner"></span>Fetching subscription nodes…</div>':ui.nodes.length?`<div role="radiogroup" aria-label="VPN node">${ui.nodes.map(node=>`<label class="node-row"><input type="radio" name="vpn-node" value="${h(node.id)}"${ui.selectedNode===String(node.id)?' checked':''}${connected||transitioning?' disabled':''}><span class="node-name">${h(node.name || node.id)}${node.region?`<small>${h(node.region)}</small>`:''}</span><span class="node-latency">${node.latency!=null?`${h(node.latency)} ms`:'Not tested'}</span></label>`).join('')}</div>`:empty('wifi','No VPN nodes available','Refresh to load the configured subscription. The native service reports any configuration or connection errors.')}</section><section class="card" style="margin-top:20px"><div class="card-header"><h2>Connection checks</h2></div><p class="small muted">Check whether WeChat is reachable with your current network connection.</p>${btn('Check WeChat','vpn-wechat',{icon:'wifi',disabled:busy('vpn-wechat')})}${ui.vpnCheck?`<p class="inline-note whitespace" role="status">${h(ui.vpnCheck)}</p>`:''}</section><p class="inline-note">A connected status is shown only when the native VPN service confirms it. macOS may request network permissions.</p></div>`;
  }
  function translatorView() {
    const translation = ui.translation;
    const options = selected => LANGUAGES.map(([key,name])=>`<option value="${key}"${selected===key?' selected':''}>${name}</option>`).join('');
    return `<section class="card"><form id="translation-form"><div class="translation-controls"><select id="translation-from" aria-label="Translate from"><option value="auto"${translation.from==='auto'?' selected':''}>Detect language</option>${options(translation.from)}</select>${btn('Swap languages','translation-swap',{icon:'swap',iconOnly:true,disabled:busy('translate')})}<select id="translation-to" aria-label="Translate to">${options(translation.to)}</select></div><div class="translator-grid"><div class="field"><label for="translation-input">Original text</label><textarea id="translation-input" placeholder="Enter text to translate…" maxlength="10000" required>${h(translation.input)}</textarea><div id="translation-count" class="text-counter">${translation.input.length.toLocaleString()} / 10,000</div></div><div class="field"><label for="translation-output">Translation${translation.detected?` <span class="muted tiny">Detected: ${h(translation.detected)}</span>`:''}</label><textarea id="translation-output" readonly placeholder="Your translation appears here.">${h(translation.output)}</textarea><div class="button-row align-end">${btn('Copy translation','copy-translation',{icon:'copy',subtle:true,disabled:!translation.output})}</div></div></div><div class="button-row"><button type="submit" class="button primary"${busy('translate')?' disabled':''}>${icon('translate')}${busy('translate')?'Translating…':'Translate'}</button>${btn('Clear','translation-clear',{subtle:true,disabled:busy('translate')})}</div><p class="inline-note no-margin" style="margin-top:16px">Text is sent to Google Translate. MyMemory is used if Google is unavailable.</p></form></section>`;
  }
  function todosView() {
    const todos = filterTodos(app.todos,ui.todoFilter);
    return `<section class="card"><form id="todo-quick-form" class="todo-entry"><div class="field"><label for="todo-title">What would you like to get done?</label><input id="todo-title" maxlength="500" value="${h(ui.quickTitle)}" placeholder="Add a to-do…" required autocomplete="off"></div><button class="button primary" type="submit"${busy('todos')?' disabled':''}>${icon('plus')}Add to-do</button>${btn('More options','new-todo',{icon:'edit',disabled:busy('todos')})}</form><div class="section-toolbar"><div class="segmented" role="tablist" aria-label="To-do filter">${[['all','All'],['active','Active'],['completed','Completed']].map(([key,label])=>`<button role="tab" aria-selected="${ui.todoFilter===key}" data-action="todo-filter" data-value="${key}">${label}${key==='all'?` (${app.todos.length})`:''}</button>`).join('')}</div>${app.todos.some(item=>item.done)?btn('Clear completed','todos-clear',{subtle:true,icon:'trash',disabled:busy('todos')}):''}</div>${todos.length?`<ul class="todo-list">${todos.map((todo,index)=>`<li class="todo-item${todo.done?' completed':''}"><label class="todo-checkbox"><input type="checkbox" data-todo-toggle="${h(todo.id)}" aria-label="${todo.done?'Mark incomplete':'Complete'} ${h(todo.title)}"${todo.done?' checked':''}${busy('todos')?' disabled':''}></label><div class="todo-marker" style="color:${/^#[0-9a-f]{6}$/i.test(todo.color || '')?todo.color:app.accent}">${h(TODO_ICONS.includes(todo.icon)?todo.icon:'✓')}</div><div class="list-body"><div class="todo-title">${h(todo.title)}</div>${todo.details?`<p class="todo-details">${h(todo.details)}</p>`:''}${todo.endAt?`<div class="todo-subtitle">${todo.timeType==='time'?'Scheduled':'Due'} ${h(formatDate(todo.endAt,{year:'numeric'}))}${String(todo.endAt).includes('T')?` · ${h(formatTime(todo.endAt))}`:''}</div>`:''}</div><div class="todo-actions">${btn(`Move ${todo.title} up`,'todo-up',{value:todo.id,icon:'up',iconOnly:true,disabled:busy('todos') || index===0})}${btn(`Move ${todo.title} down`,'todo-down',{value:todo.id,icon:'down',iconOnly:true,disabled:busy('todos') || index===todos.length-1})}${btn('Edit to-do','edit-todo',{value:todo.id,icon:'edit',iconOnly:true,disabled:busy('todos')})}${btn('Delete to-do','delete-todo',{value:todo.id,icon:'trash',iconOnly:true,disabled:busy('todos')})}</div></li>`).join('')}</ul>`:empty('todo',ui.todoFilter==='completed'?'No completed to-dos yet':ui.todoFilter==='active'?'You’re all caught up':'A clear space for your next idea',ui.todoFilter==='completed'?'Completed to-dos appear here.':'Add a task above, or choose More options to add a time, color and icon.')}<p class="inline-note">To-dos are saved by the native service on your Mac.</p></section>`;
  }
  function mapView() {
    return `<section class="card narrow"><img class="map-illustration" src="campus.svg" alt="Decorative drawing of a campus, not a floor plan"><h2>Find your way around campus</h2><p class="small muted">Open the campus building directory or look up a room. The numbered schematic shows building facilities; it does not claim exact classroom positions or walking routes.</p>${ui.mapResult?`<div class="info-box" role="status"><h3>${ui.mapResult.building?`Building ${h(ui.mapResult.building)} · `:''}${h(ui.mapResult.name || 'Campus directory')}</h3><p class="no-margin">${h(ui.mapResult.details || ui.mapResult.message || '')}</p></div>`:''}<form id="room-form"><div class="field"><label for="room-name">Room or classroom</label><input id="room-name" maxlength="100" value="${h(ui.roomQuery)}" placeholder="Enter a room name or number" required autocomplete="off"></div><div class="button-row"><button type="submit" class="button primary"${busy('map')?' disabled':''}>${icon('search')}Find room</button>${btn('Open campus map','map-open',{icon:'map',disabled:busy('map')})}</div></form><p class="inline-note">Room convention: 5218 → Building 5. Use Building12 or 12-201 for Building 12; 1201 → Building 1.</p></section>`;
  }
  function switchControl(key,label,value) { return `<label class="switch"><input type="checkbox" data-setting="${key}" aria-label="${h(label)}"${value?' checked':''}${busy('settings')?' disabled':''}><span class="switch-track"></span></label>`; }
  function settingsView() {
    const update = app.update || {}, updateState = String(update.state || update.status || ''), available = update.available === true || ['available','downloaded','ready'].includes(updateState), downloading = ['downloading','installing','checking'].includes(updateState);
    const percent = percentage(update.percent ?? update.progress);
    return heading('Settings','Make WLSAPlus feel like you.') + `<div class="settings-layout"><section class="card"><div class="card-header"><h2>PowerSchool</h2></div><div class="setting-row"><div class="account-summary"><div class="mini-icon">${icon('user')}</div><div><h3>${h(accountExists()?app.school.username:'Connect your school account')}</h3><p>${h(app.school.baseURL || 'Bring your schedule, grades and attendance into WLSAPlus.')}</p>${app.snapshot.syncedAt?`<p>Last sync ${h(formatDate(app.snapshot.syncedAt,{year:'numeric'}))}, ${h(formatTime(app.snapshot.syncedAt))}</p>`:''}</div></div><div class="button-row">${btn(accountExists()?'Manage account':'Connect PowerSchool','account',{primary:!accountExists(),icon:accountExists()?'settings':'plus'})}${accountExists()?btn('Sync now','sync',{icon:'sync',disabled:busy('sync')}):''}</div></div></section><section class="card"><div class="card-header"><h2>Appearance</h2></div><div class="setting-row"><div class="setting-copy"><h3>Theme</h3><p>Follow your Mac, or choose the look you prefer.</p></div><div class="segmented" role="group" aria-label="Theme">${[['system','System'],['light','Light'],['dark','Dark']].map(([key,label])=>`<button aria-pressed="${app.appearance===key}" data-action="appearance" data-value="${key}"${busy('settings')?' disabled':''}>${label}</button>`).join('')}</div></div><div class="setting-row"><div class="setting-copy"><h3>Accent color</h3><p>A little color throughout your workspace.</p></div><div class="color-options" role="group" aria-label="Accent color">${ACCENTS.map(([name,color])=>`<button class="color-option" style="--swatch:${color}" aria-label="${name}" title="${name}" aria-pressed="${app.accent===color}" data-action="accent" data-value="${color}"${busy('settings')?' disabled':''}>${app.accent===color?icon('check'):''}</button>`).join('')}</div></div></section><section class="card"><div class="card-header"><h2>Notifications & startup</h2></div><div class="setting-row"><div class="setting-copy"><h3>Class reminders</h3><p>Receive a macOS notification about five minutes before class. Notification permission may be requested.</p></div>${switchControl('reminders','Class reminders',app.reminders)}</div><div class="setting-row"><div class="setting-copy"><h3>Open at login</h3><p>Start WLSAPlus when you sign in to your Mac.</p></div>${switchControl('autostart','Open at login',app.autostart)}</div></section><section class="card"><div class="card-header"><h2>Time tuning</h2></div><div class="setting-row"><div class="setting-copy"><h3>Use a custom display time</h3><p>Preview your school day at another time. Class reminders always use the actual time.</p></div>${switchControl('tuningEnabled','Use a custom display time',app.tuningEnabled)}</div>${app.tuningEnabled?`<form id="tuning-form"><div class="field tuning-field"><label for="tuned-time">Display date and time</label><input id="tuned-time" type="datetime-local" value="${h(ui.tunedInput || toLocalDateTime(app.tunedTime || new Date()))}" required></div><div class="button-row align-end"><button type="submit" class="button"${busy('settings')?' disabled':''}>Save display time</button></div></form>`:''}</section><section class="card"><div class="card-header"><h2>About & updates</h2>${badge(app.version?`Version ${app.version}`:'Version unavailable')}</div><div class="setting-row"><div class="setting-copy"><h3>Update channel</h3><p>Stable releases are the default. Beta includes test releases and early changes.</p></div><div class="segmented" role="group" aria-label="Update channel">${[['stable','Stable'],['beta','Beta / test']].map(([key,label])=>`<button aria-pressed="${(app.channel || 'stable')===key}" data-action="update-channel" data-value="${key}"${busy('settings')?' disabled':''}>${label}</button>`).join('')}</div></div><div class="setting-row"><div class="setting-copy"><h3>WLSAPlus</h3><p>${h(update.message || (available?`Version ${update.version || 'update'} is available.`:'Check for the latest version of WLSAPlus.'))}</p>${percent!=null?`<progress class="update-progress" max="100" value="${Math.max(0,Math.min(100,percent))}" aria-label="Update download progress">${h(percent)}%</progress>`:''}${update.channel?`<p>Update channel: ${h(update.channel)}</p>`:''}</div><div class="button-row">${btn(busy('update-check')?'Checking…':'Check for updates','update-check',{icon:'sync',disabled:busy('update-check') || downloading})}${available?btn(['downloaded','ready'].includes(updateState)?'Install update':'Download update','update-install',{primary:true,icon:'download',disabled:busy('update-install') || downloading}):''}${btn('Update log','update-log',{subtle:true})}</div></div><div class="setting-row"><div class="setting-copy"><h3>Project & privacy</h3><p>School data and to-dos are stored on this Mac. Passwords are handled by the native credential service.</p></div>${btn('Project on GitHub','project-open',{icon:'external'})}</div><div class="setting-row"><div class="setting-copy"><h3>Clear local data</h3><p>Remove the saved account, cached school data and to-dos from this Mac.</p></div>${btn('Clear local data…','clear-data',{danger:true,icon:'trash'})}</div></section></div>`;
  }

  function toLocalDateTime(value) {
    const date = parseDate(value); if (!date) return '';
    return `${dateKey(date)}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  }
  async function reloadState() { app = normalizeState(await native('app.state')); ui.loadError = ''; if (isNativeAvailable()) setEnvironment(''); return app; }
  async function run(key, task, onError) {
    if (busy(key)) return;
    ui.pending.add(key); render();
    try { return await task(); }
    catch (error) { if (onError) onError(error); else toast(errorText(error),true); }
    finally { ui.pending.delete(key); render(); }
  }
  async function saveSettings(patch) {
    return run('settings', async () => { await native('settings.save',patch); await reloadState(); if ('tunedTime' in patch || 'tuningEnabled' in patch) { ui.date=referenceNow(); ui.tunedInput=''; } toast('Settings saved.'); });
  }
  async function syncSchool() {
    if (!accountExists()) { openAccount(); return; }
    return run('sync',async () => { await native('school.sync'); await reloadState(); toast('PowerSchool synchronized.'); });
  }
  async function saveTodos(items, message) {
    return run('todos',async () => { await native('todos.save',{items}); await reloadState(); if (message) toast(message); });
  }
  function navigate(page, tool = '') {
    if (!['home','schedule','progress','forum','tools','settings'].includes(page)) page = 'home';
    ui.page = page; ui.tool = tool;
    if (root.location.hash !== `#${page}`) root.history.replaceState(null,'',`#${page}`);
    render(); $('#main').focus({preventScroll:true}); $('#main').scrollIntoView({block:'start'});
    if (page==='tools' && tool==='vpn' && !ui.nodes.length) loadNodes();
  }
  function openDialog(title,subtitle,body) {
    ui.dialogNonce = (ui.dialogNonce || 0)+1;
    $('#dialog-content').innerHTML = `<div class="dialog-header"><div><h2 id="dialog-title">${h(title)}</h2>${subtitle?`<p>${h(subtitle)}</p>`:''}</div>${btn('Close dialog','dialog-close',{icon:'close',iconOnly:true,subtle:true})}</div><div class="dialog-body">${body}</div>`;
    if (!$('#dialog').open) $('#dialog').showModal();
    return ui.dialogNonce;
  }
  function closeDialog() { ui.dialogNonce = (ui.dialogNonce || 0)+1; $('#dialog').close(); }
  function setDialogError(message) {
    let target = $('#dialog-error');
    if (!target) { target = document.createElement('div'); target.id = 'dialog-error'; target.className = 'error-message'; target.setAttribute('role','alert'); $('#dialog .dialog-body').prepend(target); }
    target.textContent = message; target.hidden = !message;
  }
  function setFormBusy(form, value) { if (!form?.isConnected) return; form.setAttribute('aria-busy',String(value)); form.querySelectorAll('button,input,select,textarea').forEach(control=>{control.disabled=value;}); }
  function openAccount() {
    openDialog(accountExists()?'PowerSchool account':'Connect PowerSchool',accountExists()?'Manage your school connection.':'Your school day, brought together.',
      `<form id="school-login-form"><div id="dialog-error" class="error-message" role="alert" hidden></div><div class="field"><label for="school-url">PowerSchool address</label><input id="school-url" type="url" placeholder="https://your-school.powerschool.com/" value="${h(app.school.baseURL)}" required autocomplete="url" spellcheck="false"><p class="field-hint">Use your school’s student and parent portal address.</p></div><div class="field"><label for="school-username">Username</label><input id="school-username" value="${h(app.school.username)}" required autocomplete="username" maxlength="200" autocapitalize="none" spellcheck="false"></div><div class="field"><label for="school-password">Password</label><input id="school-password" type="password" required autocomplete="current-password" maxlength="1000"><p class="field-hint">Credentials are passed directly to the native service. The interface does not store your password.</p></div><div class="info-box">Your schedule, grades and attendance are cached on your Mac for offline access.</div><div class="dialog-actions">${accountExists()?btn('Sign out','school-logout',{danger:true,icon:'logout'}):''}<span class="spacer"></span>${btn('Cancel','dialog-close')}<button type="submit" class="button primary"${busy('login')?' disabled':''}>${icon('lock')}${accountExists()?'Connect & sync':'Connect PowerSchool'}</button></div></form>`);
  }
  function todoDialog(id) {
    const existing = id ? app.todos.find(item=>String(item.id)===String(id)) : null;
    const todo = existing || {title:'',endAt:'',timeType:'deadline',color:app.accent,icon:TODO_ICONS[0]};
    ui.todoEditColor = /^#[0-9a-f]{6}$/i.test(todo.color || '') ? todo.color : app.accent;
    ui.todoEditIcon = TODO_ICONS.includes(todo.icon) ? todo.icon : TODO_ICONS[0];
    openDialog(existing?'Edit to-do':'Add a to-do','Make a little plan for what comes next.',
      `<form id="todo-edit-form" data-id="${h(existing?.id || '')}"><div id="dialog-error" class="error-message" role="alert" hidden></div><div class="field"><label for="todo-edit-title">Title</label><input id="todo-edit-title" maxlength="500" value="${h(todo.title)}" required autofocus></div><div class="field"><label for="todo-details">Details <span class="muted">(optional)</span></label><textarea id="todo-details" maxlength="20000" rows="3" placeholder="Notes, links or anything you want to remember…">${h(todo.details || '')}</textarea></div><div class="field"><label for="todo-end-at">Date and time <span class="muted">(optional)</span></label><input id="todo-end-at" type="datetime-local" value="${h(toLocalDateTime(todo.endAt))}"></div><div class="field"><span class="field-label">Time type</span><div class="radio-options"><label><input type="radio" name="todo-time-type" value="deadline"${todo.timeType!=='time'?' checked':''}>Deadline</label><label><input type="radio" name="todo-time-type" value="time"${todo.timeType==='time'?' checked':''}>Scheduled time</label></div></div><div class="field"><span class="field-label">Color</span><div id="todo-color-picker" class="color-options" role="group" aria-label="To-do color">${ACCENTS.map(([name,color])=>`<button type="button" class="color-option" style="--swatch:${color}" aria-label="${name}" aria-pressed="${color===ui.todoEditColor}" data-action="todo-color" data-value="${color}">${color===ui.todoEditColor?icon('check'):''}</button>`).join('')}</div></div><div class="field"><span class="field-label">Icon</span><div class="icon-picker" role="group" aria-label="To-do icon">${TODO_ICONS.map((symbol,index)=>`<button type="button" aria-label="Icon ${index+1}: ${h(symbol)}" aria-pressed="${symbol===ui.todoEditIcon}" data-action="todo-icon" data-value="${h(symbol)}">${h(symbol)}</button>`).join('')}</div></div><div class="dialog-actions">${btn('Cancel','dialog-close')}<button class="button primary" type="submit"${busy('todos')?' disabled':''}>${existing?'Save to-do':'Add to-do'}</button></div></form>`);
  }
  async function showCourse(id) {
    const course = app.snapshot.courses.find(item=>String(item.id)===String(id));
    if (!course) { toast('This course is no longer in your last sync.',true); return; }
    const nonce = openDialog(course.name || 'Course details',[course.teacher,course.room].filter(Boolean).join(' · '),'<div class="loading-inline"><span class="spinner"></span>Loading course details…</div>');
    try {
      const detail = await native('school.course',{id:course.id});
      if (ui.dialogNonce!==nonce || !$('#dialog').open) return;
      const assignments = Array.isArray(detail?.assignments) ? detail.assignments : app.snapshot.assignments.filter(item=>item.course===course.name || item.courseId===course.id);
      $('#dialog .dialog-body').innerHTML = `<div class="button-row"><span class="grade">${h(course.grade || '—')}</span>${percentage(course.percent)!=null?badge(`${percentage(course.percent)}%`,'accent'):''}</div>${detail?.description?`<section class="course-detail-section"><h3>Course description</h3><p class="small muted whitespace">${h(detail.description)}</p></section>`:''}${detail?.teacherComment?`<section class="course-detail-section"><h3>Teacher comment</h3><p class="small muted whitespace">${h(detail.teacherComment)}</p></section>`:''}<section class="course-detail-section"><h3>Assignments</h3>${assignments.length?assignmentTable(assignments):'<p class="small muted">No assignment details were provided for this course.</p>'}</section><div class="dialog-actions">${btn('Done','dialog-close',{primary:true})}</div>`;
    } catch (error) {
      if (ui.dialogNonce===nonce && $('#dialog').open) $('#dialog .dialog-body').innerHTML = `<div class="error-message" role="alert">${h(errorText(error))}</div><p class="small muted">Your last synchronized course grade is ${h(course.grade || 'not provided')}.</p><div class="dialog-actions">${btn('Close','dialog-close')}</div>`;
    }
  }
  async function loadNodes() {
    return run('vpn-nodes',async () => {
      ui.vpnError='';
      const result = await native('vpn.nodes');
      const nodes = Array.isArray(result) ? result : result?.nodes;
      ui.nodes = Array.isArray(nodes) ? nodes.filter(node=>node.id!=null).map(node=>({...node,id:String(node.id)})) : [];
      if (!ui.nodes.some(node=>node.id===ui.selectedNode)) ui.selectedNode=ui.nodes.some(node=>node.id===String(result?.selectedNode))?String(result.selectedNode):ui.nodes[0]?.id || '';
    },error=>{ui.vpnError=errorText(error);});
  }
  async function translateText() {
    const text = ui.translation.input.trim();
    if (!text) { toast('Enter some text to translate.',true); $('#translation-input')?.focus(); return; }
    if (text.length>10000) { toast('Keep the text under 10,000 characters.',true); return; }
    if (ui.translation.from===ui.translation.to) { toast('Choose different source and target languages.',true); return; }
    return run('translate',async () => {
      const result = await native('translate',{text,from:ui.translation.from,to:ui.translation.to});
      const output = typeof result==='string' ? result : result?.text;
      if (typeof output!=='string') throw new Error('The translation provider returned no translation.');
      ui.translation.output=output; ui.translation.detected=result?.detectedLanguage || ''; announce('Translation ready.');
    });
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const field = document.createElement('textarea'); field.value=text; field.className='sr-only'; document.body.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove();
      if (!copied) throw new Error('Copy was unavailable. Select the translation and copy it manually.');
    }
    toast('Translation copied.');
  }
  async function openMap(room = '') {
    return run('map',async () => { const result = await native('map.open',{room:String(room).trim()}); ui.mapResult=result || null; if (result?.message) toast(result.message); });
  }
  function meaningfulResult(result, success, failure) {
    if (result?.message) return String(result.message);
    if (typeof result==='string') return result;
    if (result?.reachable===true || result?.ok===true) return success;
    if (result?.reachable===false || result?.ok===false) return failure;
    return 'The native check returned no reachability information.';
  }
  async function showUpdateLog() {
    const nonce=openDialog('Update log','Download and installation details.','<div class="loading-inline"><span class="spinner"></span>Reading update log…</div>');
    try {
      const result = await native('updates.log');
      if (ui.dialogNonce!==nonce || !$('#dialog').open) return;
      const log = typeof result==='string' ? result : Array.isArray(result?.entries) ? result.entries.map(entry=>typeof entry==='string'?entry:[entry.date,entry.message].filter(Boolean).join(' · ')).join('\n') : result?.text || result?.log || '';
      $('#dialog .dialog-body').innerHTML = `<p class="small whitespace">${h(log || (result?.ok ? 'The update log was revealed in Finder. Open update.log to view its contents.' : 'No update activity has been recorded.'))}</p><div class="dialog-actions">${btn('Done','dialog-close')}</div>`;
    } catch(error) { if(ui.dialogNonce===nonce && $('#dialog').open) $('#dialog .dialog-body').innerHTML=`<div class="error-message" role="alert">${h(errorText(error))}</div><div class="dialog-actions">${btn('Close','dialog-close')}</div>`; }
  }

  document.addEventListener('click', async event => {
    const target=event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    event.preventDefault();
    const action=target.dataset.action,value=target.dataset.value;
    switch(action) {
      case 'navigate': navigate(value); break;
      case 'account': openAccount(); break;
      case 'sync': await syncSchool(); break;
      case 'dialog-close': closeDialog(); break;
      case 'dismiss-notice': ui.dismissedNotice=app.notice?.id || ''; render(); break;
      case 'previous-date': ui.date=addDays(ui.date,ui.scheduleMode==='week'?-7:-1); render(); break;
      case 'next-date': ui.date=addDays(ui.date,ui.scheduleMode==='week'?7:1); render(); break;
      case 'today': ui.date=referenceNow(); render(); break;
      case 'schedule-mode': ui.scheduleMode=value; render(); break;
      case 'progress-tab': ui.progressTab=value; ui.query=''; render(); break;
      case 'progress-assignments': ui.progressTab='assignments'; ui.query=''; navigate('progress'); break;
      case 'course': await showCourse(value); break;
      case 'open-tool': navigate('tools',value); break;
      case 'tools-back': ui.tool=''; render(); break;
      case 'new-todo': todoDialog(); break;
      case 'edit-todo': todoDialog(value); break;
      case 'delete-todo': await saveTodos(app.todos.filter(item=>String(item.id)!==value),'To-do deleted.'); break;
      case 'todo-filter': ui.todoFilter=value; render(); break;
      case 'todos-clear': await saveTodos(app.todos.filter(item=>!item.done),'Completed to-dos cleared.'); break;
      case 'todo-color':
        ui.todoEditColor=value;
        $('#todo-color-picker').querySelectorAll('button').forEach(button=>{const selected=button.dataset.value===value;button.setAttribute('aria-pressed',String(selected));button.innerHTML=selected?icon('check'):'';}); break;
      case 'todo-icon':
        ui.todoEditIcon=value;
        $('#dialog .icon-picker').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.value===value))); break;
      case 'todo-up': case 'todo-down':
        await saveTodos(moveTodo(app.todos,value,action==='todo-up'?'up':'down',ui.todoFilter),'To-do order saved.');announce('To-do moved.');document.querySelector(`[data-action="edit-todo"][data-value="${CSS.escape(value)}"]`)?.focus();break;
      case 'timeline-previous': case 'timeline-next': {const start=parseDate(ui.timelineStart) || new Date(referenceNow().setHours(0,0,0,0));ui.timelineStart=new Date(start.getTime()+(action==='timeline-previous'?-1:1)*ui.timelineHours*3600000).toISOString();render();break;}
      case 'timeline-now': ui.timelineStart=new Date(referenceNow().getTime()-Math.min(2,ui.timelineHours/6)*3600000).toISOString();render();break;
      case 'timeline-zoom-in': case 'timeline-zoom-out': {const levels=[6,12,24,48,72,168],at=levels.indexOf(ui.timelineHours);ui.timelineHours=levels[Math.max(0,Math.min(levels.length-1,at+(action==='timeline-zoom-in'?-1:1)))];render();break;}
      case 'update-channel': await saveSettings({channel:value});break;
      case 'clear-data': openDialog('Clear local data?','This removes the saved data from this Mac.',`<p class="small muted">The saved PowerSchool account, cached school records and to-dos will be removed. You can reconnect your account afterwards.</p><div class="dialog-actions">${btn('Cancel','dialog-close')}${btn('Clear local data','confirm-clear-data',{danger:true,icon:'trash'})}</div>`);break;
      case 'confirm-clear-data': await run('clear-data',async ()=>{await native('app.clear');await reloadState();ui.nodes=[];ui.selectedNode='';ui.translation.input='';ui.translation.output='';ui.quickTitle='';ui.mapResult=null;closeDialog();toast('Local data cleared.');},error=>setDialogError(errorText(error)));break;
      case 'appearance': await saveSettings({appearance:value}); break;
      case 'accent': await saveSettings({accent:value}); break;
      case 'school-logout':
        await run('logout',async ()=>{await native('school.logout');await reloadState();closeDialog();toast('Signed out of PowerSchool.');},error=>setDialogError(errorText(error))); break;
      case 'forum-open': await run('forum',async ()=>{await native('forum.open');}); break;
      case 'vpn-nodes': await loadNodes(); break;
      case 'vpn-connect':
        await run('vpn-connect',async ()=>{ui.vpnError='';await native('vpn.connect',{nodeId:ui.selectedNode});await reloadState();},error=>{ui.vpnError=errorText(error);}); break;
      case 'vpn-disconnect':
        await run('vpn-disconnect',async ()=>{ui.vpnError='';await native('vpn.disconnect');await reloadState();},error=>{ui.vpnError=errorText(error);}); break;
      case 'vpn-latency':
        await run('vpn-latency',async ()=>{
          const result=await native('vpn.latency');
          const entries=Array.isArray(result)?result:result?.nodes || result?.results || result?.latencies || [];
          if (Array.isArray(entries)) ui.nodes=ui.nodes.map(node=>{const entry=entries.find(item=>String(item.nodeId ?? item.id)===node.id);return entry?{...node,latency:entry.ms ?? entry.latency ?? null}:node;});
          else if (entries && typeof entries==='object') ui.nodes=ui.nodes.map(node=>({...node,latency:entries[node.id] ?? node.latency}));
          if (result?.message) toast(result.message); else toast('Latency test completed.');
        },error=>{ui.vpnError=errorText(error);}); break;
      case 'vpn-wechat':
        await run('vpn-wechat',async ()=>{const result=await native('vpn.wechat');ui.vpnCheck=meaningfulResult(result,'WeChat is reachable.','WeChat is not reachable on this connection.');}); break;
      case 'translation-swap': {
        const translation=ui.translation;
        if(translation.from==='auto'){translation.from=translation.to;translation.to=translation.to==='en'?'zh-Hans':'en';}
        else [translation.from,translation.to]=[translation.to,translation.from];
        if(translation.output){[translation.input,translation.output]=[translation.output,translation.input];translation.detected='';}
        render();break;
      }
      case 'translation-clear': ui.translation.input='';ui.translation.output='';ui.translation.detected='';render();$('#translation-input')?.focus();break;
      case 'copy-translation': try{await copyText(ui.translation.output);}catch(error){toast(errorText(error),true);}break;
      case 'find-room': await openMap(value); break;
      case 'map-open': await openMap(); break;
      case 'update-check':
        await run('update-check',async ()=>{const result=await native('updates.check');await reloadState();if(result?.message)toast(result.message);else if(!app.update.available && !['available','downloaded','ready'].includes(String(app.update.state || app.update.status)))toast('Update check completed.');});break;
      case 'update-install':
        await run('update-install',async ()=>{await native('updates.install');await reloadState();});break;
      case 'update-log': await showUpdateLog();break;
      case 'project-open': await run('external',()=>native('external.open',{url:'https://github.com/yezicheng2011/wlsaplus-enablemacos'}));break;
      default: break;
    }
  });
  document.addEventListener('input',event=>{
    const input=event.target;
    if(input.id==='todo-title')ui.quickTitle=input.value;
    if(input.id==='room-name')ui.roomQuery=input.value;
    if(input.id==='tuned-time')ui.tunedInput=input.value;
    if(input.id==='progress-search'){ui.query=input.value;render();}
    if(input.id==='translation-input'){ui.translation.input=input.value;$('#translation-count').textContent=`${input.value.length.toLocaleString()} / 10,000`;}
  });
  document.addEventListener('change',async event=>{
    const input=event.target;
    if(input.dataset.todoToggle){await saveTodos(toggleTodo(app.todos,input.dataset.todoToggle));return;}
    if(input.dataset.setting){
      const patch={[input.dataset.setting]:input.checked};
      if(input.dataset.setting==='tuningEnabled' && input.checked && !parseDate(app.tunedTime))patch.tunedTime=new Date().toISOString();
      await saveSettings(patch);return;
    }
    if(input.name==='vpn-node'){ui.selectedNode=input.value;render();}
    if(input.id==='course-filter'){ui.courseFilter=input.value;render();}
    if(input.id==='translation-from')ui.translation.from=input.value;
    if(input.id==='translation-to')ui.translation.to=input.value;
  });
  document.addEventListener('submit',async event=>{
    const form=event.target;
    event.preventDefault();
    if(!form.checkValidity()){form.reportValidity();return;}
    if(form.id==='school-login-form'){
      let baseURL;
      try{baseURL=validateSchoolURL($('#school-url').value);}catch(error){setDialogError(errorText(error));return;}
      const username=$('#school-username').value.trim();
      if(!username){setDialogError('Enter your PowerSchool username.');return;}
      const password=$('#school-password').value;
      $('#school-password').value='';
      setDialogError('');setFormBusy(form,true);
      await run('login',async ()=>{await native('school.login',{baseURL,username,password});await reloadState();closeDialog();toast('PowerSchool connected and synchronized.');},error=>setDialogError(errorText(error)));
      setFormBusy(form,false);return;
    }
    if(form.id==='todo-quick-form'){
      let item;
      try{item=normalizeTodo({title:$('#todo-title').value,color:app.accent});}catch(error){toast(errorText(error),true);return;}
      await run('todos',async ()=>{await native('todos.save',{items:[...app.todos,item]});await reloadState();ui.quickTitle='';toast('To-do added.');});return;
    }
    if(form.id==='todo-edit-form'){
      const previous=app.todos.find(item=>String(item.id)===form.dataset.id);
      let item;
      try{item=normalizeTodo({...previous,title:$('#todo-edit-title').value,details:$('#todo-details').value,endAt:$('#todo-end-at').value?new Date($('#todo-end-at').value).toISOString():'',color:ui.todoEditColor,icon:ui.todoEditIcon,timeType:form.querySelector('[name="todo-time-type"]:checked').value});}catch(error){setDialogError(errorText(error));return;}
      setFormBusy(form,true);setDialogError('');
      await run('todos',async ()=>{const items=previous?app.todos.map(todo=>todo.id===item.id?item:todo):[...app.todos,item];await native('todos.save',{items});await reloadState();closeDialog();toast(previous?'To-do saved.':'To-do added.');},error=>setDialogError(errorText(error)));
      setFormBusy(form,false);return;
    }
    if(form.id==='translation-form'){await translateText();return;}
    if(form.id==='room-form'){await openMap($('#room-name').value);return;}
    if(form.id==='tuning-form'){
      const value=parseDate($('#tuned-time').value);
      if(!value){toast('Choose a valid date and time.',true);return;}
      await saveSettings({tunedTime:value.toISOString()});
    }
  });
  // Arrow keys follow the tab order for each compact tab list.
  document.addEventListener('keydown',event=>{
    const target=event.target;
    if(target.getAttribute('role')!=='tab' || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=[...target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const index=tabs.indexOf(target);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    event.preventDefault();tabs[next].click();
    const updated=[...document.querySelectorAll(`[role="tablist"][aria-label="${target.closest('[role="tablist"]').getAttribute('aria-label')}"] [role="tab"]`)];updated[next]?.focus();
  });
  $('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog')){const rect=$('#dialog').getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)closeDialog();}});
  $('#dialog').addEventListener('cancel',()=>{ui.dialogNonce=(ui.dialogNonce || 0)+1;});
  root.addEventListener('hashchange',()=>{const page=root.location.hash.slice(1);navigate(page);});
  root.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(app.appearance==='system')applyAppearance();});
  root.nativeEvent=message=>{
    if(!message || typeof message.name!=='string')return;
    const value=message.value;
    switch(message.name){
      case 'state': app=normalizeState(value || {});break;
      case 'snapshot': app=normalizeState({...app,snapshot:value || {}});break;
      case 'school': app=normalizeState({...app,school:value || {}});break;
      case 'vpn': app=normalizeState({...app,vpn:{...app.vpn,...value}});break;
      case 'update': case 'updates': app=normalizeState({...app,update:{...app.update,...value}});break;
      case 'settings': app=normalizeState({...app,...value});break;
      case 'todos': app=normalizeState({...app,todos:Array.isArray(value)?value:value?.items || []});break;
      case 'notice': app.notice=value;break;
      case 'notification': if(value?.message || typeof value==='string')toast(value.message || value);return;
      case 'forum': if(value?.message)toast(value.message);return;
      default:return;
    }
    render();
  };
  async function start(){
    ui.page=['home','schedule','progress','forum','tools','settings'].includes(root.location.hash.slice(1))?root.location.hash.slice(1):'home';
    if(!isNativeAvailable()){
      setEnvironment('Browser preview · Native Mac services are unavailable. Connect, sync, VPN, translation and saving require WLSAPlus.app. No school data is loaded.');
      render();return;
    }
    try{await reloadState();ui.date=referenceNow();}
    catch(error){ui.loadError=errorText(error);setEnvironment(`Could not load native state: ${ui.loadError}`);}
    render();
  }
  setInterval(()=>{if(ui.page==='home' && !$('#dialog').open && !ui.pending.size)render();},30000);
  start();
})(typeof globalThis!=='undefined'?globalThis:this);
