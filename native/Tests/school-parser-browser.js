/* Synthetic contract fixtures; no school account, captured personal data, or native mock. */
(() => {
  'use strict';
  const results = [], failures = [];
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const test = (name, callback) => {
    try { callback(); results.push(name); }
    catch (error) { failures.push({name,message:error.message}); }
  };
  const home = '<table><tr id="ccid_math"><td>1(A)</td><td>Mathematics<br><a href="mailto:teacher@example.invalid">Teacher One</a><br><span class="display-flex">Rm: 101</span></td><td><a href="/guardian/scores.html?sectionid=1">A</a></td><td>0</td><td>0</td></tr></table>';
  const matrix = '<table id="schedMatrixTable"><tr><td><span class="sched-course-name">Mathematics</span><span class="sched-section-number">math</span><span class="sched-teacher-name">Teacher One</span><span class="sched-room">Room: 101</span></td></tr></table>';
  const emptyWeek = '<table id="tableStudentSchedMatrix"><thead><tr><th>Monday</th></tr></thead><tbody></tbody></table>';
  const populatedWeek = '<table id="tableStudentSchedMatrix"><tr><td name="attCell20261019" class="scheduleClass1">Mathematics<br>Teacher One<br>101<br>8:00 AM - 9:00 AM</td></tr></table>';
  const snapshot = (week, replacementMatrix = matrix) => schoolParser('snapshot',{week,matrix:replacementMatrix,home,attendance:''});
  const rejects = (week, replacementMatrix) => {
    let rejected=false;
    try { snapshot(week,replacementMatrix); } catch (_) { rejected=true; }
    check(rejected,'Unrecognized or invalid schedule HTML must fail.');
  };
  test('recognized empty weekly table allows grade refresh', () => {
    const value=snapshot(emptyWeek);
    check(value.schedule.length===0,'Empty week must return an empty schedule.');
    check(value.courses.length===1 && value.courses[0].grade==='A','An empty week must still refresh grades.');
    check(value.courses[0].absences===0 && value.courses[0].tardies===0,'Zero attendance totals must survive.');
    check(Number.isFinite(Date.parse(value.syncedAt)),'Successful empty week must record a real sync timestamp.');
  });
  test('holiday and non-class cells remain a valid empty week', () => {
    const value=snapshot('<table id="tableStudentSchedMatrix"><tr><td name="attCell20261019" class="notInSession">Holiday</td><td name="attCell20261020" class="scheduleClass0">&nbsp;<br></td></tr></table>');
    check(value.schedule.length===0 && value.courses[0].grade==='A','Holiday must not block course data.');
  });
  test('populated weekly schedule still parses dated classes', () => {
    const value=snapshot(populatedWeek);
    check(value.schedule.length===1,'Expected one class.');
    check(value.schedule[0].title==='Mathematics' && value.schedule[0].room==='101','Expected real parsed metadata.');
    check(value.schedule[0].start==='2026-10-19T00:00:00.000Z','Class time must retain Shanghai timezone conversion.');
    const withHoliday=snapshot(populatedWeek.replace('<tr>','<tr><td name="attCell20261018" class="notInSession">Holiday</td>'));
    check(withHoliday.schedule[0].id==='20261019.1','Existing schedule identity must retain its cell index.');
  });
  test('unrecognized maintenance pages and wrong table elements are rejected', () => {
    rejects('<h1>Maintenance</h1>');
    rejects('<div id="tableStudentSchedMatrix">Not the weekly table</div>');
    rejects('');
  });
  test('sign-in pages are rejected even if a weekly table remains in the page', () => {
    rejects(emptyWeek+'<form><input name="account"><input type="password" name="pw"></form>');
    rejects(emptyWeek,'<form><input name="account"></form>');
  });
  test('malformed class cells cannot be misreported as an empty week', () => {
    rejects('<table id="tableStudentSchedMatrix"><tr><td name="attCell20261019" class="scheduleClass1">Mathematics<br>Time unavailable</td></tr></table>');
    rejects('<table id="tableStudentSchedMatrix"><tr><td name="attCell20260230" class="scheduleClass1">Mathematics<br>8:00 AM - 9:00 AM</td></tr></table>');
    rejects('<table id="tableStudentSchedMatrix"><tr><td name="attCell" class="scheduleClass1">Mathematics<br>8:00 AM - 9:00 AM</td></tr></table>');
  });
  test('remote school scripts remain inert and are never executed', () => {
    delete window.schoolParserUntrustedScriptExecuted;
    const script='<script>window.schoolParserUntrustedScriptExecuted=true;<\/script>';
    const value=snapshot(emptyWeek+script);
    check(value.schedule.length===0,'Recognized table should still parse.');
    check(window.schoolParserUntrustedScriptExecuted===undefined,'Remote script executed while parsing.');
  });
  test('oversized documents are rejected before DOM parsing', () => {
    rejects(' '.repeat(4*1024*1024+1));
  });
  const report=document.createElement('script');
  report.id='school-parser-test-results';report.type='application/json';report.textContent=JSON.stringify({passed:results.length,tests:results,failures});
  document.body.append(report);
  const summary=document.createElement('pre');summary.textContent=failures.length?JSON.stringify(failures,null,2):`${results.length} DOM parser tests passed.`;document.body.append(summary);
})();
