import { describe, expect, it } from 'vitest';
import {
  parseAssignmentLookupRequest,
  parsePowerSchoolCourseDetails,
  parsePowerSchoolProgress,
  parsePowerSchoolSchedule,
} from './powerschool-parser';

describe('parsePowerSchoolSchedule', () => {
  it('parses Chinese AM/PM times, teachers, rooms, and course IDs', () => {
    const week = `
      <table id="tableStudentSchedMatrix">
        <tr><td class="scheduleClass1" name="attCell20260824">Computer Science<br>Jemli, Sofien<br>5218<br>09:00 上午 - 09:40 上午</td></tr>
        <tr><td class="scheduleClass2" name="attCell20260824">Activity<br>Sun, Sherry<br><br>01:15 下午 - 02:00 下午</td></tr>
        <tr><td class="scheduleBreak" name="attCell20260824">Lunch</td></tr>
      </table>`;
    const matrix = `
      <table id="schedMatrixTable"><tbody>
        <tr><td class="matrix_1"><p class="sched-course-name">Computer Science</p><p class="sched-section-number">CS-1</p><p class="sched-teacher-name">Jemli, Sofien</p><p class="sched-room">Room: 5218</p><p class="sched-term">Mon 09:00</p></td>
        <td class="matrix_2"><p class="sched-course-name">Activity</p><p class="sched-section-number">ACT-1</p><p class="sched-teacher-name">Sun, Sherry</p><p class="sched-room">Room: </p><p class="sched-term">Mon 13:15</p></td></tr>
        <tr><td class="matrix_1"><p class="sched-course-name">Computer Science</p><p class="sched-section-number">CS-1</p><p class="sched-teacher-name">Jemli, Sofien</p><p class="sched-room">Room: 5218</p></td></tr>
      </tbody></table>`;
    const result = parsePowerSchoolSchedule(week, matrix);
    expect(result.sessions).toHaveLength(2);
    expect(result.courses).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({ courseId: 'CS-1', teacher: 'Jemli, Sofien', room: '5218' });
    expect(new Date(result.sessions[0].startsAt).getHours()).toBe(9);
    expect(new Date(result.sessions[1].startsAt).getHours()).toBe(13);
    expect(result.sessions[1].room).toBe('');
  });
});

describe('parsePowerSchoolProgress', () => {
  it('parses grade summaries, totals, and grouped attendance events', () => {
    const home = `
      <table class="linkDescList grid">
        <tr><th>Meeting</th><th>Course</th><th>S1</th><th>Absences</th><th>Tardies</th></tr>
        <tr id="ccid_42">
          <td>P1-P2(Mon)</td>
          <td>Algebra<br><a title="Details about Alex Teacher"></a><a href="mailto:teacher@example.test">Email Alex Teacher</a><span class="display-flex">- Rm: 210</span></td>
          <td><a href="scores.html?frn=0042&amp;fg=S1&amp;schoolid=1">A</a></td><td>2</td><td>1</td>
        </tr>
        <tr id="ccid_43">
          <td>P3(Tue)</td><td>Advisory<br><a href="mailto:advisor@example.test">Email Sam Advisor</a></td>
          <td><span class="screen_readers_only">Not available</span></td><td>0</td><td>0</td>
        </tr>
      </table>
      <span id="termAbsTotal">2</span><span id="termTarTotal">1</span>`;
    const attendance = `
      <table class="grid">
        <tr><th rowspan="2">Course</th><th rowspan="2">Meeting</th><th colspan="2">Week</th></tr>
        <tr><th title="Monday, 24 August 2026">Mon</th><th title="Tuesday, 25 August 2026">Tue</th></tr>
        <tr><td>Algebra<br>Alex Teacher</td><td>P1-P2(Mon)</td><td>X<br>X</td><td>T</td></tr>
        <tr><th rowspan="2">Course</th><th rowspan="2">Meeting</th><th>Week</th></tr>
        <tr><th title="Wednesday, 26 August 2026">Wed</th></tr>
        <tr><td>Algebra<br>Alex Teacher</td><td>P1-P2(Mon)</td><td>-</td></tr>
      </table>`;

    const result = parsePowerSchoolProgress(home, attendance);

    expect(result).toMatchObject({ term: 'S1', absenceTotal: 2, tardyTotal: 1, attendanceStart: '2026-08-24', attendanceEnd: '2026-08-26' });
    expect(result.courses).toHaveLength(2);
    expect(result.courses[0]).toMatchObject({ id: '42', name: 'Algebra', teacher: 'Alex Teacher', room: '210', grade: 'A', absences: 2, tardies: 1, detailsPath: '/guardian/scores.html?frn=0042&fg=S1&schoolid=1' });
    expect(result.courses[1]).toMatchObject({ grade: '', detailsPath: '' });
    expect(result.attendanceEvents).toEqual([
      expect.objectContaining({ date: '2026-08-25', kind: 'tardy', label: 'Tardy', count: 1 }),
      expect.objectContaining({ date: '2026-08-24', kind: 'absence', label: 'Absent', count: 2 }),
    ]);
  });

  it('keeps course identity and the selected grade aligned across multiple terms and trailing columns', () => {
    const home = `
      <select name="fg"><option value="Q1">Q1</option><option value="Q2" selected>Q2</option></select>
      <table class="grid"><tr><th>Exp</th><th>Course</th><th>Q1</th><th>Q2</th><th>S1</th><th>Absences</th><th>Tardies</th><th>Actions</th></tr>
        <tr id="ccid_71"><td>P2(Mon)</td>
          <td>Calculus<br><a title="Details about Example Teacher"></a><a href="mailto:teacher@example.test">Email Example Teacher</a><span class="display-flex">- Rm: 205</span></td>
          <td><a href="scores.html?frn=0071&amp;fg=Q1">A-</a></td>
          <td><a href="scores.html?frn=0071&amp;fg=Q2">B+</a></td>
          <td><a href="scores.html?frn=0071&amp;fg=S1">[i]</a></td><td>3</td><td>2</td><td>Details</td></tr>
      </table>`;
    const result = parsePowerSchoolProgress(home);
    expect(result.term).toBe('Q2');
    expect(result.courses).toHaveLength(1);
    expect(result.courses[0]).toMatchObject({ name: 'Calculus', teacher: 'Example Teacher', room: '205', meetingPattern: 'P2(Mon)',
      grade: 'B+', term: 'Q2', absences: 3, tardies: 2, detailsPath: '/guardian/scores.html?frn=0071&fg=Q2' });
  });

  it('resolves grouped headers and keeps an explicitly current unposted term empty', () => {
    const home = `<table class="grid">
      <tr><th rowspan="2">Meeting</th><th rowspan="2">Course</th><th colspan="2">Grades</th><th colspan="2">Attendance</th><th rowspan="2">Actions</th></tr>
      <tr><th>S1</th><th class="current-term" aria-current="true">S2</th><th>Tardies</th><th>Absences</th></tr>
      <tr id="ccid_72"><td>P3(Tue)</td><td>Physics<br><a href="mailto:teacher@example.test">Email Teacher Two</a><span class="display-flex">Rm: 303</span></td>
        <td><a href="scores.html?frn=0072&amp;fg=S1">A-</a></td><td>[i]</td><td>1</td><td>4</td><td>View</td></tr>
      </table>`;
    const result = parsePowerSchoolProgress(home);
    expect(result.courses[0]).toMatchObject({ name: 'Physics', teacher: 'Teacher Two', grade: '', term: 'S2', detailsPath: '', absences: 4, tardies: 1 });
  });

  it('uses course semantics and one real score link when header metadata is unavailable', () => {
    const home = `<table class="grid"><tr id="ccid_73"><td>P4(Wed)</td><td>Course tools</td>
      <td>Literature<br><a title="Details about Teacher Three"></a><a href="mailto:teacher@example.test">Email Teacher Three</a><span class="display-flex">Rm: 304</span></td>
      <td><a href="scores.html?frn=0073&amp;fg=S1">[i]</a></td><td><a href="scores.html?frn=0073&amp;fg=S2">A</a></td>
      <td>8</td><td>7</td><td>More</td></tr></table>`;
    expect(parsePowerSchoolProgress(home).courses[0]).toMatchObject({ name: 'Literature', teacher: 'Teacher Three', grade: '', term: 'S1',
      detailsPath: '/guardian/scores.html?frn=0073&fg=S1', absences: null, tardies: null });
  });

  it('matches a selected term label when the selector value is a numeric term id', () => {
    const home = `<select name="termid"><option value="3600">S1</option><option value="3601" selected>S2</option></select>
      <table class="grid"><tr><th colspan="7">Course grades</th></tr><tr><th>Period</th><th>Course Name</th><th>S1</th><th>S2</th><th>Absences</th><th>Tardies</th><th>Extra</th></tr>
      <tr id="ccid_74"><td>P5</td><td>Biology</td><td><a href="scores.html?frn=0074&amp;fg=S1">B</a></td>
      <td><a href="scores.html?frn=0074&amp;fg=S2">A-</a></td><td>0</td><td>0</td><td>GPA</td></tr></table>`;
    expect(parsePowerSchoolProgress(home).courses[0]).toMatchObject({ name: 'Biology', grade: 'A-', term: 'S2', absences: 0, tardies: 0 });
  });

  it('ignores lookalike score URLs and never treats grade-only cells as a course', () => {
    const home = `<table class="grid"><tr><th>Meeting</th><th>Course</th><th>Q1</th><th>Q2</th><th>Absences</th><th>Tardies</th><th>Extra</th></tr>
      <tr id="ccid_75"><td>P6</td><td>Chemistry</td><td><a href="javascript:scores.html">Wrong</a></td>
        <td><a href="scores.html?frn=0075&amp;fg=Q2">B+</a></td><td>0</td><td>0</td><td>Help</td></tr>
      </table><table class="grid"><tr id="ccid_bad"><td>P1</td><td>A-</td><td>B+</td><td>0</td><td>0</td></tr></table>`;
    expect(parsePowerSchoolProgress(home).courses[0]).toMatchObject({ name: 'Chemistry', grade: 'B+', term: 'Q2', detailsPath: '/guardian/scores.html?frn=0075&fg=Q2' });
    expect(parsePowerSchoolProgress('<table class="grid"><tr id="ccid_bad"><td>P1</td><td>A-</td><td>B+</td><td>0</td><td>0</td></tr></table>').courses).toHaveLength(0);
  });

  it('returns safe empty states when progress tables are unavailable', () => {
    expect(parsePowerSchoolProgress('<html></html>')).toMatchObject({
      term: '', absenceTotal: null, tardyTotal: null, courses: [], attendanceEvents: [],
    });
  });
});

describe('PowerSchool assignment parsing', () => {
  const scorePage = `
    <div class="comment"><pre>Good participation.</pre></div>
    <div class="comment"><pre>Introduction to algebra.</pre></div>
    <div class="xteContentWrapper" data-ng-init="studentFRN = '00177'; beginningDate = '24-08-2026'; endingDate = '30-01-2027'; storecode = 'S1';">
      <div data-pss-student-assignment-scores data-sectionid="2543" data-termid="3600"></div>
    </div>`;

  it('builds the same date-range lookup used by PowerSchool', () => {
    expect(parseAssignmentLookupRequest(scorePage)).toEqual({
      section_ids: [2543], student_ids: [77], start_date: '2026-8-24', end_date: '2027-1-30',
    });
  });

  it('parses assignment scores and status flags', () => {
    const response = JSON.stringify([{
      assignmentid: 9001,
      _assignmentsections: [{
        name: 'Linear equations', description: '<p>Complete questions <strong>1-5</strong>.</p><p>Show your work.<br>Submit in class.</p>', duedate: '2026-8-31',
        isscorespublish: true, iscountedinfinalgrade: true, totalpointvalue: 10,
        _assignmentscores: [{ scorepoints: 8, scorepercent: 80, scorelettergrade: 'B', islate: true, ismissing: false, isabsent: false, isexempt: false, isincomplete: false }],
        _assignmentcategoryassociations: [{ _teachercategory: { name: 'Homework' } }],
      }],
    }]);

    const details = parsePowerSchoolCourseDetails(scorePage, response);

    expect(details).toMatchObject({ teacherComment: 'Good participation.', description: 'Introduction to algebra.' });
    expect(details.assignments).toEqual([expect.objectContaining({ id: '9001', name: 'Linear equations', description: 'Complete questions 1-5. Show your work. Submit in class.', dueDate: '2026-08-31', category: 'Homework', pointsEarned: 8, pointsPossible: 10, percent: 80, letterGrade: 'B', isLate: true })]);
  });

  it('uses an empty assignment list for a valid empty response', () => {
    expect(parsePowerSchoolCourseDetails(scorePage, '[]').assignments).toEqual([]);
  });
});
