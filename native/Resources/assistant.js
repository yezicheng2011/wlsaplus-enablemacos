// SPDX-License-Identifier: Apache-2.0
// Study assistant logic. Facts always come from the synced school data: this
// module finds the records a question is about and writes the answer itself.
// The on-device model only helps understand unusual wording and rephrases the
// answer, and its text is used only when it repeats every fact unchanged.
(function (root) {
  'use strict';
  // Resolved on use so the load order of app.js and this file does not matter.
  const tools = new Proxy({}, {get: (_, key) => (root.WLSA || {})[key]});

  // Subject words in both languages, used to match "物理" to "AP Physics C".
  const SUBJECTS = [
    [['math', 'mathematics', 'maths', 'calculus', 'algebra', 'geometry', 'statistics', 'precalculus', 'trigonometry'], ['数学', '微积分', '代数', '几何', '统计', '高数']],
    [['physics'], ['物理']], [['chemistry'], ['化学']], [['biology'], ['生物']],
    [['english', 'literature', 'writing', 'language arts', 'composition'], ['英语', '英文', '文学', '写作']],
    [['chinese', 'mandarin'], ['语文', '中文', '汉语']],
    [['history'], ['历史']], [['geography'], ['地理']], [['economics', 'microeconomics', 'macroeconomics'], ['经济', '经济学']],
    [['computer', 'programming', 'coding', 'informatics'], ['计算机', '编程', '信息技术', '电脑']],
    [['music', 'band', 'choir', 'orchestra'], ['音乐', '乐队', '合唱']], [['art', 'drawing', 'painting', 'design'], ['美术', '艺术', '绘画', '设计']],
    [['physical education', 'pe', 'sports', 'gym', 'fitness'], ['体育', '运动']],
    [['psychology'], ['心理', '心理学']], [['politics', 'government', 'civics'], ['政治', '公民']],
    [['science'], ['科学']], [['philosophy', 'theory of knowledge', 'tok'], ['哲学', '知识论']],
    [['spanish'], ['西班牙语']], [['french'], ['法语']], [['japanese'], ['日语']], [['german'], ['德语']],
    [['drama', 'theatre', 'theater'], ['戏剧']], [['business', 'accounting', 'finance'], ['商科', '商业', '会计', '金融']],
    [['homeroom', 'advisory', 'assembly'], ['班会', '年级会']], [['study hall', 'self study'], ['自习']],
    [['environmental'], ['环境', '环境科学']], [['seminar', 'research'], ['研讨', '研究']], [['sociology', 'humanities', 'social studies'], ['社会', '人文']],
  ];
  const GENERIC = new Set(['ap', 'ib', 'honors', 'honours', 'advanced', 'intro', 'introduction', 'level', 'class', 'course', 'grade', 'year', 'and', 'the', 'of', 'for', 'to', 'in', 'with', 'hl', 'sl', 'i', 'ii', 'iii', 'a', 'b', 'c', 's1', 's2']);
  const INTENTS = {
    grade: /\b(grades?|scores?|marks?|percent(age)?|gpa|doing)\b|成绩|分数|多少分|几分|得分|考得|考了/i,
    room: /\b(rooms?|where|classroom|location|building)\b|教室|哪里|哪儿|在哪|哪间|哪个房间|地点|位置/i,
    teacher: /\b(teachers?|who|teach(es)?|taught|instructor|professor)\b|老师|教师|谁教|哪位|谁上|谁带/i,
    time: /\b(when|what time|starts?|begins?|ends?|finish(es)?|period)\b|几点|什么时候|何时|开始|结束|时间|下课|上课时间/i,
    schedule: /\b(schedule|timetable|classes|lessons|what do i have|what('s| is) (on|next))\b|课表|课程表|有什么课|哪些课|几节课|上什么课|有课吗|什么课/i,
  };
  const NEXT = /\b(next|upcoming|now|current(ly)?)\b|下一节|下节|下一堂|接下来|现在|当前|马上/i;
  const FIRST = /\b(first)\b|第一节|第一堂|最早/i;
  const LAST = /\b(last|final)\b|最后一节|最后一堂|最晚/i;
  const LOWEST = /\b(lowest|worst|weakest)\b|最低|最差|最弱/i;
  const HIGHEST = /\b(highest|best|strongest|top)\b|最高|最好|最强/i;
  const ALL = /\b(all|every|each|overall)\b|所有|全部|每门|各科|各门|每科/i;
  const DAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

  const hasChinese = text => /[\u3400-\u9fff]/.test(String(text || ''));
  const language = (question, fallback = 'en') => hasChinese(question) ? 'zh' : /[a-z]/i.test(String(question || '')) ? 'en' : fallback;
  const clean = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = text => clean(text).split(' ').filter(Boolean);
  const containsWord = (haystack, needle) => (` ${haystack} `).includes(` ${needle} `);

  function subjectKeys(text) {
    const lower = clean(text), raw = String(text || '');
    const keys = new Set();
    SUBJECTS.forEach(([english, chinese], index) => {
      if (english.some(word => containsWord(lower, word)) || chinese.some(word => raw.includes(word))) keys.add(index);
    });
    return keys;
  }

  // Scores how strongly a question refers to a course: full name, then
  // distinctive words of the name, then a shared subject in either language.
  function courseScore(question, course) {
    const name = String(course.name || course.title || '');
    if (!name) return 0;
    const q = clean(question), n = clean(name);
    if (n && (containsWord(q, n) || (hasChinese(name) && String(question).includes(name)))) return 100;
    let score = 0;
    const distinctive = words(name).filter(word => !GENERIC.has(word) && (word.length >= 3 || hasChinese(word)));
    const matched = distinctive.filter(word => containsWord(q, word) || (hasChinese(word) && String(question).includes(word)));
    if (matched.length) score = 40 + 10 * matched.length + (matched.length === distinctive.length ? 20 : 0);
    const shared = [...subjectKeys(name)].filter(key => subjectKeys(question).has(key));
    if (shared.length) score = Math.max(score, 50 + 5 * shared.length);
    return score;
  }

  function findCourses(question, courses) {
    const scored = courses.map(course => ({course, score: courseScore(question, course)})).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return [];
    return scored.filter(item => item.score >= scored[0].score - 5).slice(0, 4).map(item => item.course);
  }

  function resolveDate(question, now) {
    const q = String(question).toLowerCase(), base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const shift = days => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
    if (/day after tomorrow|后天/.test(q)) return {date: shift(2), explicit: true};
    if (/\btomorrow\b|明天|明日/.test(q)) return {date: shift(1), explicit: true};
    if (/\byesterday\b|昨天/.test(q)) return {date: shift(-1), explicit: true};
    if (/\b(today|tonight|this (morning|afternoon))\b|今天|今日|今早|今晚|上午|下午/.test(q)) return {date: base, explicit: true};
    for (let day = 0; day < 7; day++) {
      const english = new RegExp(`\\b(${DAYS_EN[day]}|${DAYS_EN[day].slice(0, 3)})\\b`).test(q);
      const chinese = new RegExp(`(星期|周|礼拜)${day === 0 ? '[日天]' : DAYS_ZH[day]}`).test(q);
      if (english || chinese) {
        let ahead = (day - base.getDay() + 7) % 7;
        if (/\bnext\b|下周|下星期|下礼拜/.test(q) && ahead === 0) ahead = 7;
        return {date: shift(ahead), explicit: true};
      }
    }
    return {date: base, explicit: false};
  }

  const timeOf = value => tools.format24 ? tools.format24(value) : String(value || '');
  const titleOf = entry => String(entry.title || entry.name || '');
  function dayLabel(date, now, lang) {
    const difference = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const relative = {zh: {0: '今天', 1: '明天', 2: '后天', '-1': '昨天'}, en: {0: 'today', 1: 'tomorrow', 2: 'the day after tomorrow', '-1': 'yesterday'}}[lang][difference];
    if (relative) return relative;
    return lang === 'zh' ? `${date.getMonth() + 1}月${date.getDate()}日（周${DAYS_ZH[date.getDay()]}）` : `${DAYS_EN[date.getDay()][0].toUpperCase()}${DAYS_EN[date.getDay()].slice(1)}, ${date.getMonth() + 1}/${date.getDate()}`;
  }
  const sameCourse = (entry, course) => {
    const a = clean(titleOf(entry)), b = clean(course.name || course.title);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a) || (entry.courseId && entry.courseId === course.id)));
  };
  const gradeText = course => {
    const grade = String(course.grade ?? '').trim(), percent = tools.percentage ? tools.percentage(course.percent) : null;
    if (grade && percent != null) return `${grade} (${percent}%)`;
    return grade || (percent != null ? `${percent}%` : '');
  };

  const TEXT = {
    en: {
      noData: 'I can’t answer yet because no school data has been synced. Connect PowerSchool and sync, then ask again.',
      noCourse: 'I couldn’t find that course in your synced data.',
      yourCourses: names => `Your courses are: ${names}.`,
      unsure: 'I’m not sure what you’d like to know. You can ask about a class time, a grade, a room or a teacher.',
      grade: (name, value) => `Your grade in ${name} is ${value}.`, noGrade: name => `${name} has no grade posted yet.`,
      room: (name, value) => `${name} is in room ${value}.`, noRoom: name => `No room is listed for ${name}.`,
      teacher: (name, value) => `${name} is taught by ${value}.`, noTeacher: name => `No teacher is listed for ${name}.`,
      time: (name, day, start, end) => `${name} is ${day} from ${start} to ${end}.`, noTime: (name, day) => `${name} is not on your schedule ${day}.`,
      none: day => `You have no classes ${day}.`, list: (day, count) => `You have ${count} ${count === 1 ? 'class' : 'classes'} ${day}:`,
      slot: (start, end, name, room) => `${start}–${end} ${name}${room ? `, room ${room}` : ''}`,
      next: (name, day, start, room) => `Your next class is ${name}, ${day} at ${start}${room ? ` in room ${room}` : ''}.`,
      current: (name, end, room) => `You are in ${name} now${room ? `, room ${room}` : ''}, until ${end}.`,
      first: (name, day, start, room) => `Your first class ${day} is ${name} at ${start}${room ? ` in room ${room}` : ''}.`,
      last: (name, day, start, room) => `Your last class ${day} is ${name} at ${start}${room ? ` in room ${room}` : ''}.`,
      noNext: 'No upcoming class was found in your synced schedule.',
      lowest: (name, value) => `Your lowest grade is in ${name}: ${value}.`, highest: (name, value) => `Your highest grade is in ${name}: ${value}.`,
      allGrades: 'Your grades:', noGrades: 'No grades have been posted yet.',
      labels: {course: 'Course', grade: 'Grade', room: 'Room', teacher: 'Teacher', time: 'Time', day: 'Day'},
    },
    zh: {
      noData: '还没有同步学校数据，暂时无法回答。请先连接 PowerSchool 并同步，然后再问一次。',
      noCourse: '在已同步的数据里没有找到这门课。',
      yourCourses: names => `你的课程有：${names}。`,
      unsure: '我没太明白你想问什么。可以问上课时间、成绩、教室或任课老师。',
      grade: (name, value) => `你的 ${name} 成绩是 ${value}。`, noGrade: name => `${name} 还没有公布成绩。`,
      room: (name, value) => `${name} 在 ${value} 教室上课。`, noRoom: name => `${name} 没有登记教室。`,
      teacher: (name, value) => `${name} 的任课老师是 ${value}。`, noTeacher: name => `${name} 没有登记任课老师。`,
      time: (name, day, start, end) => `${name} ${day}的上课时间是 ${start} 到 ${end}。`, noTime: (name, day) => `${day}的课表里没有 ${name}。`,
      none: day => `${day}没有课。`, list: (day, count) => `${day}有 ${count} 节课：`,
      slot: (start, end, name, room) => `${start}–${end} ${name}${room ? `，${room} 教室` : ''}`,
      next: (name, day, start, room) => `下一节课是 ${name}，${day} ${start} 开始${room ? `，在 ${room} 教室` : ''}。`,
      current: (name, end, room) => `现在正在上 ${name}${room ? `，在 ${room} 教室` : ''}，${end} 下课。`,
      first: (name, day, start, room) => `${day}第一节课是 ${name}，${start} 开始${room ? `，在 ${room} 教室` : ''}。`,
      last: (name, day, start, room) => `${day}最后一节课是 ${name}，${start} 开始${room ? `，在 ${room} 教室` : ''}。`,
      noNext: '在已同步的课表里没有找到接下来的课。',
      lowest: (name, value) => `成绩最低的是 ${name}：${value}。`, highest: (name, value) => `成绩最高的是 ${name}：${value}。`,
      allGrades: '你的成绩：', noGrades: '还没有公布任何成绩。',
      labels: {course: '课程', grade: '成绩', room: '教室', teacher: '老师', time: '时间', day: '日期'},
    },
  };

  // Answers a question from the data alone.
  function answer(question, snapshot, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const lang = options.language || language(question, options.fallbackLanguage || 'en');
    const t = TEXT[lang];
    const courses = Array.isArray(snapshot?.courses) ? snapshot.courses : [], schedule = Array.isArray(snapshot?.schedule) ? snapshot.schedule : [];
    const result = {language: lang, status: 'answered', text: '', facts: [], must: [], intents: [], courses: []};
    const fact = (label, value) => { if (value) { result.facts.push({label: t.labels[label], value: String(value)}); } };
    const must = (...values) => values.forEach(value => { if (value && !result.must.includes(String(value))) result.must.push(String(value)); });
    if (!courses.length && !schedule.length) return {...result, status: 'no-data', text: t.noData};

    const intents = Object.keys(INTENTS).filter(key => INTENTS[key].test(question));
    let matched = findCourses(question, courses);
    const scheduleOnly = !matched.length ? findCourses(question, schedule.map(entry => ({name: titleOf(entry), room: entry.room, teacher: entry.teacher, id: entry.courseId}))).filter((course, index, list) => list.findIndex(other => clean(other.name) === clean(course.name)) === index) : [];
    if (!matched.length) matched = scheduleOnly;
    const when = resolveDate(question, now), day = dayLabel(when.date, now, lang);
    const onDay = date => (tools.scheduleForDate ? tools.scheduleForDate(schedule, date) : []).filter(entry => titleOf(entry));
    const lines = [];
    result.intents = intents; result.courses = matched.map(course => String(course.name || course.title || ''));

    if (intents.includes('grade') && (LOWEST.test(question) || HIGHEST.test(question)) && !matched.length) {
      const graded = courses.map(course => ({course, percent: tools.percentage ? tools.percentage(course.percent) : null})).filter(item => item.percent != null);
      if (!graded.length) return {...result, text: t.noGrades};
      const lowest = LOWEST.test(question);
      const pick = graded.reduce((best, item) => (lowest ? item.percent < best.percent : item.percent > best.percent) ? item : best);
      fact('course', pick.course.name); fact('grade', gradeText(pick.course)); must(gradeText(pick.course));
      return {...result, courses: [String(pick.course.name)], text: (lowest ? t.lowest : t.highest)(pick.course.name, gradeText(pick.course))};
    }
    if (intents.includes('grade') && !matched.length && (ALL.test(question) || !intents.some(key => key !== 'grade'))) {
      const graded = courses.filter(course => gradeText(course));
      if (!graded.length) return {...result, text: t.noGrades};
      graded.forEach(course => { result.facts.push({label: String(course.name), value: gradeText(course)}); });
      return {...result, courses: graded.map(course => String(course.name)), text: `${t.allGrades}\n${graded.map(course => `${course.name}: ${gradeText(course)}`).join('\n')}`};
    }

    if (!matched.length) {
      const wantsNext = NEXT.test(question) && !when.explicit, entries = onDay(when.date);
      if (wantsNext && (intents.length || /class|lesson|课|\b(am i|do i have)\b|我在/i.test(question))) {
        const state = tools.currentAndNext ? tools.currentAndNext(schedule, now) : {};
        if (state.current && /\b(now|current(ly)?)\b|现在|当前/.test(question)) {
          const entry = state.current;
          fact('course', titleOf(entry)); fact('time', `${timeOf(entry.start)}–${timeOf(entry.end)}`); fact('room', entry.room); fact('teacher', entry.teacher);
          must(timeOf(entry.end));
          return {...result, courses: [titleOf(entry)], text: t.current(titleOf(entry), timeOf(entry.end), entry.room)};
        }
        const entry = state.next;
        if (!entry) return {...result, text: t.noNext};
        const start = tools.parseDate ? tools.parseDate(entry.start) : null, label = start ? dayLabel(start, now, lang) : day;
        fact('course', titleOf(entry)); fact('day', label); fact('time', `${timeOf(entry.start)}–${timeOf(entry.end)}`); fact('room', entry.room); fact('teacher', entry.teacher);
        must(timeOf(entry.start));
        return {...result, courses: [titleOf(entry)], text: t.next(titleOf(entry), label, timeOf(entry.start), entry.room)};
      }
      if ((FIRST.test(question) || LAST.test(question)) && entries.length) {
        const first = FIRST.test(question), entry = first ? entries[0] : entries[entries.length - 1];
        fact('course', titleOf(entry)); fact('day', day); fact('time', `${timeOf(entry.start)}–${timeOf(entry.end)}`); fact('room', entry.room); fact('teacher', entry.teacher);
        must(timeOf(entry.start));
        return {...result, courses: [titleOf(entry)], text: (first ? t.first : t.last)(titleOf(entry), day, timeOf(entry.start), entry.room)};
      }
      if (intents.includes('schedule') || (when.explicit && (intents.includes('time') || /class|lesson|课/.test(question)))) {
        if (!entries.length) return {...result, text: t.none(day)};
        entries.forEach(entry => { result.facts.push({label: `${timeOf(entry.start)}–${timeOf(entry.end)}`, value: [titleOf(entry), entry.room].filter(Boolean).join(' · ')}); });
        return {...result, courses: entries.map(titleOf), text: `${t.list(day, entries.length)}\n${entries.map(entry => t.slot(timeOf(entry.start), timeOf(entry.end), titleOf(entry), entry.room)).join('\n')}`};
      }
      if (intents.some(key => ['grade', 'room', 'teacher', 'time'].includes(key))) {
        const names = courses.map(course => course.name).filter(Boolean).join(lang === 'zh' ? '、' : ', ');
        return {...result, status: 'no-course', text: names ? `${t.noCourse} ${t.yourCourses(names)}` : t.noCourse};
      }
      return {...result, status: 'unknown', text: t.unsure};
    }

    const wanted = intents.filter(key => key !== 'schedule');
    const fields = wanted.length ? wanted : ['grade', 'room', 'teacher', 'time'];
    matched.forEach(course => {
      const name = String(course.name || course.title || '');
      const upcoming = [];
      for (let offset = 0; offset < (when.explicit ? 1 : 7) && !upcoming.length; offset++) {
        const date = new Date(when.date.getFullYear(), when.date.getMonth(), when.date.getDate() + offset);
        onDay(date).filter(entry => sameCourse(entry, course)).forEach(entry => upcoming.push({entry, date}));
      }
      const session = upcoming[0];
      const room = course.room || session?.entry.room, teacher = course.teacher || session?.entry.teacher;
      if (matched.length > 1 || fields.length > 1) fact('course', name);
      for (const field of fields) {
        if (field === 'grade') {
          if (!courses.includes(course)) continue;
          const value = gradeText(course);
          lines.push(value ? t.grade(name, value) : t.noGrade(name)); fact('grade', value); must(value);
        } else if (field === 'room') {
          lines.push(room ? t.room(name, room) : t.noRoom(name)); fact('room', room); must(room);
        } else if (field === 'teacher') {
          lines.push(teacher ? t.teacher(name, teacher) : t.noTeacher(name)); fact('teacher', teacher); must(teacher);
        } else if (field === 'time') {
          if (!session) { if (wanted.includes('time')) lines.push(t.noTime(name, day)); continue; }
          const label = dayLabel(session.date, now, lang), start = timeOf(session.entry.start), end = timeOf(session.entry.end);
          lines.push(t.time(name, label, start, end)); fact('day', label); fact('time', `${start}–${end}`); must(start, end);
        }
      }
    });
    return {...result, text: lines.join(lang === 'zh' ? '' : ' ')};
  }

  // ---- model prompts and checks ----

  function rephrasePrompt(question, result) {
    const system = result.language === 'zh'
      ? '你是 WLSAPlus 学习助手。把下面的“答案”改写成一两句自然、友好的中文。必须原样保留答案里的每个课程名、人名、教室、时间和成绩，不要添加任何答案里没有的信息。只输出改写后的句子。'
      : 'You are the WLSAPlus study assistant. Rewrite the ANSWER below as one or two natural, friendly sentences in English. Keep every course name, person, room, time and grade exactly as written, and add nothing that is not in the answer. Output only the rewritten sentences.';
    const user = result.language === 'zh' ? `问题：${String(question).slice(0, 300)}\n答案：${result.text}` : `QUESTION: ${String(question).slice(0, 300)}\nANSWER: ${result.text}`;
    return {system, user, maxTokens: 90};
  }
  // The model's wording is used only when it names each course (by name or
  // by its subject, e.g. "物理课"), repeats every fact, brings in no other
  // course, teacher or room, and introduces no number missing from the answer.
  function acceptRephrase(reply, result, snapshot) {
    const text = String(reply || '').trim();
    if (!text || text.length > 400 || text.length < 4 || /\n\s*\n/.test(text)) return '';
    const fold = value => String(value).toLowerCase().replace(/\s+/g, '');
    const folded = fold(text), verified = fold(result.text);
    if (!result.must.every(value => folded.includes(fold(value)))) return '';
    const subjects = subjectKeys(text), own = new Set();
    for (const name of result.courses) {
      const keys = subjectKeys(name);
      keys.forEach(key => own.add(key));
      if (!folded.includes(fold(name)) && ![...keys].some(key => subjects.has(key))) return '';
    }
    const mentioned = result.courses.map(fold);
    for (const course of snapshot?.courses || []) {
      for (const value of [course.teacher, course.room]) {
        if (value && folded.includes(fold(value)) && !verified.includes(fold(value))) return '';
      }
      const name = fold(course.name || '');
      if (!name || mentioned.includes(name)) continue;
      if (folded.includes(name) && !mentioned.some(other => other.includes(name))) return '';
      if ([...subjectKeys(course.name)].some(key => subjects.has(key) && !own.has(key))) return '';
    }
    const allowed = new Set(result.text.match(/\d+(?:\.\d+)?/g) || []);
    if ((text.match(/\d+(?:\.\d+)?/g) || []).some(number => !allowed.has(number))) return '';
    if (result.language === 'zh' ? !hasChinese(text) : hasChinese(text) && !hasChinese(result.text)) return '';
    return text;
  }
  function chatPrompt(question, lang) {
    const system = lang === 'zh'
      ? '你是 WLSAPlus 里的学习助手，运行在这台 Mac 上。用简短的中文回答。你看不到学生的课表和成绩，不要编造任何课程、成绩、教室或老师。'
      : 'You are the study assistant inside WLSAPlus, running on this Mac. Answer briefly in English. You cannot see the student’s schedule or grades, so never make up a course, grade, room or teacher.';
    return {system, user: String(question).slice(0, 600), maxTokens: 160};
  }

  const EXAMPLES = {
    en: ['What is my next class?', 'What classes do I have tomorrow?', 'What is my grade in math?', 'Which room is physics in?', 'Who teaches English?', 'Which class has my lowest grade?'],
    zh: ['下一节课是什么？', '明天有什么课？', '我的数学成绩是多少？', '物理课在哪间教室？', '英语是哪位老师教的？', '哪门课成绩最低？'],
  };

  const GENERAL_NOTE = {
    en: 'General answer from the on-device model. It cannot see your school data and may be wrong.',
    zh: '这是本机模型的一般性回答。它看不到你的学校数据，内容可能有误。',
  };

  const api = {answer, language, findCourses, resolveDate, rephrasePrompt, acceptRephrase, chatPrompt, EXAMPLES, GENERAL_NOTE};
  root.WLSAAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
