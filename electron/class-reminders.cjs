// Class reminder scheduler for the macOS main process.
//
// The renderer only syncs the schedule (minimal session fields) and the on/off switch; the timer,
// dedupe set and persisted state live here so reminders keep firing after the last window is
// closed (macOS keeps the app running) and after an autostart that never opens a window.
const fs = require('node:fs/promises');
const path = require('node:path');

/** Minutes before class start when the reminder fires (mirrors CLASS_REMINDER_LEAD_MINUTES). */
const CLASS_REMINDER_LEAD_MINUTES = 5;
const CLASS_REMINDER_TITLE = 'Class starting soon';
const REMINDER_CHECK_INTERVAL_MS = 30_000;
const MAX_REMINDER_SESSIONS = 1000;
const MAX_NOTIFIED_KEYS = 2000;
const FIELD_LIMITS = { id: 200, startsAt: 64, courseName: 200, room: 100, teacher: 200 };
const MAX_KEY_LENGTH = FIELD_LIMITS.id + 1 + FIELD_LIMITS.startsAt;

const emptyReminderState = () => ({ enabled: true, sessions: [], notified: [] });

function reminderKey(session) {
  return `${session.id}|${session.startsAt}`;
}

function cleanString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** Returns a minimal session or null when the entry cannot be scheduled. */
function sanitizeSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || !value.id || value.id.length > FIELD_LIMITS.id) return null;
  if (typeof value.startsAt !== 'string' || value.startsAt.length > FIELD_LIMITS.startsAt) return null;
  if (!Number.isFinite(Date.parse(value.startsAt))) return null;
  return {
    id: value.id,
    startsAt: value.startsAt,
    courseName: cleanString(value.courseName, FIELD_LIMITS.courseName),
    room: cleanString(value.room, FIELD_LIMITS.room),
    teacher: cleanString(value.teacher, FIELD_LIMITS.teacher),
  };
}

function sanitizeKeys(value) {
  if (!Array.isArray(value)) return [];
  const keys = value
    .slice(-MAX_NOTIFIED_KEYS)
    .filter((key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH);
  return [...new Set(keys)];
}

/**
 * Validates the renderer's `reminders:sync` payload. Throws on a malformed envelope; drops
 * individual sessions that are invalid and truncates long display strings.
 */
function sanitizeReminderSync(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid reminder payload.');
  if (typeof payload.enabled !== 'boolean') throw new Error('Invalid reminder payload: enabled must be a boolean.');
  if (!Array.isArray(payload.sessions)) throw new Error('Invalid reminder payload: sessions must be an array.');
  if (payload.sessions.length > MAX_REMINDER_SESSIONS) throw new Error('Too many sessions in reminder payload.');
  if (payload.legacyNotified !== undefined && !Array.isArray(payload.legacyNotified)) {
    throw new Error('Invalid reminder payload: legacyNotified must be an array.');
  }
  return {
    enabled: payload.enabled,
    sessions: payload.sessions.map(sanitizeSession).filter(Boolean),
    legacyNotified: sanitizeKeys(payload.legacyNotified),
  };
}

/** Normalizes whatever was read from disk (missing, corrupt, partial) into a valid state. */
function normalizeReminderState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyReminderState();
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.slice(0, MAX_REMINDER_SESSIONS).map(sanitizeSession).filter(Boolean)
    : [];
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    sessions,
    notified: sanitizeKeys(raw.notified),
  };
}

/** Keeps only notified keys that still belong to a synced session (same rule the renderer used). */
function pruneNotified(notified, sessions) {
  const active = new Set(sessions.map(reminderKey));
  return notified.filter((key) => active.has(key));
}

function classReminderContent(session, leadMinutes = CLASS_REMINDER_LEAD_MINUTES) {
  const room = session.room ? ` · Room ${session.room}` : '';
  const teacher = session.teacher ? ` · ${session.teacher}` : '';
  return {
    title: CLASS_REMINDER_TITLE,
    body: `${session.courseName} starts in ${leadMinutes} minutes${room}${teacher}`,
  };
}

/**
 * Pure: the reminders that should fire at `nowMs` — class starts within the lead window, has not
 * started yet, and was not already notified.
 */
function dueReminders(state, nowMs, leadMinutes = CLASS_REMINDER_LEAD_MINUTES) {
  if (!state.enabled) return [];
  const leadMs = leadMinutes * 60_000;
  const notified = new Set(state.notified);
  const due = [];
  for (const session of state.sessions) {
    const startsAt = Date.parse(session.startsAt);
    if (!Number.isFinite(startsAt)) continue;
    const key = reminderKey(session);
    if (notified.has(key)) continue;
    const msUntilStart = startsAt - nowMs;
    if (msUntilStart <= 0 || msUntilStart > leadMs) continue;
    notified.add(key); // duplicate session entries fire once
    due.push({ key, session, ...classReminderContent(session, leadMinutes) });
  }
  return due;
}

async function readReminderState(file) {
  try {
    return normalizeReminderState(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return emptyReminderState();
  }
}

/** Atomic write: temp file in the same directory, then rename over the target. */
async function writeReminderState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Main-process scheduler. `showNotification({ title, body, key })` returns true when shown.
 * Timers are injectable for tests.
 */
function createClassReminderScheduler({
  file,
  showNotification,
  now = () => Date.now(),
  intervalMs = REMINDER_CHECK_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = (error) => console.error('Class reminders:', error),
}) {
  let state = emptyReminderState();
  let timer = null;
  let ticking = false;
  let writeChain = Promise.resolve();
  const loaded = readReminderState(file).then((value) => { state = value; });

  const persist = () => {
    const snapshot = { enabled: state.enabled, sessions: state.sessions, notified: state.notified };
    writeChain = writeChain.then(() => writeReminderState(file, snapshot)).catch(onError);
    return writeChain;
  };

  async function tick() {
    await loaded;
    if (ticking) return;
    ticking = true;
    try {
      let changed = false;
      for (const reminder of dueReminders(state, now())) {
        let shown = false;
        try { shown = Boolean(await showNotification(reminder)); } catch (error) { onError(error); }
        if (shown) {
          state.notified = [...state.notified, reminder.key].slice(-MAX_NOTIFIED_KEYS);
          changed = true;
        }
      }
      if (changed) await persist();
    } finally {
      ticking = false;
    }
  }

  async function sync(payload) {
    const next = sanitizeReminderSync(payload);
    await loaded;
    const notified = sanitizeKeys([...state.notified, ...next.legacyNotified]);
    state = { enabled: next.enabled, sessions: next.sessions, notified: pruneNotified(notified, next.sessions) };
    await persist();
    await tick();
    return true;
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(() => { void tick().catch(onError); }, intervalMs);
    void tick().catch(onError);
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  return { start, stop, sync, tick, ready: () => loaded, state: () => state, flush: () => writeChain };
}

module.exports = {
  CLASS_REMINDER_LEAD_MINUTES,
  CLASS_REMINDER_TITLE,
  REMINDER_CHECK_INTERVAL_MS,
  MAX_REMINDER_SESSIONS,
  MAX_NOTIFIED_KEYS,
  FIELD_LIMITS,
  reminderKey,
  sanitizeReminderSync,
  normalizeReminderState,
  pruneNotified,
  classReminderContent,
  dueReminders,
  readReminderState,
  writeReminderState,
  createClassReminderScheduler,
};
