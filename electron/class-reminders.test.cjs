const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CLASS_REMINDER_LEAD_MINUTES,
  MAX_REMINDER_SESSIONS,
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
} = require('./class-reminders.cjs');

const NOW = Date.parse('2026-10-08T08:00:00.000Z');
const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();
const session = (id, minutes, extra = {}) => ({ id, startsAt: at(minutes), courseName: `Course ${id}`, room: '', teacher: '', ...extra });
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wlsaplus-reminders-')), 'class-reminders.json');

test('lead time matches the renderer constant (5 minutes)', () => {
  assert.equal(CLASS_REMINDER_LEAD_MINUTES, 5);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'core', 'class-reminder.service.ts'), 'utf8');
  assert.match(source, /export const CLASS_REMINDER_LEAD_MINUTES = 5;/);
});

test('notification text keeps the original format', () => {
  assert.deepEqual(classReminderContent(session('a', 3, { courseName: 'Physics', room: 'B204', teacher: 'Ms Li' })), {
    title: 'Class starting soon',
    body: 'Physics starts in 5 minutes · Room B204 · Ms Li',
  });
  assert.equal(classReminderContent(session('b', 3, { courseName: 'Advisory' })).body, 'Advisory starts in 5 minutes');
});

test('dueReminders fires only inside the lead window before class start', () => {
  const state = {
    enabled: true,
    notified: [],
    sessions: [session('past', -1), session('now', 0), session('soon', 3), session('edge', 5), session('later', 5.1), session('bad', 0, { startsAt: 'nope' })],
  };
  assert.deepEqual(dueReminders(state, NOW).map((r) => r.session.id), ['soon', 'edge']);
  assert.equal(dueReminders(state, NOW)[0].key, `soon|${at(3)}`);
});

test('dueReminders respects the switch and the dedupe key', () => {
  const s = session('soon', 2);
  assert.deepEqual(dueReminders({ enabled: false, sessions: [s], notified: [] }, NOW), []);
  assert.deepEqual(dueReminders({ enabled: true, sessions: [s], notified: [reminderKey(s)] }, NOW), []);
  // Same id at a new start time is a different class and fires again.
  assert.equal(dueReminders({ enabled: true, sessions: [s], notified: [`soon|${at(-60)}`] }, NOW).length, 1);
  // Duplicate entries fire once per tick.
  assert.equal(dueReminders({ enabled: true, sessions: [s, { ...s }], notified: [] }, NOW).length, 1);
});

test('pruneNotified drops keys for sessions no longer synced', () => {
  const sessions = [session('a', 10)];
  assert.deepEqual(pruneNotified([reminderKey(sessions[0]), 'gone|2026-01-01T00:00:00Z'], sessions), [reminderKey(sessions[0])]);
});

test('sanitizeReminderSync validates types, caps and string lengths', () => {
  assert.throws(() => sanitizeReminderSync(null));
  assert.throws(() => sanitizeReminderSync([]));
  assert.throws(() => sanitizeReminderSync({ enabled: 'yes', sessions: [] }));
  assert.throws(() => sanitizeReminderSync({ enabled: true, sessions: 'x' }));
  assert.throws(() => sanitizeReminderSync({ enabled: true, sessions: [], legacyNotified: 'x' }));
  assert.throws(() => sanitizeReminderSync({ enabled: true, sessions: Array.from({ length: MAX_REMINDER_SESSIONS + 1 }, (_, i) => session(String(i), 10)) }));

  const result = sanitizeReminderSync({
    enabled: true,
    sessions: [
      { ...session('ok', 10, { courseName: 'x'.repeat(5000), room: 7, teacher: null }), endsAt: 'ignored', courseId: 'ignored' },
      { id: '', startsAt: at(1) },
      { id: 'x'.repeat(FIELD_LIMITS.id + 1), startsAt: at(1) },
      { id: 'no-date', startsAt: 'tomorrow-ish' },
      'not-an-object',
    ],
    legacyNotified: ['a|b', 42, '', 'a|b'],
  });
  assert.equal(result.enabled, true);
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(Object.keys(result.sessions[0]).sort(), ['courseName', 'id', 'room', 'startsAt', 'teacher']);
  assert.equal(result.sessions[0].courseName.length, FIELD_LIMITS.courseName);
  assert.equal(result.sessions[0].room, '');
  assert.equal(result.sessions[0].teacher, '');
  assert.deepEqual(result.legacyNotified, ['a|b']);
});

test('normalizeReminderState tolerates missing or corrupt data', () => {
  assert.deepEqual(normalizeReminderState(undefined), { enabled: true, sessions: [], notified: [] });
  assert.deepEqual(normalizeReminderState('garbage'), { enabled: true, sessions: [], notified: [] });
  assert.deepEqual(normalizeReminderState({ enabled: false, sessions: [{ id: 1 }], notified: [1, 'k'] }), { enabled: false, sessions: [], notified: ['k'] });
});

test('state file round-trips atomically and corrupt files fall back to defaults', async () => {
  const file = tempFile();
  assert.deepEqual(await readReminderState(file), { enabled: true, sessions: [], notified: [] });
  const state = { enabled: false, sessions: [session('a', 10)], notified: ['a|x'] };
  await writeReminderState(file, state);
  assert.deepEqual(await readReminderState(file), state);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['class-reminders.json']); // no temp leftovers
  fs.writeFileSync(file, '{"enabled": tru');
  assert.deepEqual(await readReminderState(file), { enabled: true, sessions: [], notified: [] });
});

test('scheduler fires once per class, persists dedupe, and survives a restart', async () => {
  const file = tempFile();
  let now = NOW;
  const shown = [];
  const make = () => createClassReminderScheduler({
    file,
    now: () => now,
    showNotification: (reminder) => { shown.push(reminder); return true; },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  const scheduler = make();
  await scheduler.sync({ enabled: true, sessions: [session('math', 4, { courseName: 'Math', room: 'A1' }), session('art', 30)] });
  assert.deepEqual(shown.map((r) => r.body), ['Math starts in 5 minutes · Room A1']);
  await scheduler.tick();
  assert.equal(shown.length, 1, 'no duplicate on the next tick');

  // Window gone, app restarted (e.g. autostart): state comes from disk, no renderer sync needed.
  await scheduler.flush();
  now = NOW + 26 * 60_000;
  const restarted = make();
  await restarted.tick();
  assert.deepEqual(shown.map((r) => r.session.id), ['math', 'art']);
  await restarted.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.notified.sort(), [`art|${at(30)}`, `math|${at(4)}`]);

  // Turning reminders off stops notifications; re-syncing prunes keys of vanished sessions.
  await restarted.sync({ enabled: false, sessions: [session('art', 30)] });
  assert.deepEqual(restarted.state().notified, [`art|${at(30)}`]);
});

test('scheduler retries when a notification could not be shown, and migrates legacy keys', async () => {
  let allow = false;
  let calls = 0;
  const scheduler = createClassReminderScheduler({
    file: tempFile(),
    now: () => NOW,
    showNotification: () => { calls += 1; return allow; },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  const pe = session('pe', 2);
  const chem = session('chem', 3);
  await scheduler.sync({ enabled: true, sessions: [pe, chem], legacyNotified: [reminderKey(chem), 'old|key'] });
  assert.equal(calls, 1, 'chem was already notified by the old renderer timer');
  assert.deepEqual(scheduler.state().notified, [reminderKey(chem)]);
  allow = true;
  await scheduler.tick();
  assert.equal(calls, 2);
  await scheduler.tick();
  assert.equal(calls, 2);
});

test('scheduler start/stop wires a single interval', async () => {
  const intervals = [];
  let cleared = 0;
  const scheduler = createClassReminderScheduler({
    file: tempFile(),
    showNotification: () => true,
    setIntervalFn: (fn, ms) => { intervals.push(ms); return 7; },
    clearIntervalFn: (id) => { assert.equal(id, 7); cleared += 1; },
  });
  scheduler.start();
  scheduler.start();
  assert.deepEqual(intervals, [30_000]);
  scheduler.stop();
  assert.equal(cleared, 1);
  await scheduler.ready();
});

test('main process owns reminders and ships the module', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /require\('\.\/class-reminders\.cjs'\)/);
  assert.match(main, /ipcMain\.handle\('reminders:sync'/);
  assert.match(main, /notification\.on\('click', \(\) => \{ release\(\); showMainWindow\(\); \}\)/);
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('reminders:sync', payload\)/);
  const forge = require(path.join('..', 'forge.config.cjs'));
  assert.equal(forge.packagerConfig.ignore('/electron/class-reminders.cjs'), false);
  assert.equal(forge.packagerConfig.ignore('/electron/class-reminders.test.cjs'), true);
});
