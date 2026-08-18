const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { notify, notifyMany } = require('../utils/notify');

const router = express.Router();
router.use(requireRole('staff'));

const CATEGORY_LABELS = { health: '💊 صحة/دواء', food: '🍽️ طعام', transport: '🚌 نقل', other: '📝 أخرى' };

async function allChildrenWithClass() {
  const result = await db.execute(
    `SELECT children.id, children.name, classes.id AS class_id, classes.name AS class_name
     FROM children JOIN classes ON classes.id = children.class_id
     ORDER BY classes.name, children.name`
  );
  return result.rows;
}

async function adminsAndDirectors() {
  const result = await db.execute("SELECT id FROM users WHERE role IN ('admin','director') AND active = 1");
  return result.rows.map((r) => r.id);
}

async function activeNotesQuery() {
  const today = dayjs().format('YYYY-MM-DD');
  const result = await db.execute({
    sql: `SELECT parent_notes.*, children.name AS child_name, classes.name AS class_name, classes.color AS class_color,
                 creator.name AS created_by_name, doer.name AS done_by_name
          FROM parent_notes
          JOIN children ON children.id = parent_notes.child_id
          JOIN classes ON classes.id = parent_notes.class_id
          LEFT JOIN users creator ON creator.id = parent_notes.created_by
          LEFT JOIN users doer ON doer.id = parent_notes.done_by
          WHERE parent_notes.archived = 0
            AND (parent_notes.note_type = 'permanent' OR parent_notes.note_date = ?)
          ORDER BY parent_notes.created_at DESC`,
    args: [today],
  });
  return result.rows;
}

router.get('/', async (req, res, next) => {
  try {
    const [children, notes] = await Promise.all([allChildrenWithClass(), activeNotesQuery()]);
    res.render('staff/notes', {
      title: 'ملاحظات وتوصيات الأولياء',
      children,
      notes,
      categoryLabels: CATEGORY_LABELS,
      today: dayjs().format('YYYY-MM-DD'),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/notes', async (req, res, next) => {
  try {
    const { child_id, note_type, category, content, note_date, note_time } = req.body;
    const children = await allChildrenWithClass();
    const child = children.find((c) => c.id === Number(child_id));

    if (!child || !content || !content.trim() || !['daily', 'permanent'].includes(note_type)) {
      return res.status(400).render('staff/notes', {
        title: 'ملاحظات وتوصيات الأولياء',
        children,
        notes: await activeNotesQuery(),
        categoryLabels: CATEGORY_LABELS,
        today: dayjs().format('YYYY-MM-DD'),
        error: 'يرجى اختيار الطفل وكتابة نص الملاحظة.',
      });
    }

    const finalDate = note_type === 'daily' ? (note_date && dayjs(note_date).isValid() ? note_date : dayjs().format('YYYY-MM-DD')) : null;
    const finalCategory = ['health', 'food', 'transport', 'other'].includes(category) ? category : 'other';
    // Optional "HH:MM" alarm time — when set, the note triggers a sound alert
    // for the teacher as that time approaches (see public/js/note-alerts.js).
    const finalTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(note_time || '') ? note_time : null;

    await db.execute({
      sql: `INSERT INTO parent_notes (child_id, class_id, note_type, category, content, note_date, note_time, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [child.id, child.class_id, note_type, finalCategory, content.trim(), finalDate, finalTime, req.session.user.id],
    });

    const classResult = await db.execute({ sql: 'SELECT teacher_id FROM classes WHERE id = ?', args: [child.class_id] });
    const teacherId = classResult.rows[0] && classResult.rows[0].teacher_id;

    const title = `ملاحظة جديدة عن ${child.name}`;
    const message = content.trim();
    if (teacherId) await notify(teacherId, title, message, '/teacher/notes');
    await notifyMany(await adminsAndDirectors(), title, message, '/director/notes');

    res.redirect('/staff');
  } catch (err) {
    next(err);
  }
});

router.post('/notes/:id/delete', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE parent_notes SET archived = 1 WHERE id = ?', args: [req.params.id] });
    res.redirect('/staff');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
