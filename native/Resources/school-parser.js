/* Original inert-document parser for PowerSchool's public HTML/data contract. */
(() => {
  'use strict';
  const words = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const documentFrom = html => {
    if (String(html).length > 4 * 1024 * 1024) throw Error('School response exceeds 4 MB.');
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc.querySelectorAll('script,style,template,.screen_readers_only').forEach(node => node.remove());
    return doc;
  };
  const text = node => words(node?.textContent);
  const lines = node => {
    if (!node) return [];
    const copy = node.cloneNode(true);
    copy.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    return copy.textContent.split('\n').map(words).filter(Boolean);
  };
  const count = value => { const s = words(value); const n = Number(s.replace(/,/gu, '')); return s && Number.isFinite(n) ? n : null; };
  function datedTime(code, time) {
    const m = /^(\d{4})(\d{2})(\d{2})$/u.exec(code), t = /(\d{1,2}):(\d{2})\s*(am|pm|上午|下午)?/iu.exec(time);
    if (!m || !t) return null;
    let h = +t[1], min = +t[2]; const suffix = (t[3] || '').toLowerCase();
    if (suffix && (h < 1 || h > 12)) return null;
    if (/pm|下午/u.test(suffix) && h !== 12) h += 12;
    if (/am|上午/u.test(suffix) && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const calendar = new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
    if (calendar.getUTCFullYear() !== +m[1] || calendar.getUTCMonth()+1 !== +m[2] || calendar.getUTCDate() !== +m[3]) return null;
    // WLSA's academic schedule is in Shanghai time even on a travelling Mac.
    const iso = `${m[1]}-${m[2]}-${m[3]}T${String(h).padStart(2,'0')}:${t[2]}:00+08:00`;
    const d = new Date(iso);
    return Number.isFinite(d.valueOf()) ? d.toISOString() : null;
  }
  function fields(html) {
    const doc = documentFrom(html), result = {};
    doc.querySelectorAll('input[name]').forEach(input => { if (input.type === 'hidden') result[input.name] = input.value; });
    return { fields: result, signIn: !!doc.querySelector('input[name="account"]') };
  }
  function schedule(week, matrix) {
    const matrixDoc = documentFrom(matrix), weekDoc = documentFrom(week), courses = [], sessions = [];
    matrixDoc.querySelectorAll('#schedMatrixTable td').forEach((cell, i) => {
      const name = text(cell.querySelector('.sched-course-name')); if (!name) return;
      const course = { id: text(cell.querySelector('.sched-section-number')) || `matrix-${i}`, name,
        teacher: text(cell.querySelector('.sched-teacher-name')), room: text(cell.querySelector('.sched-room')).replace(/^Room:\s*/iu,''), meetingPattern: text(cell.querySelector('.sched-term')) };
      if (!courses.some(c => c.id === course.id)) courses.push(course);
    });
    weekDoc.querySelectorAll('#tableStudentSchedMatrix [name^="attCell"]').forEach((cell, i) => {
      if (![...cell.classList].some(c => c.startsWith('scheduleClass'))) return;
      const code = /\d{8}/u.exec(cell.getAttribute('name') || '')?.[0], content = lines(cell);
      const time = content.findIndex(s => /\d:\d{2}.*[-–—].*\d:\d{2}/u.test(s));
      if (!code || time < 1) return;
      const ends = content[time].split(/\s*[-–—]\s*/u), start = datedTime(code, ends[0]), end = datedTime(code, ends[1]);
      if (!start || !end || end <= start) return;
      const course = courses.find(c => c.name.toLocaleLowerCase() === content[0].toLocaleLowerCase());
      sessions.push({ id: `${code}.${i}`, title: content[0], courseId: course?.id ?? null, teacher: course?.teacher || content[1] || '', room: course?.room || content[2] || '', start, end });
    });
    if (!sessions.length) throw Error('The school returned no supported weekly schedule.');
    return { courses, schedule: sessions.sort((a,b) => a.start.localeCompare(b.start)) };
  }
  function progress(html, attendanceHTML) {
    const doc = documentFrom(html), courses = [];
    doc.querySelectorAll('tr[id^="ccid_"]').forEach(row => {
      const cells = [...row.children].filter(c => c.tagName === 'TD'); if (cells.length < 5) return;
      const course = cells.at(-4), grade = cells.at(-3), bits = lines(course), mail = course.querySelector('a[href^="mailto:"]');
      const scorePath = grade.querySelector('a[href*="scores.html"]')?.getAttribute('href') ?? '';
      const room = text(course.querySelector('.display-flex')).replace(/^[-\s]*Rm:\s*/iu,'');
      const teacher = text(mail), teacherTitle = course.querySelector('a[title^="Details about "]')?.getAttribute('title')?.replace(/^Details about /u,'') || '';
      let name = bits.find(s => s !== teacher && !/^[-\s]*Rm:/iu.test(s)) || '';
      if (teacher && name.endsWith(teacher)) name = words(name.slice(0, -teacher.length));
      if (!name) return;
      const id = row.id.substring(5);
      courses.push({ id, name, teacher: teacherTitle || teacher, room, meetingPattern: text(cells[0]), grade: text(grade).replace(/^\[\s*i\s*\]$/iu,''), absences: count(text(cells.at(-2))), tardies: count(text(cells.at(-1))), detailsPath: scorePath });
    });
    const attendance = [], adoc = documentFrom(attendanceHTML || '');
    adoc.querySelectorAll('table.grid').forEach(table => {
      let dates = [];
      table.querySelectorAll('tr').forEach(row => {
        const headers = [...row.querySelectorAll('th[title]')];
        if (headers.length) { dates = headers.map(h => { const d = new Date(h.title.replace(/[\u200e\u200f]/gu,'')); return Number.isFinite(+d) ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : ''; }); return; }
        const cells = [...row.children].filter(c => c.tagName === 'TD');
        if (cells.length < 3 || !dates.length) return;
        const course = lines(cells[0])[0] || '';
        cells.slice(2, 2 + dates.length).forEach((c,i) => {
          if (!dates[i] || c.classList.contains('notInSession')) return;
          const status = text(c); if (!status || /^[.\-]$/u.test(status)) return;
          attendance.push({ id: `${dates[i]}.${course}.${i}`, date: dates[i], course, status, description: c.querySelector('[title]')?.title || status });
        });
      });
    });
    return { courses, attendance, absenceTotal: count(text(doc.querySelector('#termAbsTotal'))), tardyTotal: count(text(doc.querySelector('#termTarTotal'))) };
  }
  function details(html, assignments) {
    const doc = documentFrom(html), comments = [...doc.querySelectorAll('.comment')].map(text), result = [];
    for (const record of Array.isArray(assignments) ? assignments : []) {
      const section = Array.isArray(record._assignmentsections) ? record._assignmentsections[0] : record._assignmentsections;
      if (!section || section.isscorespublish === false) continue;
      const score = (Array.isArray(section._assignmentscores) ? section._assignmentscores[0] : section._assignmentscores) || {};
      const title = words(section.name || record._name); if (!title) continue;
      result.push({ id: String(record.assignmentid ?? record._id ?? result.length), title, description: text(documentFrom(section.description || '').body), due: section.duedate || '', score: count(score.scorepoints), total: count(section.totalpointvalue), percent: count(score.scorepercent), grade: words(score.scorelettergrade), late: !!score.islate, missing: !!score.ismissing, exempt: !!score.isexempt, incomplete: !!score.isincomplete, countsInFinalGrade: section.iscountedinfinalgrade !== false });
    }
    const init = doc.querySelector('.xteContentWrapper[data-ng-init]')?.getAttribute('data-ng-init') || '', target = doc.querySelector('[data-pss-student-assignment-scores]');
    const lookup = {}, value = key => new RegExp(`\\b${key}\\s*=\\s*'([^']*)'`,'u').exec(init)?.[1] || '';
    const student = /^001(\d+)$/u.exec(value('studentFRN'))?.[1], section = target?.getAttribute('data-sectionid');
    if (student && /^\d+$/u.test(section || '')) {
      lookup.student_ids = [Number(student)]; lookup.section_ids = [Number(section)];
      const convert = str => str.replace(/^(\d{2})-(\d{2})-(\d{4})$/u,'$3-$1-$2');
      if (value('beginningDate') && value('endingDate')) { lookup.start_date = convert(value('beginningDate')); lookup.end_date = convert(value('endingDate')); }
      else if (value('storecode')) lookup.store_codes = [value('storecode')];
      else if (/^\d+$/u.test(target?.getAttribute('data-termid') || '')) lookup.term_ids = [Number(target.getAttribute('data-termid'))];
    }
    return { description: comments[1] || '', teacherComment: comments[0] || '', assignments: result, lookup: lookup.student_ids ? lookup : null };
  }
  globalThis.schoolParser = (kind, data) => {
    switch (kind) {
      case 'fields': return fields(data.html);
      case 'snapshot': return { ...schedule(data.week, data.matrix), ...progress(data.home, data.attendance), syncedAt: new Date().toISOString() };
      case 'details': return details(data.html, data.assignments);
      case 'entities': return { text: text(documentFrom(data.text).body) };
      default: throw Error('Unknown school parser operation.');
    }
  };
  globalThis.SchoolParserHelpers = { words, count, datedTime };
})();
