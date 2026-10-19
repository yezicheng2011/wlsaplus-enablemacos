import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const app = require('../Resources/app.js');

// Run without a DOM: the production helper and bridge code is the code under test.
test('native bridge correlates concurrent, out-of-order replies', async () => {
  const messages = [];
  const bridge = app.createNativeBridge(message => messages.push(message), 1000);
  const state = bridge.call('app.state');
  const translated = bridge.call('translate', {text:'Hello',from:'en',to:'de'});
  assert.equal(bridge.pendingCount, 2);
  assert.notEqual(messages[0].id, messages[1].id);
  assert.deepEqual(messages[1].args, {text:'Hello',from:'en',to:'de'});
  assert.equal(bridge.reply({id:'unknown',result:'ignored'}), false);
  bridge.reply({id:messages[1].id,result:{text:'Hallo'}});
  bridge.reply({id:messages[0].id,result:{version:'1.0.0'}});
  assert.deepEqual(await translated, {text:'Hallo'});
  assert.deepEqual(await state, {version:'1.0.0'});
  assert.equal(bridge.pendingCount, 0);
  assert.equal(bridge.reply({id:messages[0].id,result:'duplicate'}), false);
});

test('native errors, unavailable service, and timeouts reject cleanly', async () => {
  let request;
  const bridge = app.createNativeBridge(message => {request=message;}, 15);
  const failed=bridge.call('school.login',{username:'student'});
  bridge.reply({id:request.id,error:{message:'Authentication failed'}});
  await assert.rejects(failed, /Authentication failed/);
  await assert.rejects(bridge.call('app.state'), /did not respond/);
  assert.equal(bridge.pendingCount,0);
  const unavailable=app.createNativeBridge(()=>{throw new Error('Unavailable');});
  await assert.rejects(unavailable.call('app.state'),/Unavailable/);
  assert.equal(unavailable.pendingCount,0);
  await assert.rejects(unavailable.call('bad method'),/Invalid native method/);
  await assert.rejects(app.native('app.state'),/native Mac service is unavailable/);
});

test('bridge cancellation settles all pending requests', async () => {
  const bridge=app.createNativeBridge(()=>{});
  const first=bridge.call('vpn.connect',{nodeId:'one'});
  const second=bridge.call('updates.check');
  bridge.cancelAll('Window closed');
  await Promise.all([assert.rejects(first,/Window closed/),assert.rejects(second,/Window closed/)]);
  assert.equal(bridge.pendingCount,0);
});

test('school URLs require HTTPS and reject credentials in the address', () => {
  assert.equal(app.validateSchoolURL(' https://school.example/guardian '),'https://school.example/guardian');
  for(const invalid of ['', 'school.example', 'http://school.example', 'file:///etc/passwd', 'https://name:pass@school.example']) {
    assert.throws(()=>app.validateSchoolURL(invalid));
  }
});

test('date-only data stays local, invalid dates are rejected, and week spans years', () => {
  assert.equal(app.dateKey('2026-10-19'),'2026-10-19');
  assert.equal(app.parseDate('2026-02-30'),null);
  assert.equal(app.parseDate('not a date'),null);
  assert.equal(app.formatTime('13:05'),'1:05 PM');
  assert.equal(app.formatTime('00:00'),'12:00 AM');
  assert.equal(app.formatTime('25:00'),'Not provided');
  assert.deepEqual(app.weekDates('2027-01-01').map(app.dateKey),['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01']);
});

test('schedule selects dated or explicitly recurring classes, without inventing days', () => {
  const entries=[
    {id:'later',start:'2026-10-19T13:00:00',end:'2026-10-19T14:00:00'},
    {id:'early',start:'2026-10-19T08:00:00',end:'2026-10-19T09:00:00'},
    {id:'tuesday',start:'2026-10-20T08:00:00'},
    {id:'recurring',start:'10:00',day:'Monday'},
    {id:'iso-weekday',start:'11:00',day:1},
    {id:'unknown',start:'09:00'},
    {id:'weekend',start:'09:00',day:7},
  ];
  assert.deepEqual(app.scheduleForDate(entries,'2026-10-19').map(item=>item.id),['early','recurring','iso-weekday','later']);
  assert.deepEqual(app.scheduleForDate(entries,'2026-10-18').map(item=>item.id),['weekend']);
  assert.deepEqual(app.unplacedSchedule(entries).map(item=>item.id),['unknown']);
  assert.equal(app.dayMatches(['Tue','Fri'],app.parseDate('2026-10-23')),true);
  assert.deepEqual(app.scheduleForDate(entries,'invalid'),[]);
});

test('grades preserve zero scores and missing data', () => {
  assert.equal(app.scoreText({score:0,total:10}),'0 / 10');
  assert.equal(app.scoreText({score:null,total:10}),'Not graded');
  assert.equal(app.scoreText({score:'A'}),'A');
  assert.equal(app.percentage('89.5%'),89.5);
  assert.equal(app.percentage(0),0);
  assert.equal(app.percentage(''),null);
  assert.equal(app.percentage('not provided'),null);
});

test('to-do normalization validates input and keeps color, icon, and scheduling', () => {
  const todo=app.normalizeTodo({id:'one',title:'  Read chapter 3  ',endAt:'2026-10-20T14:00:00',timeType:'time',icon:'📚',color:'#315fbc',done:false});
  assert.equal(todo.title,'Read chapter 3');
  assert.equal(todo.timeType,'time');
  assert.equal(todo.color,'#315fbc');
  assert.equal(todo.icon,'📚');
  const toggled=app.toggleTodo([todo],'one');
  assert.equal(toggled[0].done,true);
  assert.equal(todo.done,false);
  assert.equal(app.filterTodos(toggled,'active').length,0);
  assert.equal(app.filterTodos(toggled,'completed').length,1);
  assert.throws(()=>app.normalizeTodo({title:'  '}),/Enter a title/);
  assert.throws(()=>app.normalizeTodo({title:'a'.repeat(501)}),/500/);
  assert.throws(()=>app.normalizeTodo({title:'Read',endAt:'bad date'}),/valid date/);
  assert.equal(app.normalizeTodo({title:'Read',color:'red',icon:'<script>'}).color,'#00677a');
});

test('empty native state does not invent data and strips credentials', () => {
  const state=app.normalizeState({school:{username:'student',password:'secret'},snapshot:{schedule:null},todos:null});
  assert.equal(state.school.username,'student');
  assert.equal(state.school.password,undefined);
  assert.deepEqual(state.snapshot.schedule,[]);
  assert.deepEqual(state.snapshot.courses,[]);
  assert.deepEqual(state.todos,[]);
  assert.equal(state.vpn.connected,undefined);
});

test('dynamic data is escaped before markup insertion', () => {
  assert.equal(app.h('<img onerror="x">&\''),'&lt;img onerror=&quot;x&quot;&gt;&amp;&#39;');
});

test('native named accent values map to the corresponding interface color', () => {
  assert.equal(app.normalizeState({accent:'purple'}).accent,'#7754ae');
  assert.equal(app.normalizeState({accent:'default'}).accent,'#00677a');
});

test('reordering visible to-dos preserves hidden tasks and does not mutate input', () => {
  const todos=[{id:'one',done:false},{id:'hidden',done:true},{id:'two',done:false}];
  assert.deepEqual(app.moveTodo(todos,'two','up','active').map(item=>item.id),['two','hidden','one']);
  assert.deepEqual(todos.map(item=>item.id),['one','hidden','two']);
  assert.deepEqual(app.moveTodo(todos,'one','up').map(item=>item.id),['one','hidden','two']);
});

test('timeline includes overlapping classes and real deadlines without inventing due times', () => {
  const snapshot={schedule:[{id:'crossing',title:'Evening class',start:'2026-10-18T23:30:00',end:'2026-10-19T00:30:00'},{id:'later',title:'Later class',start:'2026-10-20T12:00:00',end:'2026-10-20T13:00:00'}],assignments:[{id:'date',title:'Reading',due:'2026-10-19'},{id:'invalid',due:'not supplied'}]};
  const todos=[{id:'active',title:'Draft essay',endAt:'2026-10-19T15:00:00',done:false},{id:'completed',title:'Done',endAt:'2026-10-19T16:00:00',done:true}];
  const events=app.timelineEvents(snapshot,todos,'2026-10-19T00:00:00',24);
  assert.deepEqual(events.map(item=>item.id),['class-crossing','assignment-date','todo-active']);
  assert.equal(events[1].dateOnly,true);
  assert.match(events[1].detail,/time not provided/);
  assert.deepEqual(app.timelineEvents(snapshot,todos,'invalid',24),[]);
});

test('current and next class use the real interval and show only valid synced classes', () => {
  const entries=[{id:'later',start:'2026-10-19T11:00:00',end:'2026-10-19T12:00:00'},{id:'current',start:'2026-10-19T09:00:00',end:'2026-10-19T10:00:00'},{id:'invalid',start:'unprovided',end:'unprovided'}];
  assert.equal(app.currentAndNext(entries,'2026-10-19T09:30:00').current.id,'current');
  assert.equal(app.currentAndNext(entries,'2026-10-19T09:30:00').next.id,'later');
  assert.equal(app.currentAndNext(entries,'2026-10-19T10:00:00').current,null);
  assert.equal(app.currentAndNext(entries,'2026-10-19T12:00:00').next,null);
  assert.equal(app.format24('2026-10-19T13:05:00'),'13:05');
});
