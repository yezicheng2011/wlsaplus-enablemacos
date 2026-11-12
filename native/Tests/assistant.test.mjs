// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import '../Resources/app.js';
import '../Resources/assistant.js';
const A = globalThis.WLSAAssistant;

// Thursday 12 November 2026, 09:20 local time.
const now = new Date(2026, 10, 12, 9, 20);
const slot = (date, start, end, title, room, teacher) => ({id: `${date}-${start}`, title, room, teacher, start: `${date}T${start}:00`, end: `${date}T${end}:00`});
const snapshot = {
  courses: [
    {id: 'c1', name: 'AP Calculus BC', teacher: 'Ms. Zhang Wei', room: 'B204', grade: 'A-', percent: 91.5},
    {id: 'c2', name: 'AP Physics C', teacher: 'Mr. David Miller', room: 'C310', grade: 'B+', percent: 88},
    {id: 'c3', name: 'English Literature', teacher: 'Ms. Sarah Brown', room: 'A105', grade: 'A', percent: 95},
    {id: 'c4', name: 'Chinese History', teacher: 'Mr. Li Ming', room: 'A210', grade: 'B', percent: 84},
    {id: 'c5', name: 'Computer Science A', teacher: 'Mr. Chen', room: 'D101', grade: '', percent: null},
  ],
  schedule: [
    slot('2026-11-12', '08:00', '08:45', 'AP Calculus BC', 'B204', 'Ms. Zhang Wei'),
    slot('2026-11-12', '09:00', '09:45', 'English Literature', 'A105', 'Ms. Sarah Brown'),
    slot('2026-11-12', '10:05', '10:50', 'AP Physics C', 'C310', 'Mr. David Miller'),
    slot('2026-11-12', '13:30', '14:15', 'Chinese History', 'A210', 'Mr. Li Ming'),
    slot('2026-11-13', '08:00', '08:45', 'AP Physics C', 'C310', 'Mr. David Miller'),
    slot('2026-11-13', '09:00', '09:45', 'Computer Science A', 'D101', 'Mr. Chen'),
    slot('2026-11-16', '08:00', '08:45', 'Chinese History', 'A210', 'Mr. Li Ming'),
  ],
  assignments: [
    {id: 'a1', title: 'Problem set 4', course: 'AP Physics C', due: '2026-11-14', score: null},
    {id: 'a2', title: 'Essay draft', course: 'English Literature', due: '2026-11-13', score: null},
    {id: 'a3', title: 'Quiz 2', course: 'AP Physics C', due: '2026-11-03', score: 18, total: 20},
  ],
  attendance: [
    {course: 'AP Physics C', status: 'Tardy', date: '2026-11-05'},
    {course: 'Chinese History', status: 'Absent', date: '2026-11-10'},
  ],
};
const ask = (question, options = {}) => A.answer(question, snapshot, {now, ...options});
const expectText = (question, ...parts) => {
  const result = ask(question);
  for (const part of parts) assert.ok(result.text.includes(part), `"${question}" → "${result.text}" should include "${part}"`);
  return result;
};

test('grades are read from the matching course in both languages', () => {
  expectText('What is my grade in AP Physics C?', 'AP Physics C', 'B+ (88%)');
  expectText('我微积分成绩是多少？', 'AP Calculus BC', 'A- (91.5%)');
  expectText('物理考了多少分', 'AP Physics C', 'B+ (88%)');
  expectText('how am I doing in english', 'English Literature', 'A (95%)');
  expectText('计算机成绩', 'Computer Science A', '还没有公布成绩');
  assert.equal(ask('我微积分成绩是多少？').language, 'zh');
  assert.equal(ask('What is my grade in AP Physics C?').language, 'en');
});

test('rooms and teachers resolve across languages, the cases the bare model got wrong', () => {
  const room = expectText('物理课在哪间教室上？', 'AP Physics C', 'C310');
  assert.ok(!room.text.includes('B204'));
  expectText('谁教英语文学？', 'English Literature', 'Ms. Sarah Brown');
  expectText('Which room is history in?', 'Chinese History', 'A210');
  expectText('Who teaches calculus?', 'AP Calculus BC', 'Ms. Zhang Wei');
  expectText('历史课是哪位老师教的，在哪间教室？', 'Mr. Li Ming', 'A210');
});

test('a course that does not exist is reported, never invented', () => {
  const result = ask('Who teaches chemistry?');
  assert.equal(result.status, 'no-course');
  assert.ok(!/Mr\.|Ms\./.test(result.text.split('Your courses are')[0]));
  assert.equal(ask('化学老师是谁').status, 'no-course');
  assert.deepEqual(ask('Who teaches chemistry?').must, []);
  assert.deepEqual(ask('Who teaches chemistry?').courses, []);
});

test('lowest, highest and all grades are computed from the data', () => {
  expectText('Which class has my lowest grade?', 'Chinese History', 'B (84%)');
  expectText('哪门课成绩最高？', 'English Literature', 'A (95%)');
  const all = ask('所有成绩');
  assert.equal(all.facts.length, 4);
  assert.ok(all.text.includes('AP Calculus BC: A- (91.5%)'));
});

test('class times, next class and day schedules use the real timetable', () => {
  expectText('When does my Chinese History class start today?', 'Chinese History', '13:30', '14:15', 'today');
  expectText('我今天第一节课是什么，几点开始？', 'AP Calculus BC', '08:00', '今天');
  expectText('What is my next class?', 'AP Physics C', '10:05', 'C310');
  expectText('下一节课是什么', 'AP Physics C', '10:05');
  expectText('what am I in right now', 'English Literature', '09:45');
  const tomorrow = expectText('明天有什么课？', '明天有 2 节课', 'AP Physics C', 'Computer Science A', 'D101');
  assert.equal(tomorrow.facts.length, 2);
  expectText('What classes do I have on Saturday?', 'no classes');
  expectText('周一有什么课', 'Chinese History', '08:00');
  expectText('when is my next history class', 'Chinese History', 'today', '13:30');
  expectText('last class today', 'Chinese History', '13:30');
});

test('a bare course name returns everything known about it', () => {
  const result = expectText('AP Physics C', 'B+ (88%)', 'C310', 'Mr. David Miller', '10:05');
  assert.deepEqual(result.facts.map(item => item.label), ['Course', 'Grade', 'Room', 'Teacher', 'Day', 'Time']);
});

test('unclear questions and missing data are stated plainly', () => {
  assert.equal(ask('explain photosynthesis').status, 'unknown');
  assert.equal(A.answer('我的成绩', {courses: [], schedule: []}, {now}).status, 'no-data');
  assert.equal(A.answer('my grade', null, {now}).status, 'no-data');
});

test('model wording is accepted only when every fact survives unchanged', () => {
  const result = ask('物理课在哪间教室上？');
  assert.equal(A.acceptRephrase('你的 AP Physics C 课在 C310 教室上课哦。', result, snapshot), '你的 AP Physics C 课在 C310 教室上课哦。');
  assert.equal(A.acceptRephrase('物理课在B204教室上。', result, snapshot), '', 'wrong room');
  assert.equal(A.acceptRephrase('AP Physics C 在 C310 教室，老师是 Mr. David Miller。', result, snapshot), '', 'added teacher');
  assert.equal(A.acceptRephrase('AP Physics C 在 C310 教室，AP Calculus BC 在隔壁。', result, snapshot), '', 'other course');
  assert.equal(A.acceptRephrase('AP Physics C is in room C310.', result, snapshot), '', 'wrong language');
  assert.equal(A.acceptRephrase('', result, snapshot), '');
  assert.ok(A.acceptRephrase('物理课在 C310 教室上。', result, snapshot), 'subject word stands in for the course name');
  assert.equal(A.acceptRephrase('数学课在 C310 教室上。', result, snapshot), '', 'subject of another course');
  assert.equal(A.acceptRephrase('这门课在 C310 教室上。', result, snapshot), '', 'course not named at all');
  const both = ask('历史课是哪位老师教的，在哪间教室？');
  assert.ok(A.acceptRephrase('历史课是 Mr. Li Ming 教的，在 A210 教室上课。', both, snapshot));
  assert.equal(A.acceptRephrase('历史课是 Mr. Li Ming 教的。', both, snapshot), '', 'dropped the room');
  const grade = ask('What is my grade in AP Physics C?');
  assert.ok(A.acceptRephrase('You currently have a B+ (88%) in AP Physics C. Nice work!', grade, snapshot));
  assert.equal(A.acceptRephrase('You have a B+ (89%) in AP Physics C.', grade, snapshot), '', 'changed number');
  assert.equal(A.acceptRephrase('You have a B+ (88%) in AP Physics C, top 5 in class.', grade, snapshot), '', 'new number');
});

test('prompts stay bounded and match the question language', () => {
  const zh = A.rephrasePrompt('物理课在哪间教室上？', ask('物理课在哪间教室上？'));
  assert.ok(zh.system.includes('中文') && zh.user.includes('C310'));
  const en = A.rephrasePrompt('q'.repeat(2000), ask('Who teaches calculus?'));
  assert.ok(en.user.length < 500 && en.system.includes('English'));
  assert.ok(A.chatPrompt('你好', 'zh').system.includes('不要编造'));
  assert.equal(A.EXAMPLES.zh.length, A.EXAMPLES.en.length);
  for (const lang of ['en', 'zh']) for (const example of A.EXAMPLES[lang]) assert.notEqual(A.answer(example, snapshot, {now}).status, 'unknown', example);
});

test('assignments and attendance stay reachable by asking', () => {
  const due = expectText('What assignments are due?', '2 assignments', 'Essay draft', 'Problem set 4', '11/13');
  assert.ok(due.text.indexOf('Essay draft') < due.text.indexOf('Problem set 4'), 'soonest first');
  assert.ok(!due.text.includes('Quiz 2'), 'past work is left out when something is upcoming');
  expectText('物理有哪些作业要交？', '1 项作业', 'Problem set 4', '11月14日');
  assert.ok(!ask('物理有哪些作业要交？').text.includes('Essay draft'));
  expectText('看看我的考勤', '最近 2 条考勤记录', 'Chinese History: Absent', 'AP Physics C: Tardy');
  expectText('Was I late to physics?', 'AP Physics C: Tardy');
  assert.ok(ask('What assignments are due?').facts.length === 2);
  assert.ok(A.answer('show my attendance', {courses: snapshot.courses, schedule: [], attendance: []}, {now}).text.includes('No attendance records'));
});
