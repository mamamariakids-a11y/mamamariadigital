const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const upload = require('../utils/upload');
const { notifyMany } = require('../utils/notify');

const NOTE_CATEGORY_LABELS = { health: '💊 صحة/دواء', food: '🍽️ طعام', transport: '🚌 نقل', other: '📝 أخرى' };

const router = express.Router();
router.use(requireRole('teacher'));

async function myClassIds(userId) {
  const result = await db.execute({ sql: 'SELECT id FROM classes WHERE teacher_id = ?', args: [userId] });
  return result.rows.map((r) => r.id);
}

async function myClasses(userId) {
  const result = await db.execute({
    sql: 'SELECT id, name, color FROM classes WHERE teacher_id = ? ORDER BY name',
    args: [userId],
  });
  return result.rows;
}

async function staffToNotify() {
  const result = await db.execute("SELECT id FROM users WHERE role IN ('director','admin') AND active = 1");
  return result.rows.map((r) => r.id);
}

// Counts how many of the child's most recent RECORDED attendance days
// (going backward from `uptoDate`) were consecutively 'absent'. Stops at
// the first 'present' day or when records run out — a gap with no record
// at all (e.g. a day attendance was never taken) also stops the count,
// since we can't assume the child was absent on a day nobody marked.
async function computeAbsentStreak(childId, uptoDate) {
  const result = await db.execute({
    sql: `SELECT status FROM attendance WHERE child_id = ? AND date <= ? ORDER BY date DESC LIMIT 30`,
    args: [childId, uptoDate],
  });
  let streak = 0;
  for (const row of result.rows) {
    if (row.status !== 'absent') break;
    streak += 1;
  }
  return streak;
}

async function parentsOfClass(classId) {
  const result = await db.execute({
    sql: 'SELECT DISTINCT parent_id FROM children WHERE class_id = ? AND parent_id IS NOT NULL',
    args: [classId],
  });
  return result.rows.map((r) => r.parent_id);
}

router.get('/', async (req, res, next) => {
  try {
    const classIds = await myClassIds(req.session.user.id);
    const view = req.query.view === 'month' ? 'month' : 'week';
    const anchor = req.query.date ? dayjs(req.query.date) : dayjs();
    const start = view === 'month' ? anchor.startOf('month').startOf('week') : anchor.startOf('week');
    const end = view === 'month' ? anchor.endOf('month').endOf('week') : anchor.endOf('week');

    let items = [];
    if (classIds.length) {
      const placeholders = classIds.map(() => '?').join(',');
      const result = await db.execute({
        sql: `SELECT items.*, item_assignments.status AS my_status, item_assignments.class_id AS my_class_id,
                     item_assignments.id AS assignment_id, classes.name AS class_name
              FROM item_assignments
              JOIN items ON items.id = item_assignments.item_id
              JOIN classes ON classes.id = item_assignments.class_id
              WHERE item_assignments.class_id IN (${placeholders})
                AND items.scheduled_date BETWEEN ? AND ?
              ORDER BY items.scheduled_date ASC`,
        args: [...classIds, start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')],
      });
      items = result.rows;
    }

    const days = [];
    let cursor = start.clone();
    while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
      days.push({
        date: cursor.format('YYYY-MM-DD'),
        label: cursor.format('dddd'),
        dayNum: cursor.format('D'),
        isToday: cursor.isSame(dayjs(), 'day'),
        inMonth: cursor.isSame(anchor, 'month'),
        items: items.filter((i) => i.scheduled_date === cursor.format('YYYY-MM-DD')),
      });
      cursor = cursor.add(1, 'day');
    }

    const pendingCount = items.filter((i) => i.my_status === 'pending').length;

    res.render('teacher/calendar', {
      title: 'جدولي الأسبوعي',
      view,
      anchor: anchor.format('YYYY-MM-DD'),
      monthLabel: anchor.format('MMMM YYYY'),
      prevDate: (view === 'month' ? anchor.subtract(1, 'month') : anchor.subtract(1, 'week')).format('YYYY-MM-DD'),
      nextDate: (view === 'month' ? anchor.add(1, 'month') : anchor.add(1, 'week')).format('YYYY-MM-DD'),
      days,
      pendingCount,
      hasClass: classIds.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/items/:id', async (req, res, next) => {
  try {
    const classIds = await myClassIds(req.session.user.id);
    const itemResult = await db.execute({ sql: 'SELECT * FROM items WHERE id = ?', args: [req.params.id] });
    const item = itemResult.rows[0];
    if (!item) return res.status(404).render('error', { title: 'غير موجود', message: 'العنصر غير موجود.' });

    const placeholders = classIds.map(() => '?').join(',') || '0';
    const assignResult = await db.execute({
      sql: `SELECT item_assignments.*, classes.name AS class_name
            FROM item_assignments JOIN classes ON classes.id = item_assignments.class_id
            WHERE item_assignments.item_id = ? AND item_assignments.class_id IN (${placeholders})`,
      args: [item.id, ...classIds],
    });

    if (!assignResult.rows.length) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الدرس/النشاط غير مخصص لفصلك.' });
    }

    res.render('teacher/item-detail', {
      title: item.title,
      item: { ...item, attachments: JSON.parse(item.attachments || '[]') },
      assignments: assignResult.rows.map((a) => ({ ...a, execution_photos: JSON.parse(a.execution_photos || '[]') })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/items/:id/receive', async (req, res, next) => {
  try {
    const { assignment_id } = req.body;
    const assignResult = await db.execute({
      sql: 'SELECT * FROM item_assignments WHERE id = ? AND item_id = ?',
      args: [assignment_id, req.params.id],
    });
    const assignment = assignResult.rows[0];
    if (!assignment) return res.status(404).render('error', { title: 'غير موجود', message: 'غير موجود.' });

    await db.execute({
      sql: "UPDATE item_assignments SET status='received', received_at=datetime('now'), received_by=? WHERE id=?",
      args: [req.session.user.id, assignment.id],
    });

    const itemResult = await db.execute({ sql: 'SELECT title FROM items WHERE id = ?', args: [req.params.id] });
    const item = itemResult.rows[0];
    await notifyMany(
      await staffToNotify(),
      'تم استلام درس/نشاط',
      `قامت ${req.session.user.name} بتأكيد استلام: ${item.title}`,
      `/director/items/${req.params.id}`
    );

    res.redirect(`/teacher/items/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/items/:id/execute', upload.array('photos', 8), async (req, res, next) => {
  try {
    const { assignment_id, execution_notes } = req.body;
    const assignResult = await db.execute({
      sql: 'SELECT * FROM item_assignments WHERE id = ? AND item_id = ?',
      args: [assignment_id, req.params.id],
    });
    const assignment = assignResult.rows[0];
    if (!assignment) return res.status(404).render('error', { title: 'غير موجود', message: 'غير موجود.' });

    const photos = (req.files || []).map(upload.fileToRecord);
    const existing = JSON.parse(assignment.execution_photos || '[]');

    await db.execute({
      sql: `UPDATE item_assignments SET status='executed', executed_at=datetime('now'), executed_by=?,
            execution_notes=?, execution_photos=? WHERE id=?`,
      args: [req.session.user.id, execution_notes || '', JSON.stringify([...existing, ...photos]), assignment.id],
    });

    const itemResult = await db.execute({ sql: 'SELECT title FROM items WHERE id = ?', args: [req.params.id] });
    const item = itemResult.rows[0];

    await notifyMany(
      await staffToNotify(),
      'تم تنفيذ درس/نشاط',
      `قامت ${req.session.user.name} بتأكيد تنفيذ: ${item.title}`,
      `/director/items/${req.params.id}`
    );
    await notifyMany(
      await parentsOfClass(assignment.class_id),
      'نشاط جديد لطفلك 🎨',
      `تم تنفيذ: ${item.title}`,
      `/parent`
    );

    res.redirect(`/teacher/items/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Attendance ----------
router.get('/attendance', async (req, res, next) => {
  try {
    const classes = await myClasses(req.session.user.id);
    if (!classes.length) {
      return res.render('teacher/attendance', {
        title: 'الحضور والغياب',
        classes: [],
        activeClass: null,
        date: dayjs().format('YYYY-MM-DD'),
        children: [],
      });
    }

    const requestedClassId = Number(req.query.class_id) || classes[0].id;
    const activeClass = classes.find((c) => c.id === requestedClassId) || classes[0];
    const date = req.query.date && dayjs(req.query.date).isValid() ? req.query.date : dayjs().format('YYYY-MM-DD');

    const childrenResult = await db.execute({
      sql: 'SELECT id, name FROM children WHERE class_id = ? ORDER BY name',
      args: [activeClass.id],
    });

    const attResult = await db.execute({
      sql: 'SELECT child_id, status FROM attendance WHERE class_id = ? AND date = ?',
      args: [activeClass.id, date],
    });
    const statusMap = {};
    attResult.rows.forEach((r) => { statusMap[r.child_id] = r.status; });

    const children = childrenResult.rows.map((c) => ({ ...c, status: statusMap[c.id] || null }));
    const markedCount = children.filter((c) => c.status).length;

    res.render('teacher/attendance', {
      title: 'الحضور والغياب',
      classes,
      activeClass,
      date,
      children,
      markedCount,
      isToday: date === dayjs().format('YYYY-MM-DD'),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/attendance', async (req, res, next) => {
  try {
    const classes = await myClasses(req.session.user.id);
    const classId = Number(req.body.class_id);
    if (!classes.some((c) => c.id === classId)) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الفصل ليس فصلك.' });
    }
    const date = req.body.date && dayjs(req.body.date).isValid() ? req.body.date : dayjs().format('YYYY-MM-DD');
    const cls = classes.find((c) => c.id === classId);

    const childrenResult = await db.execute({ sql: 'SELECT id, name, parent_id FROM children WHERE class_id = ?', args: [classId] });

    const newlyAbsent = [];
    for (const child of childrenResult.rows) {
      const status = req.body[`status_${child.id}`];
      if (status !== 'present' && status !== 'absent') continue;

      // eslint-disable-next-line no-await-in-loop
      const existing = await db.execute({ sql: 'SELECT status FROM attendance WHERE child_id = ? AND date = ?', args: [child.id, date] });
      const previousStatus = existing.rows[0] ? existing.rows[0].status : null;

      // eslint-disable-next-line no-await-in-loop
      await db.execute({
        sql: `INSERT INTO attendance (child_id, class_id, date, status, marked_by)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(child_id, date) DO UPDATE SET
                status = excluded.status, marked_by = excluded.marked_by, updated_at = datetime('now')`,
        args: [child.id, classId, date, status, req.session.user.id],
      });

      // Only a genuine present/unmarked -> absent transition counts — resaving
      // an already-absent day (e.g. re-submitting the same form) won't re-fire.
      if (status === 'absent' && previousStatus !== 'absent') newlyAbsent.push(child);
    }

    // Follow-up alert for extended absences: once a child has been absent on
    // 2+ consecutive recorded school days, notify admin/director to check in,
    // and send the parent a gentle reminder — without exposing full attendance
    // history to parents (they only get this targeted notification).
    for (const child of newlyAbsent) {
      // eslint-disable-next-line no-await-in-loop
      const streak = await computeAbsentStreak(child.id, date);
      if (streak < 2) continue;

      // eslint-disable-next-line no-await-in-loop
      await notifyMany(
        await staffToNotify(),
        `تنبيه غياب متكرر: ${child.name}`,
        `${child.name} (${cls ? cls.name : ''}) غائب لليوم ${streak} على التوالي. يُرجى المتابعة مع الأسرة.`,
        '/admin/attendance?view=month'
      );

      if (child.parent_id) {
        // eslint-disable-next-line no-await-in-loop
        await notifyMany(
          [child.parent_id],
          `نطمئن على ${child.name} 🌸`,
          `لاحظنا غياب ${child.name} عن الروضة لليوم ${streak} على التوالي. نتمنى أن يكون بخير، ونتطلع لعودته قريبًا. لأي استفسار يسعدنا تواصلكم معنا.`,
          '/parent'
        );
      }
    }

    res.redirect(`/teacher/attendance?class_id=${classId}&date=${date}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Daily report (meals / nap / mood / bathroom) ----------
router.get('/daily-report', async (req, res, next) => {
  try {
    const classes = await myClasses(req.session.user.id);
    if (!classes.length) {
      return res.render('teacher/daily-report', {
        title: 'التقرير اليومي',
        classes: [],
        activeClass: null,
        date: dayjs().format('YYYY-MM-DD'),
        children: [],
      });
    }

    const requestedClassId = Number(req.query.class_id) || classes[0].id;
    const activeClass = classes.find((c) => c.id === requestedClassId) || classes[0];
    const date = req.query.date && dayjs(req.query.date).isValid() ? req.query.date : dayjs().format('YYYY-MM-DD');

    const childrenResult = await db.execute({
      sql: 'SELECT id, name FROM children WHERE class_id = ? ORDER BY name',
      args: [activeClass.id],
    });

    const reportsResult = await db.execute({
      sql: 'SELECT * FROM daily_reports WHERE class_id = ? AND date = ?',
      args: [activeClass.id, date],
    });
    const reportMap = {};
    reportsResult.rows.forEach((r) => { reportMap[r.child_id] = r; });

    const children = childrenResult.rows.map((c) => ({ ...c, report: reportMap[c.id] || null }));
    const filledCount = children.filter((c) => c.report).length;

    res.render('teacher/daily-report', {
      title: 'التقرير اليومي',
      classes,
      activeClass,
      date,
      children,
      filledCount,
      isToday: date === dayjs().format('YYYY-MM-DD'),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/daily-report', async (req, res, next) => {
  try {
    const classes = await myClasses(req.session.user.id);
    const classId = Number(req.body.class_id);
    if (!classes.some((c) => c.id === classId)) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الفصل ليس فصلك.' });
    }
    const date = req.body.date && dayjs(req.body.date).isValid() ? req.body.date : dayjs().format('YYYY-MM-DD');

    const childrenResult = await db.execute({ sql: 'SELECT id FROM children WHERE class_id = ?', args: [classId] });

    for (const child of childrenResult.rows) {
      const mealStatus = ['all', 'some', 'none'].includes(req.body[`meal_${child.id}`]) ? req.body[`meal_${child.id}`] : null;
      const napStatus = ['yes', 'no'].includes(req.body[`nap_${child.id}`]) ? req.body[`nap_${child.id}`] : null;
      const napMinutesRaw = req.body[`nap_minutes_${child.id}`];
      const napMinutes = napMinutesRaw && Number(napMinutesRaw) >= 0 ? Number(napMinutesRaw) : null;
      const mood = ['happy', 'normal', 'tired', 'upset'].includes(req.body[`mood_${child.id}`]) ? req.body[`mood_${child.id}`] : null;
      const bathroomRaw = req.body[`bathroom_${child.id}`];
      const bathroomCount = bathroomRaw && Number(bathroomRaw) >= 0 ? Number(bathroomRaw) : null;
      const notes = (req.body[`notes_${child.id}`] || '').trim() || null;

      // Skip children the teacher left entirely blank — avoids creating an
      // empty row just because the form was submitted with all fields empty.
      if (!mealStatus && !napStatus && napMinutes === null && !mood && bathroomCount === null && !notes) continue;

      // eslint-disable-next-line no-await-in-loop
      await db.execute({
        sql: `INSERT INTO daily_reports (child_id, class_id, date, meal_status, nap_status, nap_minutes, mood, bathroom_count, notes, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(child_id, date) DO UPDATE SET
                meal_status = excluded.meal_status, nap_status = excluded.nap_status, nap_minutes = excluded.nap_minutes,
                mood = excluded.mood, bathroom_count = excluded.bathroom_count, notes = excluded.notes,
                created_by = excluded.created_by, updated_at = datetime('now')`,
        args: [child.id, classId, date, mealStatus, napStatus, napMinutes, mood, bathroomCount, notes, req.session.user.id],
      });
    }

    res.redirect(`/teacher/daily-report?class_id=${classId}&date=${date}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Health record (read-only for teachers) ----------
router.get('/children/:id/health', async (req, res, next) => {
  try {
    const classIds = await myClassIds(req.session.user.id);
    const childResult = await db.execute({
      sql: `SELECT children.*, classes.name AS class_name FROM children
            LEFT JOIN classes ON classes.id = children.class_id WHERE children.id = ?`,
      args: [req.params.id],
    });
    const child = childResult.rows[0];
    if (!child || !classIds.includes(child.class_id)) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس في فصلك.' });
    }

    const healthResult = await db.execute({ sql: 'SELECT * FROM health_profiles WHERE child_id = ?', args: [child.id] });
    const contactsResult = await db.execute({ sql: 'SELECT * FROM emergency_contacts WHERE child_id = ? ORDER BY id', args: [child.id] });

    res.render('teacher/health', {
      title: `السجل الصحي - ${child.name}`,
      child,
      healthProfile: healthResult.rows[0] || null,
      contacts: contactsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Parent notes ----------
router.get('/notes', async (req, res, next) => {
  try {
    const classIds = await myClassIds(req.session.user.id);
    const today = dayjs().format('YYYY-MM-DD');
    let notes = [];
    if (classIds.length) {
      const placeholders = classIds.map(() => '?').join(',');
      const result = await db.execute({
        sql: `SELECT parent_notes.*, children.name AS child_name, classes.name AS class_name
              FROM parent_notes
              JOIN children ON children.id = parent_notes.child_id
              JOIN classes ON classes.id = parent_notes.class_id
              WHERE parent_notes.archived = 0 AND parent_notes.class_id IN (${placeholders})
                AND (parent_notes.note_type = 'permanent' OR parent_notes.note_date = ?)
              ORDER BY parent_notes.status ASC, parent_notes.created_at DESC`,
        args: [...classIds, today],
      });
      notes = result.rows;
    }
    res.render('teacher/notes', {
      title: 'ملاحظات وتوصيات الأولياء',
      notes,
      categoryLabels: NOTE_CATEGORY_LABELS,
      hasClass: classIds.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/notes/:id/acknowledge', async (req, res, next) => {
  try {
    const classIds = await myClassIds(req.session.user.id);
    const noteResult = await db.execute({ sql: 'SELECT * FROM parent_notes WHERE id = ?', args: [req.params.id] });
    const note = noteResult.rows[0];
    if (!note || !classIds.includes(note.class_id)) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذه الملاحظة ليست لفصلك.' });
    }

    await db.execute({
      sql: "UPDATE parent_notes SET status='done', done_by=?, done_at=datetime('now'), done_note=? WHERE id=?",
      args: [req.session.user.id, req.body.done_note || '', note.id],
    });

    const childResult = await db.execute({ sql: 'SELECT name FROM children WHERE id = ?', args: [note.child_id] });
    const childName = childResult.rows[0] ? childResult.rows[0].name : '';
    const notifyIds = [note.created_by, ...(await staffToNotify())].filter(Boolean);
    await notifyMany(
      notifyIds,
      `تم الاطلاع على ملاحظة ${childName}`,
      `قامت ${req.session.user.name} بتأكيد الاطلاع/التنفيذ${req.body.done_note ? ': ' + req.body.done_note : ''}`,
      '/director/notes'
    );

    res.redirect('/teacher/notes');
  } catch (err) {
    next(err);
  }
});

// ---------- Pedagogical development assessments ----------
const DOMAIN_LABELS = { motor: 'الحركي', cognitive: 'المعرفي', language: 'اللغوي', social: 'الاجتماعي', autonomy: 'الاستقلالية' };
const LEVEL_LABELS = { emerging: 'ناشئ', developing: 'في تطور', proficient: 'متمكّن' };

router.get('/children/:id/development', async (req, res, next) => {
  try {
    const classIds = await myClassIds(req.session.user.id);
    const childResult = await db.execute({
      sql: `SELECT children.*, classes.name AS class_name FROM children
            LEFT JOIN classes ON classes.id = children.class_id WHERE children.id = ?`,
      args: [req.params.id],
    });
    const child = childResult.rows[0];
    if (!child || !classIds.includes(child.class_id)) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس في فصلك.' });
    }
    const assessmentsResult = await db.execute({
      sql: `SELECT development_assessments.*, users.name AS assessed_by_name FROM development_assessments
            LEFT JOIN users ON users.id = development_assessments.assessed_by
            WHERE child_id = ? ORDER BY created_at DESC`,
      args: [child.id],
    });
    res.render('teacher/development', {
      title: `التطور البيداغوجي - ${child.name}`,
      child,
      assessments: assessmentsResult.rows,
      domainLabels: DOMAIN_LABELS,
      levelLabels: LEVEL_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/development', async (req, res, next) => {
  try {
    const classIds = await myClassIds(req.session.user.id);
    const childResult = await db.execute({ sql: 'SELECT * FROM children WHERE id = ?', args: [req.params.id] });
    const child = childResult.rows[0];
    if (!child || !classIds.includes(child.class_id)) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس في فصلك.' });
    }
    const { domain, level, note } = req.body;
    if (!Object.prototype.hasOwnProperty.call(DOMAIN_LABELS, domain) || !Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level)) {
      return res.redirect(`/teacher/children/${child.id}/development`);
    }
    await db.execute({
      sql: 'INSERT INTO development_assessments (child_id, domain, level, note, assessed_by) VALUES (?, ?, ?, ?, ?)',
      args: [child.id, domain, level, (note || '').trim() || null, req.session.user.id],
    });
    res.redirect(`/teacher/children/${child.id}/development`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
