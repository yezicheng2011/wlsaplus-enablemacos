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
  const textNoise = '.screen_readers_only,.screen-readers-only,.sr-only,[hidden]';
  const hiddenText = node => Boolean(node?.matches?.(textNoise)) || node?.style?.display === 'none' || ['hidden','collapse'].includes(node?.style?.visibility);
  const readable = node => {
    if (!node || hiddenText(node)) return null;
    // Prune a clone only: hidden inputs and data attributes still belong to the form/lookup contract.
    const copy = node.cloneNode(true);
    copy.querySelectorAll(`${textNoise},[style]`).forEach(child => { if (hiddenText(child)) child.remove(); });
    return copy;
  };
  const text = node => {
    const copy = readable(node);
    // HTML block/line boundaries are visible whitespace, even though textContent omits them.
    copy?.querySelectorAll('br,p,div,li').forEach(child => { child.before(' '); child.after(' '); });
    return words(copy?.textContent);
  };
  const lines = node => {
    const copy = readable(node);
    if (!copy) return [];
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
    const weeklyTable = weekDoc.querySelector('table#tableStudentSchedMatrix');
    if (!weeklyTable || weekDoc.querySelector('input[name="account"]') || matrixDoc.querySelector('input[name="account"]')) throw Error('The school returned no supported weekly schedule.');
    const scheduleCells = [...weeklyTable.querySelectorAll('[name^="attCell"]')];
    const classCells = scheduleCells.filter(cell => text(cell) && [...cell.classList].some(name => name.startsWith('scheduleClass')));
    matrixDoc.querySelectorAll('#schedMatrixTable td').forEach((cell, i) => {
      const name = text(cell.querySelector('.sched-course-name')); if (!name) return;
      const course = { id: text(cell.querySelector('.sched-section-number')) || `matrix-${i}`, name,
        teacher: text(cell.querySelector('.sched-teacher-name')), room: text(cell.querySelector('.sched-room')).replace(/^Room:\s*/iu,''), meetingPattern: text(cell.querySelector('.sched-term')) };
      if (!courses.some(c => c.id === course.id)) courses.push(course);
    });
    scheduleCells.forEach((cell, i) => {
      if (![...cell.classList].some(name => name.startsWith('scheduleClass'))) return;
      const code = /\d{8}/u.exec(cell.getAttribute('name') || '')?.[0], content = lines(cell);
      const time = content.findIndex(s => /\d:\d{2}.*[-–—].*\d:\d{2}/u.test(s));
      if (!code || time < 1) return;
      const ends = content[time].split(/\s*[-–—]\s*/u), start = datedTime(code, ends[0]), end = datedTime(code, ends[1]);
      if (!start || !end || end <= start) return;
      const course = courses.find(c => c.name.toLocaleLowerCase() === content[0].toLocaleLowerCase());
      sessions.push({ id: `${code}.${i}`, title: content[0], courseId: course?.id ?? null, teacher: course?.teacher || content[1] || '', room: course?.room || content[2] || '', start, end });
    });
    // A recognized weekly table with no class entries is a legitimate holiday/empty week.
    // Class entries with no parseable sessions remain a contract error, rather than a false empty result.
    if (classCells.length && !sessions.length) throw Error('The school returned no supported weekly schedule.');
    return { courses, schedule: sessions.sort((a,b) => a.start.localeCompare(b.start)) };
  }
  const tableCells = row => [...row.children].filter(cell => /^(TD|TH)$/u.test(cell.tagName));
  const termKey = value => words(value).toUpperCase();
  const termFields = new Set(['fg','storecode','term','termid']);
  const termLabel = value => {
    const label = termKey(value);
    const short = /(?:^|[\s(])([QSTFY])\s*(\d{1,2})(?=$|[\s)])/u.exec(label);
    if (short) return short[1]+short[2];
    const long = /(?:^|\s)(QUARTER|SEMESTER|TRIMESTER|TERM)\s*(\d{1,2})(?=$|\s)/u.exec(label);
    return long ? ({QUARTER:'Q',SEMESTER:'S',TRIMESTER:'T',TERM:'T'}[long[1]]+long[2]) : '';
  };
  const nodeTerms = node => {
    const terms = [];
    for (const key of ['data-fg','data-storecode','data-term','data-termid']) {
      const value = termKey(node.getAttribute(key)); if (value) terms.push(value);
    }
    const label = termLabel(text(node)); if (label) terms.push(label);
    return terms;
  };
  const currentColumn = node => ['true','page'].includes(node.getAttribute('aria-current')) || node.getAttribute('aria-selected') === 'true' || node.getAttribute('data-current') === 'true' || [...node.classList].some(name => /^(?:current|selected|active)(?:[-_]?(?:term|grade))?$/iu.test(name));
  function columnHeaders(table) {
    const grid = [], rows = [...table.rows].filter(row => row.closest('table') === table);
    let line = 0;
    // Header spans describe logical columns; nested attendance mini-tables do not.
    for (const row of rows) {
      if (row.id.startsWith('ccid_')) break;
      const cells = tableCells(row);
      if (!cells.some(cell => cell.tagName === 'TH') && !row.closest('thead')) continue;
      if (line >= 16) break;
      grid[line] ||= [];
      let column = 0;
      for (const cell of cells) {
        while (grid[line][column] && column < 128) column++;
        const width = Math.min(Math.max(cell.colSpan,1),128-column), height = Math.min(Math.max(cell.rowSpan,1),16-line);
        for (let y = line; y < line+height; y++) {
          grid[y] ||= [];
          for (let x = column; x < column+width; x++) grid[y][x] = cell;
        }
        column += width;
        if (column >= 128) break;
      }
      line++;
    }
    return Array.from({length: Math.max(0,...grid.map(line => line.length))}, (_, column) => [...new Set(grid.map(line => line[column]).filter(Boolean))]);
  }
  function scoreLink(anchor) {
    const raw = words(anchor.getAttribute('href')); if (!raw) return null;
    let url;
    try { url = new URL(raw,'https://powerschool.invalid/guardian/home.html'); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.pathname !== '/guardian/scores.html') return null;
    const terms = [];
    for (const [key,value] of url.searchParams) if (termFields.has(key.toLowerCase()) && termKey(value)) terms.push(termKey(value));
    // The native service resolves paths against the account origin and enforces same-origin HTTPS.
    return { anchor, terms, path: url.origin === 'https://powerschool.invalid' ? url.pathname+url.search : url.href };
  }
  function progress(html, attendanceHTML) {
    const doc = documentFrom(html), courses = [];
    const headers = new WeakMap(), selections = [];
    doc.querySelectorAll('select[name],input[name]').forEach(field => {
      if (!termFields.has(field.name.toLowerCase()) || !termKey(field.value) || (['radio','checkbox'].includes(field.type) && !field.checked)) return;
      const label = field.selectedOptions?.[0]?.label || '', alias = termLabel(label);
      selections.push({ terms: [termKey(field.value),...(alias ? [alias] : [])], year: /^(?:(?:school\s+)?year\s*)?\d{4}\s*[-–/]\s*\d{4}(?:\s*(?:school\s+)?year)?$/iu.test(words(label)) });
    });
    doc.querySelectorAll('tr[id^="ccid_"]').forEach(row => {
      const cells = tableCells(row), table = row.closest('table'); if (!table || !cells.length) return;
      if (!headers.has(table)) headers.set(table,columnHeaders(table));
      const header = headers.get(table); let column = 0;
      const columns = cells.map(cell => {
        const width = Math.min(Math.max(cell.colSpan,1),128), labels = [...new Set(header.slice(column,column+width).flat())]; column += width;
        const links = [...cell.querySelectorAll('a[href]')].map(scoreLink).filter(Boolean);
        return { cell, labels, title: labels.map(text).join(' '), terms: new Set([...labels.flatMap(nodeTerms),...nodeTerms(cell),...links.flatMap(link => link.terms)]), links };
      });
      const courseColumn = columns.find(item => /^(?:course(?: name)?|subject|class(?: name)?|课程(?:名称)?|科目)$/iu.test(text(item.labels.at(-1)))) || columns.find(item => item.cell.querySelector('a[href^="mailto:"],a[title^="Details about "]')) || columns.find(item => [...item.cell.querySelectorAll('.display-flex,.room,[data-room]')].some(node => /^[-–—\s]*(?:Rm|Room)\s*:/iu.test(text(node)))) || columns.find(item => /\b(?:course|subject)\b|课程|科目/iu.test(item.title) && !/\bgrades?\b/iu.test(item.title));
      if (!courseColumn) return;
      const course = courseColumn.cell, mail = course.querySelector('a[href^="mailto:"]'), teacherLink = course.querySelector('a[title^="Details about "]');
      const roomNode = [...course.querySelectorAll('.display-flex,.room,[data-room]')].find(node => /^[-–—\s]*(?:Rm|Room)\s*:/iu.test(text(node)));
      const roomLine = text(roomNode) || lines(course).find(line => /^[-–—\s]*(?:Rm|Room)\s*:/iu.test(line)) || '';
      const room = roomLine.replace(/^[-–—\s]*(?:Rm|Room)\s*:\s*/iu,'');
      const teacher = text(mail), teacherTitle = words(teacherLink?.getAttribute('title')?.replace(/^Details about /u,'') || '');
      const nameNode = course.cloneNode(true);
      nameNode.querySelectorAll('a[href^="mailto:"],a[title^="Details about "]').forEach(node => node.remove());
      nameNode.querySelectorAll('.display-flex,.room,[data-room]').forEach(node => { if (/^[-–—\s]*(?:Rm|Room)\s*:/iu.test(text(node))) node.remove(); });
      const named = nameNode.querySelector('.course-name,.courseName,[data-course-name]');
      let name = text(named) || lines(nameNode).find(line => !/^[-–—\s]*(?:Rm|Room)\s*:/iu.test(line)) || '';
      if (teacher && name.endsWith(teacher)) name = words(name.slice(0,-teacher.length));
      if (!name) return;
      const gradeColumns = columns.filter(item => item !== courseColumn && (item.links.length || /\b(?:grades?|marks?)\b|成绩|分数/iu.test(text(item.labels.at(-1))) || item.terms.size));
      // A school-year selector may share the termid name without selecting a grade column.
      const selectedTerms = new Set(selections.filter(selection => !selection.year || gradeColumns.some(item => selection.terms.some(term => item.terms.has(term)))).flatMap(selection => selection.terms));
      let chosen;
      if (selectedTerms.size) chosen = gradeColumns.find(item => [...item.terms].some(term => selectedTerms.has(term)));
      else chosen = gradeColumns.find(item => currentColumn(item.cell) || item.labels.some(currentColumn)) || gradeColumns.find(item => item.links.length) || gradeColumns[0];
      const selectedLink = chosen?.links.find(link => !selectedTerms.size || link.terms.some(term => selectedTerms.has(term))) || chosen?.links[0];
      const grade = text(selectedLink?.anchor || chosen?.cell).replace(/^\[\s*i\s*\]$/iu,'');
      const gradeEnd = Math.max(-1,...gradeColumns.map(item => columns.indexOf(item)));
      const trailing = columns.slice(gradeEnd+1);
      const absenceColumn = columns.find(item => /\b(?:absences?|absent)\b|缺席|旷课/iu.test(item.title)) || trailing[0];
      const tardyColumn = columns.find(item => /\b(?:tardies|tardy|lates?)\b|迟到/iu.test(item.title)) || trailing[1];
      const expression = columns.find(item => /\b(?:exp|expression|period)\b/iu.test(item.title)) || (columns[0] !== courseColumn ? columns[0] : null);
      const id = row.id.substring(5);
      courses.push({ id, name, teacher: teacherTitle || teacher, room, meetingPattern: text(expression?.cell), grade, absences: count(text(absenceColumn?.cell)), tardies: count(text(tardyColumn?.cell)), detailsPath: selectedLink?.path || '' });
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
