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
  test('grade and course text exclude hidden accessibility labels', () => {
    const noisyHome='<table><tr id="ccid_reading"><td>1(A)</td><td><span class="sr-only">Course details </span>中文 &amp; History<br><a href="mailto:teacher@example.invalid" title="Details about 李老师">李老师<span class="screen-readers-only"> Email teacher</span></a><br><span class="display-flex">Rm: 101<span hidden> Room details</span></span></td><td><a href="/guardian/scores.html?sectionid=1">A<span aria-hidden="true">+</span><span class="sr-only"> View grade details</span><span hidden> Hidden grade label</span><span style="display:none"> Invisible grade label</span></a></td><td>0</td><td>0</td></tr></table>';
    const value=schoolParser('snapshot',{week:emptyWeek,matrix,home:noisyHome,attendance:''}),course=value.courses[0];
    check(course.grade==='A+','Hidden accessibility text contaminated the displayed grade: '+course.grade);
    check(course.name==='中文 & History','Hidden accessibility text contaminated the course name: '+course.name);
    check(course.teacher==='李老师','Teacher Unicode or visible label changed.');
    check(course.room==='101','Hidden labels contaminated the room.');
  });
  const multiTermHome=(options={}) => {
    const selected=options.explicit===false?'':'<select name="fg"><option value="Q1">Q1</option><option value="Q2" selected>Q2</option></select>';
    const q1=options.q1 ?? 'A',q2=options.q2 ?? '[i]';
    return selected+'<table><thead><tr><th rowspan="2">Exp</th><th rowspan="2">Last week</th><th rowspan="2">This week</th><th rowspan="2">Course</th><th colspan="2">Grades</th><th colspan="2">Attendance totals</th><th rowspan="2"></th></tr><tr><th data-storecode="Q1">Q1</th><th data-storecode="Q2"'+(options.currentHeader?' aria-current="true"':'')+'>Q2</th><th>Absences</th><th>Tardies</th></tr></thead><tbody><tr id="ccid_science"><td>2(A)</td><td><table><tr><th>Mon</th><td>0</td></tr></table></td><td>0</td><td>科学 &amp; History<br><a href="mailto:teacher@example.invalid" title="Details about 李老师">李老师</a><br><span class="display-flex">- Rm: 5218</span></td><td><a href="scores.html?frn=00142&amp;fg=Q1">'+q1+'</a></td><td>'+(options.noCurrentLink?q2:'<a href="scores.html?frn=00142&amp;fg=Q2">'+q2+'</a>')+'</td><td>2</td><td>0</td><td>77</td></tr></tbody></table>';
  };
  test('multi-term rows discover course and attendance columns without tail offsets', () => {
    for(const grade of ['[i]','B+']){
      const value=schoolParser('snapshot',{week:emptyWeek,matrix,home:multiTermHome({q2:grade}),attendance:''}),course=value.courses[0];
      check(course.name==='科学 & History','A term grade was misread as the course: '+course.name);
      check(course.teacher==='李老师' && course.room==='5218','Semantic teacher/room fields were lost.');
      check(course.grade===(grade==='[i]'?'':grade),'The selected current term grade was not preserved.');
      check(course.absences===2 && course.tardies===0,'Trailing extra columns corrupted attendance counts.');
      check(course.detailsPath.includes('fg=Q2'),'Grade and details URL must use the same selected term.');
    }
  });
  test('ambiguous terms retain the first scores link even if its grade is unposted', () => {
    const course=schoolParser('snapshot',{week:emptyWeek,matrix,home:multiTermHome({explicit:false,q1:'[i]',q2:'B+'}),attendance:''}).courses[0];
    check(course.grade==='' && course.detailsPath.includes('fg=Q1'),'Do not substitute another semester solely because it has a posted grade.');
  });
  test('an explicitly current header wins even without a posted grade or scores link', () => {
    const course=schoolParser('snapshot',{week:emptyWeek,matrix,home:multiTermHome({explicit:false,currentHeader:true,noCurrentLink:true}),attendance:''}).courses[0];
    check(course.grade==='' && course.detailsPath==='','A genuinely unposted selected term must not borrow another term’s grade/details.');
  });
  test('explicit Course header works without teacher contact markup', () => {
    const value=schoolParser('snapshot',{week:emptyWeek,matrix,home:'<table><tr><th>Course</th><th>Grade</th><th>Absences</th><th>Tardies</th><th></th></tr><tr id="ccid_plain"><td>中文 Physics &amp; History</td><td><a href="scores.html?fg=T1">A-</a></td><td>3</td><td>1</td><td>99</td></tr></table>',attendance:''});
    const course=value.courses[0];
    check(course.name==='中文 Physics & History' && course.teacher==='','Course header should identify a course without teacher details.');
    check(course.grade==='A-' && course.absences===3 && course.tardies===1,'Header mapping failed.');
    check(course.detailsPath==='/guardian/scores.html?fg=T1','Relative score links must resolve under their guardian home page.');
  });
  test('grouped Course grades headers do not replace the leaf Course or shift rowspan columns', () => {
    const grouped=multiTermHome({q2:'B+'}).replace('<thead>','<thead><tr><th colspan="9">Course grades</th></tr>');
    const course=schoolParser('snapshot',{week:emptyWeek,matrix,home:grouped,attendance:''}).courses[0];
    check(course.name==='科学 & History' && course.teacher==='李老师','A broad Course grades group must not identify another column as the course.');
    check(course.grade==='B+' && course.detailsPath.includes('fg=Q2'),'Grouped rowspan headers shifted the selected grade column.');
    check(course.meetingPattern==='2(A)' && course.absences===2 && course.tardies===0,'Exp or attendance column mapping shifted.');
  });
  test('numeric selected term IDs use their selected semester label', () => {
    const selector='<select name="termid"><option value="3600">2026-2027</option><option value="3601" selected>S2</option></select>';
    const semesters=multiTermHome({explicit:false,q2:'B+'}).replaceAll('Q1','S1').replaceAll('Q2','S2');
    const course=schoolParser('snapshot',{week:emptyWeek,matrix,home:selector+semesters,attendance:''}).courses[0];
    check(course.grade==='B+' && course.detailsPath.includes('fg=S2'),'Numeric selection must resolve its S2 label to the same grade/details term.');
  });
  test('an unrelated school-year term selector does not suppress grade columns', () => {
    const selector='<select name="termid"><option value="3600" selected>2026-2027</option></select>';
    const course=schoolParser('snapshot',{week:emptyWeek,matrix,home:selector+multiTermHome({explicit:false,q1:'A',q2:'B+'}),attendance:''}).courses[0];
    check(course.grade==='A' && course.detailsPath.includes('fg=Q1'),'Unresolved school-year selection must retain the first source term.');
  });
  test('HTML entities decode once while valid Unicode and literal entity text stay intact', () => {
    const encodedHome=home.replace('Mathematics','中文 &amp; History').replace('>A</a>','>A&#43;</a>');
    const value=schoolParser('snapshot',{week:emptyWeek,matrix,home:encodedHome,attendance:''});
    check(value.courses[0].name==='中文 & History' && value.courses[0].grade==='A+','HTML text must decode one entity layer.');
    const detail=schoolParser('details',{html:'<div class="comment">教师说明：保留 &amp; &lt;literal&gt; 与 &amp;amp;</div><div class="comment">中文课程简介</div>',assignments:[]});
    check(detail.teacherComment==='教师说明：保留 & <literal> 与 &amp;','Comments were garbled or decoded more than once.');
    check(detail.description==='中文课程简介','Valid Unicode course description changed.');
  });
  test('HTML assignment descriptions retain paragraph and line boundaries', () => {
    const assignment={assignmentid:1,_assignmentsections:[{name:'Literal &amp; title',isscorespublish:true,description:'<p>第一段 &amp; A</p><p>Second paragraph<br>Third line</p><ul><li>One</li><li>Two</li></ul>'}]};
    const detail=schoolParser('details',{html:'',assignments:[assignment]});
    check(detail.assignments[0].description==='第一段 & A Second paragraph Third line One Two','HTML block/line boundaries were lost: '+detail.assignments[0].description);
    check(detail.assignments[0].title==='Literal &amp; title','Arbitrary JSON titles must not undergo speculative HTML decoding.');
    const multilineGrade=schoolParser('snapshot',{week:emptyWeek,matrix,home:home.replace('>A</a>','>A<br>95%</a>'),attendance:''});
    check(multilineGrade.courses[0].grade==='A 95%','Visible multi-line grade text must retain a word boundary.');
  });
  test('text cleanup preserves hidden form and assignment lookup metadata', () => {
    const fields=schoolParser('fields',{html:'<form><input type="hidden" hidden name="pstoken" value="fixture-token"><input name="account"></form>'});
    check(fields.fields.pstoken==='fixture-token' && fields.signIn,'Hidden sign-in fields must remain available to authentication.');
    const detail=schoolParser('details',{html:'<div class="xteContentWrapper" hidden data-ng-init="studentFRN=\'00142\'; storecode=\'T1\'"></div><div hidden data-pss-student-assignment-scores data-sectionid="7"></div>',assignments:[]});
    check(detail.lookup?.student_ids?.[0]===42 && detail.lookup?.section_ids?.[0]===7,'Hidden assignment lookup metadata must survive.');
  });
  test('oversized documents are rejected before DOM parsing', () => {
    rejects(' '.repeat(4*1024*1024+1));
  });
  const report=document.createElement('script');
  report.id='school-parser-test-results';report.type='application/json';report.textContent=JSON.stringify({passed:results.length,tests:results,failures});
  document.body.append(report);
  const summary=document.createElement('pre');summary.textContent=failures.length?JSON.stringify(failures,null,2):`${results.length} DOM parser tests passed.`;document.body.append(summary);
})();
