const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const upload = require('../utils/upload');
const { notifyMany } = require('../utils/notify');

const router = express.Router();
router.use(requireRole('admin', 'director'));

async function getClasses() {
  const result = await db.execute(
    `SELECT classes.*, users.name AS teacher_name
     FROM classes LEFT JOIN users ON users.id = classes.teacher_id
     ORDER BY classes.name`
  );
  return result.rows;
}

async function itemsWithStatus(startDate, endDate) {
  const result = await db.execute({
    sql: `SELECT items.*,
                 GROUP_CONCAT(DISTINCT classes.name) AS class_names,
                 MIN(item_assignments.status) AS min_status,
                 COUNT(item_assignments.id) AS assignment_count,
                 SUM(CASE WHEN item_assignments.status = 'executed' THEN 1 ELSE 0 END) AS executed_count
          FROM items
          LEFT JOIN item_assignments ON item_assignments.item_id = items.id
          LEFT JOIN classes ON classes.id = item_assignments.class_id
          WHERE items.scheduled_date BETWEEN ? AND ?
          GROUP BY items.id
          ORDER BY items.scheduled_date ASC, items.id ASC`,
    args: [startDate, endDate],
  });
  return result.rows;
}

// ---------- Calendar (weekly / monthly) ----------
router.get('/', async (req, res, next) => {
  try {
    const view = req.query.view === 'month' ? 'month' : 'week';
    const anchor = req.query.date ? dayjs(req.query.date) : dayjs();

    const start = view === 'month' ? anchor.startOf('month').startOf('week') : anchor.startOf('week');
    const end = view === 'month' ? anchor.endOf('month').endOf('week') : anchor.endOf('week');

    const items = await itemsWithStatus(start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'));

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

    res.render('director/calendar', {
      title: 'التقويم التربوي',
      view,
      anchor: anchor.format('YYYY-MM-DD'),
      monthLabel: anchor.format('MMMM YYYY'),
      prevDate: (view === 'month' ? anchor.subtract(1, 'month') : anchor.subtract(1, 'week')).format('YYYY-MM-DD'),
      nextDate: (view === 'month' ? anchor.add(1, 'month') : anchor.add(1, 'week')).format('YYYY-MM-DD'),
      days,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Create ----------
router.get('/items/new', async (req, res, next) => {
  try {
    res.render('director/item-form', {
      title: 'إنشاء درس أو نشاط جديد',
      classes: await getClasses(),
      item: null,
      selectedClasses: [],
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/items', upload.array('attachments', 8), async (req, res, next) => {
  try {
    const { type, title, description, objective, materials, scheduled_date, priority } = req.body;
    let classIds = req.body.class_ids;
    if (!classIds) classIds = [];
    if (!Array.isArray(classIds)) classIds = [classIds];

    if (!title || !scheduled_date || classIds.length === 0) {
      return res.status(400).render('director/item-form', {
        title: 'إنشاء درس أو نشاط جديد',
        classes: await getClasses(),
        item: req.body,
        selectedClasses: classIds.map(Number),
        error: 'يرجى تعبئة العنوان والتاريخ واختيار فصل واحد على الأقل.',
      });
    }

    const attachments = (req.files || []).map(upload.fileToRecord);

    const insertResult = await db.execute({
      sql: `INSERT INTO items (type, title, description, objective, materials, scheduled_date, priority, attachments, created_by)
            VALUES (@type, @title, @description, @objective, @materials, @scheduled_date, @priority, @attachments, @created_by)`,
      args: {
        type: type === 'activity' ? 'activity' : 'lesson',
        title,
        description: description || '',
        objective: objective || '',
        materials: materials || '',
        scheduled_date,
        priority: ['normal', 'important', 'urgent'].includes(priority) ? priority : 'normal',
        attachments: JSON.stringify(attachments),
        created_by: req.session.user.id,
      },
    });

    const itemId = Number(insertResult.lastInsertRowid);
    const teacherIds = [];

    for (const cidRaw of classIds) {
      const cid = Number(cidRaw);
      // eslint-disable-next-line no-await-in-loop
      await db.execute({ sql: 'INSERT INTO item_assignments (item_id, class_id) VALUES (?, ?)', args: [itemId, cid] });
      // eslint-disable-next-line no-await-in-loop
      const clsResult = await db.execute({ sql: 'SELECT teacher_id FROM classes WHERE id = ?', args: [cid] });
      const cls = clsResult.rows[0];
      if (cls && cls.teacher_id) teacherIds.push(cls.teacher_id);
    }

    const typeLabel = type === 'activity' ? 'نشاط' : 'درس';
    await notifyMany(
      teacherIds,
      `${typeLabel} جديد: ${title}`,
      `تمت إضافة ${typeLabel} جديد بتاريخ ${dayjs(scheduled_date).format('DD/MM/YYYY')}`,
      `/teacher/items/${itemId}`
    );

    res.redirect(`/director/items/${itemId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- View / Edit / Delete ----------
router.get('/items/:id', async (req, res, next) => {
  try {
    const itemResult = await db.execute({ sql: 'SELECT * FROM items WHERE id = ?', args: [req.params.id] });
    const item = itemResult.rows[0];
    if (!item) return res.status(404).render('error', { title: 'غير موجود', message: 'العنصر غير موجود.' });

    const assignResult = await db.execute({
      sql: `SELECT item_assignments.*, classes.name AS class_name, classes.color AS class_color,
                   t1.name AS received_by_name, t2.name AS executed_by_name
            FROM item_assignments
            JOIN classes ON classes.id = item_assignments.class_id
            LEFT JOIN users t1 ON t1.id = item_assignments.received_by
            LEFT JOIN users t2 ON t2.id = item_assignments.executed_by
            WHERE item_assignments.item_id = ?
            ORDER BY classes.name`,
      args: [item.id],
    });

    res.render('director/item-detail', {
      title: item.title,
      item: { ...item, attachments: JSON.parse(item.attachments || '[]') },
      assignments: assignResult.rows.map((a) => ({ ...a, execution_photos: JSON.parse(a.execution_photos || '[]') })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/items/:id/edit', async (req, res, next) => {
  try {
    const itemResult = await db.execute({ sql: 'SELECT * FROM items WHERE id = ?', args: [req.params.id] });
    const item = itemResult.rows[0];
    if (!item) return res.status(404).render('error', { title: 'غير موجود', message: 'العنصر غير موجود.' });

    const selResult = await db.execute({ sql: 'SELECT class_id FROM item_assignments WHERE item_id = ?', args: [item.id] });
    const selected = selResult.rows.map((r) => r.class_id);

    res.render('director/item-form', {
      title: 'تعديل درس/نشاط',
      classes: await getClasses(),
      item: { ...item, attachments: JSON.parse(item.attachments || '[]') },
      selectedClasses: selected,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/items/:id', upload.array('attachments', 8), async (req, res, next) => {
  try {
    const itemResult = await db.execute({ sql: 'SELECT * FROM items WHERE id = ?', args: [req.params.id] });
    const item = itemResult.rows[0];
    if (!item) return res.status(404).render('error', { title: 'غير موجود', message: 'العنصر غير موجود.' });

    const { type, title, description, objective, materials, scheduled_date, priority } = req.body;
    let existingAttachments = JSON.parse(item.attachments || '[]');
    if (req.body.remove_attachments) {
      const toRemove = Array.isArray(req.body.remove_attachments) ? req.body.remove_attachments : [req.body.remove_attachments];
      existingAttachments = existingAttachments.filter((a) => !toRemove.includes(a.id));
    }
    const newAttachments = (req.files || []).map(upload.fileToRecord);
    const attachments = [...existingAttachments, ...newAttachments];

    await db.execute({
      sql: `UPDATE items SET type=@type, title=@title, description=@description, objective=@objective,
            materials=@materials, scheduled_date=@scheduled_date, priority=@priority, attachments=@attachments,
            updated_at=datetime('now') WHERE id=@id`,
      args: {
        type: type === 'activity' ? 'activity' : 'lesson',
        title,
        description: description || '',
        objective: objective || '',
        materials: materials || '',
        scheduled_date,
        priority: ['normal', 'important', 'urgent'].includes(priority) ? priority : 'normal',
        attachments: JSON.stringify(attachments),
        id: item.id,
      },
    });

    let classIds = req.body.class_ids;
    if (!classIds) classIds = [];
    if (!Array.isArray(classIds)) classIds = [classIds];
    classIds = classIds.map(Number);

    const currentResult = await db.execute({ sql: 'SELECT class_id FROM item_assignments WHERE item_id = ?', args: [item.id] });
    const currentAssignments = currentResult.rows.map((r) => r.class_id);
    const toAdd = classIds.filter((c) => !currentAssignments.includes(c));
    const toRemove = currentAssignments.filter((c) => !classIds.includes(c));

    const teacherIds = [];
    for (const cid of toAdd) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({ sql: 'INSERT INTO item_assignments (item_id, class_id) VALUES (?, ?)', args: [item.id, cid] });
      // eslint-disable-next-line no-await-in-loop
      const clsResult = await db.execute({ sql: 'SELECT teacher_id FROM classes WHERE id = ?', args: [cid] });
      const cls = clsResult.rows[0];
      if (cls && cls.teacher_id) teacherIds.push(cls.teacher_id);
    }
    for (const cid of toRemove) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({ sql: 'DELETE FROM item_assignments WHERE item_id = ? AND class_id = ?', args: [item.id, cid] });
    }

    if (teacherIds.length) {
      const typeLabel = type === 'activity' ? 'نشاط' : 'درس';
      await notifyMany(teacherIds, `${typeLabel} جديد: ${title}`, `تمت إضافة فصلك إلى ${typeLabel}`, `/teacher/items/${item.id}`);
    }

    res.redirect(`/director/items/${item.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/items/:id/delete', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM items WHERE id = ?', args: [req.params.id] });
    res.redirect('/director');
  } catch (err) {
    next(err);
  }
});

// ---------- Parent notes (read-only overview across all classes) ----------
const NOTE_CATEGORY_LABELS = { health: '💊 صحة/دواء', food: '🍽️ طعام', transport: '🚌 نقل', other: '📝 أخرى' };

router.get('/notes', async (req, res, next) => {
  try {
    const showAll = req.query.all === '1';
    const today = dayjs().format('YYYY-MM-DD');
    const result = await db.execute({
      sql: `SELECT parent_notes.*, children.name AS child_name, classes.name AS class_name, classes.color AS class_color,
                   creator.name AS created_by_name, doer.name AS done_by_name
            FROM parent_notes
            JOIN children ON children.id = parent_notes.child_id
            JOIN classes ON classes.id = parent_notes.class_id
            LEFT JOIN users creator ON creator.id = parent_notes.created_by
            LEFT JOIN users doer ON doer.id = parent_notes.done_by
            WHERE (? = 1 OR (parent_notes.archived = 0 AND (parent_notes.note_type = 'permanent' OR parent_notes.note_date = ?)))
            ORDER BY parent_notes.created_at DESC`,
      args: [showAll ? 1 : 0, today],
    });

    res.render('director/notes', {
      title: 'ملاحظات وتوصيات الأولياء',
      notes: result.rows,
      categoryLabels: NOTE_CATEGORY_LABELS,
      showAll,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/notes/:id/delete', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE parent_notes SET archived = 1 WHERE id = ?', args: [req.params.id] });
    res.redirect('/director/notes');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
