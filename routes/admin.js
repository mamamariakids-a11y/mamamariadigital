const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { uploadImportFile, parseImportFile, randomPassword } = require('../utils/importChildren');
const { buildBackupWorkbook } = require('../utils/exportBackup');
const { buildMonthlyReportPdf, getMonthlyReportData } = require('../utils/monthlyReport');
const { MEAL_LABELS, NAP_LABELS, MOOD_LABELS } = require('../utils/dailyReportLabels');
const { qrDataUrl } = require('../utils/qrcode');
const { buildIdCardPdf } = require('../utils/idCardPdf');
const { logAudit } = require('../utils/audit');
const { notifyMany } = require('../utils/notify');

// Loaded once and reused for every report — avoids re-reading the file from
// disk on each request.
let logoDataUri = null;
function getLogoDataUri() {
  if (logoDataUri === null) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png'));
      logoDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    } catch (e) {
      logoDataUri = ''; // logo missing — report still renders fine without it
    }
  }
  return logoDataUri;
}

const router = express.Router();
router.use(requireRole('admin'));

function randomColor() {
  const palette = ['#5B8DEF', '#3AA0A0', '#E0A23A', '#B65C9E', '#4A7CE0', '#D9634F'];
  return palette[Math.floor(Math.random() * palette.length)];
}

// ---------- Dashboard ----------
router.get('/', async (req, res, next) => {
  try {
    const startWeek = dayjs().startOf('week').format('YYYY-MM-DD');
    const endWeek = dayjs().endOf('week').format('YYYY-MM-DD');

    const totalsResult = await db.execute({
      sql: `SELECT
        (SELECT COUNT(*) FROM item_assignments ia JOIN items i ON i.id = ia.item_id WHERE i.scheduled_date BETWEEN ? AND ?) AS total,
        (SELECT COUNT(*) FROM item_assignments ia JOIN items i ON i.id = ia.item_id WHERE i.scheduled_date BETWEEN ? AND ? AND ia.status='pending') AS pending,
        (SELECT COUNT(*) FROM item_assignments ia JOIN items i ON i.id = ia.item_id WHERE i.scheduled_date BETWEEN ? AND ? AND ia.status='received') AS received,
        (SELECT COUNT(*) FROM item_assignments ia JOIN items i ON i.id = ia.item_id WHERE i.scheduled_date BETWEEN ? AND ? AND ia.status='executed') AS executed
      `,
      args: [startWeek, endWeek, startWeek, endWeek, startWeek, endWeek, startWeek, endWeek],
    });
    const totals = totalsResult.rows[0];

    const classesCountResult = await db.execute('SELECT COUNT(*) AS c FROM classes');
    const teachersCountResult = await db.execute("SELECT COUNT(*) AS c FROM users WHERE role='teacher' AND active=1");
    const childrenCountResult = await db.execute('SELECT COUNT(*) AS c FROM children');

    const classesOverviewResult = await db.execute({
      sql: `SELECT classes.id, classes.name, classes.color, users.name AS teacher_name,
        (SELECT COUNT(*) FROM item_assignments ia JOIN items i ON i.id=ia.item_id WHERE ia.class_id=classes.id AND i.scheduled_date BETWEEN ? AND ?) AS assigned_count,
        (SELECT COUNT(*) FROM item_assignments ia JOIN items i ON i.id=ia.item_id WHERE ia.class_id=classes.id AND i.scheduled_date BETWEEN ? AND ? AND ia.status='executed') AS done_count
       FROM classes LEFT JOIN users ON users.id = classes.teacher_id
       ORDER BY classes.name`,
      args: [startWeek, endWeek, startWeek, endWeek],
    });

    const recentItemsResult = await db.execute(
      `SELECT items.*, GROUP_CONCAT(DISTINCT classes.name) AS class_names
       FROM items LEFT JOIN item_assignments ON item_assignments.item_id = items.id
       LEFT JOIN classes ON classes.id = item_assignments.class_id
       GROUP BY items.id ORDER BY items.created_at DESC LIMIT 6`
    );

    res.render('admin/dashboard', {
      title: 'لوحة التحكم',
      totals,
      classesCount: Number(classesCountResult.rows[0].c),
      teachersCount: Number(teachersCountResult.rows[0].c),
      childrenCount: Number(childrenCountResult.rows[0].c),
      classesOverview: classesOverviewResult.rows,
      recentItems: recentItemsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Users ----------
router.get('/users', async (req, res, next) => {
  try {
    const result = await db.execute("SELECT * FROM users ORDER BY (role = 'admin') DESC, role, name");
    res.render('admin/users', { title: 'المستخدمون', users: result.rows, error: null, formData: null });
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const { name, email, password, role, phone } = req.body;
    if (!name || !email || !password || !role) {
      const result = await db.execute('SELECT * FROM users ORDER BY role, name');
      return res.status(400).render('admin/users', { title: 'المستخدمون', users: result.rows, error: 'يرجى تعبئة جميع الحقول المطلوبة.', formData: req.body });
    }
    try {
      await db.execute({
        sql: 'INSERT INTO users (name, email, password_hash, role, phone, avatar_color) VALUES (?, ?, ?, ?, ?, ?)',
        args: [name, email.trim().toLowerCase(), bcrypt.hashSync(password, 10), role, phone || '', randomColor()],
      });
      res.redirect('/admin/users');
    } catch (e) {
      const result = await db.execute('SELECT * FROM users ORDER BY role, name');
      res.status(400).render('admin/users', {
        title: 'المستخدمون',
        users: result.rows,
        error: e.message.includes('UNIQUE') ? 'هذا البريد الإلكتروني مستخدم بالفعل.' : 'حدث خطأ أثناء الإضافة.',
        formData: req.body,
      });
    }
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/toggle', async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.params.id] });
    const u = result.rows[0];
    if (u) await db.execute({ sql: 'UPDATE users SET active = ? WHERE id = ?', args: [u.active ? 0 : 1, u.id] });
    res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/delete', async (req, res, next) => {
  try {
    try {
      await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [req.params.id] });
    } catch (e) {
      // has related records (e.g. created items) -> deactivate instead of hard delete
      await db.execute({ sql: 'UPDATE users SET active = 0 WHERE id = ?', args: [req.params.id] });
    }
    res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
});

// ---------- Classes ----------
router.get('/classes', async (req, res, next) => {
  try {
    const classesResult = await db.execute(
      `SELECT classes.*, users.name AS teacher_name,
        (SELECT COUNT(*) FROM children WHERE children.class_id = classes.id) AS children_count
       FROM classes LEFT JOIN users ON users.id = classes.teacher_id ORDER BY classes.name`
    );
    const teachersResult = await db.execute("SELECT * FROM users WHERE role='teacher' AND active=1 ORDER BY name");
    res.render('admin/classes', { title: 'الفصول', classes: classesResult.rows, teachers: teachersResult.rows, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/classes', async (req, res, next) => {
  try {
    const { name, age_range, teacher_id } = req.body;
    if (!name) {
      const classesResult = await db.execute('SELECT classes.*, users.name AS teacher_name FROM classes LEFT JOIN users ON users.id=classes.teacher_id');
      const teachersResult = await db.execute("SELECT * FROM users WHERE role='teacher' AND active=1");
      return res.status(400).render('admin/classes', { title: 'الفصول', classes: classesResult.rows, teachers: teachersResult.rows, error: 'اسم الفصل مطلوب.' });
    }
    await db.execute({
      sql: 'INSERT INTO classes (name, age_range, teacher_id, color) VALUES (?, ?, ?, ?)',
      args: [name, age_range || '', teacher_id || null, randomColor()],
    });
    res.redirect('/admin/classes');
  } catch (err) {
    next(err);
  }
});

router.post('/classes/:id', async (req, res, next) => {
  try {
    const { name, age_range, teacher_id } = req.body;
    await db.execute({
      sql: 'UPDATE classes SET name=?, age_range=?, teacher_id=? WHERE id=?',
      args: [name, age_range || '', teacher_id || null, req.params.id],
    });
    res.redirect('/admin/classes');
  } catch (err) {
    next(err);
  }
});

router.post('/classes/:id/delete', async (req, res, next) => {
  try {
    try {
      await db.execute({ sql: 'DELETE FROM classes WHERE id = ?', args: [req.params.id] });
    } catch (e) {
      // ignore if referenced
    }
    res.redirect('/admin/classes');
  } catch (err) {
    next(err);
  }
});

// ---------- Children ----------
router.get('/children', async (req, res, next) => {
  try {
    const childrenResult = await db.execute(
      `SELECT children.*, classes.name AS class_name, users.name AS parent_name
       FROM children LEFT JOIN classes ON classes.id = children.class_id
       LEFT JOIN users ON users.id = children.parent_id ORDER BY children.name`
    );
    const classesResult = await db.execute('SELECT * FROM classes ORDER BY name');
    const parentsResult = await db.execute("SELECT * FROM users WHERE role='parent' AND active=1 ORDER BY name");
    res.render('admin/children', {
      title: 'الأطفال',
      children: childrenResult.rows,
      classes: classesResult.rows,
      parents: parentsResult.rows,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/children', async (req, res, next) => {
  try {
    const { name, class_id, parent_id } = req.body;
    if (!name) return res.redirect('/admin/children');
    await db.execute({
      sql: 'INSERT INTO children (name, class_id, parent_id) VALUES (?, ?, ?)',
      args: [name, class_id || null, parent_id || null],
    });
    res.redirect('/admin/children');
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/delete', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM children WHERE id = ?', args: [req.params.id] });
    res.redirect('/admin/children');
  } catch (err) {
    next(err);
  }
});

// ---------- Child detail: basic info + health record + emergency contacts ----------
async function loadChildDetail(childId) {
  const childResult = await db.execute({
    sql: `SELECT children.*, classes.name AS class_name, users.name AS parent_name
          FROM children LEFT JOIN classes ON classes.id = children.class_id
          LEFT JOIN users ON users.id = children.parent_id WHERE children.id = ?`,
    args: [childId],
  });
  const child = childResult.rows[0];
  if (!child) return null;
  const healthResult = await db.execute({ sql: 'SELECT * FROM health_profiles WHERE child_id = ?', args: [childId] });
  const contactsResult = await db.execute({ sql: 'SELECT * FROM emergency_contacts WHERE child_id = ? ORDER BY id', args: [childId] });
  const assessmentsResult = await db.execute({
    sql: `SELECT development_assessments.*, users.name AS assessed_by_name FROM development_assessments
          LEFT JOIN users ON users.id = development_assessments.assessed_by
          WHERE child_id = ? ORDER BY created_at DESC`,
    args: [childId],
  });
  return { child, healthProfile: healthResult.rows[0] || null, contacts: contactsResult.rows, assessments: assessmentsResult.rows };
}

const DOMAIN_LABELS = { motor: 'الحركي', cognitive: 'المعرفي', language: 'اللغوي', social: 'الاجتماعي', autonomy: 'الاستقلالية' };
const LEVEL_LABELS = { emerging: 'ناشئ', developing: 'في تطور', proficient: 'متمكّن' };

router.get('/children/:id', async (req, res, next) => {
  try {
    const detail = await loadChildDetail(req.params.id);
    if (!detail) return res.status(404).render('error', { title: 'غير موجود', message: 'الطفل غير موجود.' });
    const classesResult = await db.execute('SELECT * FROM classes ORDER BY name');
    const parentsResult = await db.execute("SELECT * FROM users WHERE role='parent' AND active=1 ORDER BY name");
    res.render('admin/child-detail', {
      title: detail.child.name,
      child: detail.child,
      healthProfile: detail.healthProfile,
      contacts: detail.contacts,
      assessments: detail.assessments,
      domainLabels: DOMAIN_LABELS,
      levelLabels: LEVEL_LABELS,
      classes: classesResult.rows,
      parents: parentsResult.rows,
      editable: true,
      actionPrefix: `/admin/children/${detail.child.id}`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Printable QR ID card ----------
router.get('/children/:id/id-card', async (req, res, next) => {
  try {
    const detail = await loadChildDetail(req.params.id);
    if (!detail) return res.status(404).render('error', { title: 'غير موجود', message: 'الطفل غير موجود.' });
    const classResult = detail.child.class_id
      ? await db.execute({ sql: 'SELECT name FROM classes WHERE id = ?', args: [detail.child.class_id] })
      : { rows: [] };
    const lookupUrl = `${req.protocol}://${req.get('host')}/q/${detail.child.qr_token}`;
    const qrData = await qrDataUrl(lookupUrl);
    const pdfBuffer = await buildIdCardPdf({
      child: detail.child,
      className: classResult.rows[0] ? classResult.rows[0].name : null,
      qrDataUrl: qrData,
      logoBase64: getLogoDataUri(),
    });
    const filename = `بطاقة-${detail.child.name}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id', async (req, res, next) => {
  try {
    const { name, class_id, parent_id } = req.body;
    if (!name) return res.redirect(`/admin/children/${req.params.id}`);
    await db.execute({
      sql: 'UPDATE children SET name=?, class_id=?, parent_id=? WHERE id=?',
      args: [name, class_id || null, parent_id || null, req.params.id],
    });
    res.redirect(`/admin/children/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/health', async (req, res, next) => {
  try {
    const { blood_type, allergies, chronic_conditions, medications, doctor_name, doctor_phone, notes } = req.body;
    await db.execute({
      sql: `INSERT INTO health_profiles (child_id, blood_type, allergies, chronic_conditions, medications, doctor_name, doctor_phone, notes, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(child_id) DO UPDATE SET
              blood_type=excluded.blood_type, allergies=excluded.allergies, chronic_conditions=excluded.chronic_conditions,
              medications=excluded.medications, doctor_name=excluded.doctor_name, doctor_phone=excluded.doctor_phone,
              notes=excluded.notes, updated_by=excluded.updated_by, updated_at=datetime('now')`,
      args: [req.params.id, blood_type || null, allergies || null, chronic_conditions || null, medications || null, doctor_name || null, doctor_phone || null, notes || null, req.session.user.id],
    });
    res.redirect(`/admin/children/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/contacts', async (req, res, next) => {
  try {
    const { name, relation, phone } = req.body;
    if (name && phone) {
      await db.execute({
        sql: 'INSERT INTO emergency_contacts (child_id, name, relation, phone, can_pickup) VALUES (?, ?, ?, ?, ?)',
        args: [req.params.id, name.trim(), (relation || '').trim(), phone.trim(), req.body.can_pickup ? 1 : 0],
      });
    }
    res.redirect(`/admin/children/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/contacts/:contactId/delete', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM emergency_contacts WHERE id = ? AND child_id = ?', args: [req.params.contactId, req.params.id] });
    res.redirect(`/admin/children/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Bulk import of children (from Excel/CSV) ----------
router.post('/children/import', (req, res, next) => {
  uploadImportFile.single('import_file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).render('admin/children-import-result', {
        title: 'نتيجة الاستيراد',
        fileError: uploadErr.message || 'تعذّر قراءة الملف.',
        summary: null,
      });
    }
    if (!req.file) {
      return res.status(400).render('admin/children-import-result', {
        title: 'نتيجة الاستيراد',
        fileError: 'يرجى اختيار ملف Excel أو CSV أولًا.',
        summary: null,
      });
    }

    let records;
    try {
      ({ records } = await parseImportFile(req.file.buffer, req.file.originalname));
    } catch (parseErr) {
      return res.status(400).render('admin/children-import-result', {
        title: 'نتيجة الاستيراد',
        fileError: 'تعذّر فتح هذا الملف. تأكدي أنه ملف Excel أو CSV سليم وغير تالف (يمكنك تنزيل القالب من جديد والبدء منه).',
        summary: null,
      });
    }

    try {
      if (!records.length) {
        return res.status(400).render('admin/children-import-result', {
          title: 'نتيجة الاستيراد',
          fileError: 'لم يتم العثور على أي بيانات صالحة في الملف. تأكدي من استخدام القالب المرفق وعدم تغيير صف العناوين.',
          summary: null,
        });
      }

      const classesResult = await db.execute('SELECT id, name FROM classes');
      const classByName = new Map(classesResult.rows.map((c) => [c.name.trim().toLowerCase(), c.id]));

      const parentsResult = await db.execute("SELECT id, email FROM users WHERE role='parent'");
      const parentIdByEmail = new Map(parentsResult.rows.map((p) => [p.email.trim().toLowerCase(), p.id]));

      const added = [];
      const skipped = [];
      const errors = [];
      const newParents = [];

      for (const rec of records) {
        if (!rec.child_name || !rec.class_name) {
          errors.push({ rowNum: rec.rowNum, reason: 'اسم الطفل أو اسم الفصل مفقود.' });
          continue;
        }

        const classId = classByName.get(rec.class_name.trim().toLowerCase());
        if (!classId) {
          errors.push({ rowNum: rec.rowNum, reason: `الفصل "${rec.class_name}" غير موجود في البرنامج.` });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const existingResult = await db.execute({
          sql: 'SELECT id FROM children WHERE class_id = ? AND LOWER(TRIM(name)) = ?',
          args: [classId, rec.child_name.trim().toLowerCase()],
        });
        if (existingResult.rows.length) {
          skipped.push({ rowNum: rec.rowNum, reason: `الطفل "${rec.child_name}" موجود بالفعل في هذا الفصل.` });
          continue;
        }

        let parentId = null;
        let parentNote = null;
        if (rec.parent_email) {
          const emailKey = rec.parent_email.trim().toLowerCase();
          if (parentIdByEmail.has(emailKey)) {
            parentId = parentIdByEmail.get(emailKey);
          } else {
            const tempPassword = randomPassword();
            try {
              // eslint-disable-next-line no-await-in-loop
              const insertParent = await db.execute({
                sql: 'INSERT INTO users (name, email, password_hash, role, phone, avatar_color) VALUES (?, ?, ?, ?, ?, ?)',
                args: [rec.parent_name || rec.child_name + ' - ولي أمر', emailKey, bcrypt.hashSync(tempPassword, 10), 'parent', rec.parent_phone || '', randomColor()],
              });
              parentId = Number(insertParent.lastInsertRowid);
              parentIdByEmail.set(emailKey, parentId);
              newParents.push({ name: rec.parent_name || '—', email: emailKey, password: tempPassword });
            } catch (e) {
              // Extremely unlikely race (email created moments earlier) — re-check and link instead.
              // eslint-disable-next-line no-await-in-loop
              const recheck = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [emailKey] });
              if (recheck.rows.length) {
                parentId = recheck.rows[0].id;
                parentIdByEmail.set(emailKey, parentId);
              }
            }
          }
        } else if (rec.parent_name) {
          parentNote = 'لم يُنشأ حساب لولي الأمر (البريد الإلكتروني مفقود).';
        }

        // eslint-disable-next-line no-await-in-loop
        await db.execute({
          sql: 'INSERT INTO children (name, class_id, parent_id) VALUES (?, ?, ?)',
          args: [rec.child_name.trim(), classId, parentId],
        });

        added.push({ rowNum: rec.rowNum, name: rec.child_name.trim(), className: rec.class_name.trim(), parentNote });
      }

      res.render('admin/children-import-result', {
        title: 'نتيجة الاستيراد',
        fileError: null,
        summary: { added, skipped, errors, newParents },
      });
    } catch (err) {
      next(err);
    }
  });
});

// ---------- Attendance ----------
router.get('/attendance', async (req, res, next) => {
  try {
    const view = req.query.view === 'month' ? 'month' : 'day';

    if (view === 'month') {
      const month = req.query.month && dayjs(req.query.month, 'YYYY-MM', true).isValid() ? req.query.month : dayjs().format('YYYY-MM');
      const monthStart = dayjs(month, 'YYYY-MM').startOf('month').format('YYYY-MM-DD');
      const monthEnd = dayjs(month, 'YYYY-MM').endOf('month').format('YYYY-MM-DD');

      const rowsResult = await db.execute({
        sql: `SELECT children.id AS child_id, children.name AS child_name,
                     classes.id AS class_id, classes.name AS class_name, classes.color AS class_color,
                     SUM(CASE WHEN attendance.status='present' THEN 1 ELSE 0 END) AS present_count,
                     SUM(CASE WHEN attendance.status='absent' THEN 1 ELSE 0 END) AS absent_count
              FROM children
              JOIN classes ON classes.id = children.class_id
              LEFT JOIN attendance ON attendance.child_id = children.id AND attendance.date BETWEEN ? AND ?
              GROUP BY children.id
              ORDER BY classes.name, children.name`,
        args: [monthStart, monthEnd],
      });

      const children = rowsResult.rows.map((r) => {
        const present = Number(r.present_count);
        const absent = Number(r.absent_count);
        const marked = present + absent;
        return { ...r, present_count: present, absent_count: absent, marked, rate: marked ? Math.round((present / marked) * 100) : null };
      });

      const classesMap = new Map();
      children.forEach((c) => {
        if (!classesMap.has(c.class_id)) classesMap.set(c.class_id, { id: c.class_id, name: c.class_name, color: c.class_color, children: [], present: 0, marked: 0 });
        const cls = classesMap.get(c.class_id);
        cls.children.push(c);
        cls.present += c.present_count;
        cls.marked += c.marked;
      });
      const classesReport = [...classesMap.values()].map((c) => ({ ...c, rate: c.marked ? Math.round((c.present / c.marked) * 100) : null }));

      return res.render('admin/attendance', {
        title: 'الحضور والغياب',
        view,
        month,
        monthLabel: dayjs(month, 'YYYY-MM').format('MMMM YYYY'),
        prevMonth: dayjs(month, 'YYYY-MM').subtract(1, 'month').format('YYYY-MM'),
        nextMonth: dayjs(month, 'YYYY-MM').add(1, 'month').format('YYYY-MM'),
        classesReport,
      });
    }

    const date = req.query.date && dayjs(req.query.date).isValid() ? req.query.date : dayjs().format('YYYY-MM-DD');

    const rowsResult = await db.execute({
      sql: `SELECT children.id AS child_id, children.name AS child_name,
                   classes.id AS class_id, classes.name AS class_name, classes.color AS class_color,
                   attendance.status, users.name AS marked_by_name
            FROM children
            JOIN classes ON classes.id = children.class_id
            LEFT JOIN attendance ON attendance.child_id = children.id AND attendance.date = ?
            LEFT JOIN users ON users.id = attendance.marked_by
            ORDER BY classes.name, children.name`,
      args: [date],
    });

    const classesMap = new Map();
    rowsResult.rows.forEach((r) => {
      if (!classesMap.has(r.class_id)) classesMap.set(r.class_id, { id: r.class_id, name: r.class_name, color: r.class_color, children: [], present: 0, absent: 0, unmarked: 0 });
      const cls = classesMap.get(r.class_id);
      cls.children.push(r);
      if (r.status === 'present') cls.present += 1;
      else if (r.status === 'absent') cls.absent += 1;
      else cls.unmarked += 1;
    });
    const classesToday = [...classesMap.values()];
    const totals = classesToday.reduce(
      (acc, c) => ({ present: acc.present + c.present, absent: acc.absent + c.absent, unmarked: acc.unmarked + c.unmarked }),
      { present: 0, absent: 0, unmarked: 0 }
    );

    res.render('admin/attendance', {
      title: 'الحضور والغياب',
      view,
      date,
      isToday: date === dayjs().format('YYYY-MM-DD'),
      prevDate: dayjs(date).subtract(1, 'day').format('YYYY-MM-DD'),
      nextDate: dayjs(date).add(1, 'day').format('YYYY-MM-DD'),
      classesToday,
      totals,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Daily report oversight ----------
router.get('/daily-reports', async (req, res, next) => {
  try {
    const date = req.query.date && dayjs(req.query.date).isValid() ? req.query.date : dayjs().format('YYYY-MM-DD');

    const rowsResult = await db.execute({
      sql: `SELECT children.id AS child_id, children.name AS child_name,
                   classes.id AS class_id, classes.name AS class_name, classes.color AS class_color,
                   daily_reports.meal_status, daily_reports.nap_status, daily_reports.nap_minutes,
                   daily_reports.mood, daily_reports.bathroom_count, daily_reports.notes
            FROM children
            JOIN classes ON classes.id = children.class_id
            LEFT JOIN daily_reports ON daily_reports.child_id = children.id AND daily_reports.date = ?
            ORDER BY classes.name, children.name`,
      args: [date],
    });

    const classesMap = new Map();
    rowsResult.rows.forEach((r) => {
      if (!classesMap.has(r.class_id)) classesMap.set(r.class_id, { id: r.class_id, name: r.class_name, color: r.class_color, children: [], filled: 0 });
      const cls = classesMap.get(r.class_id);
      cls.children.push(r);
      if (r.meal_status || r.nap_status || r.mood || r.bathroom_count !== null || r.notes) cls.filled += 1;
    });
    const classesToday = [...classesMap.values()];
    const totalChildren = rowsResult.rows.length;
    const totalFilled = classesToday.reduce((acc, c) => acc + c.filled, 0);

    res.render('admin/daily-reports', {
      title: 'التقرير اليومي للأطفال',
      date,
      isToday: date === dayjs().format('YYYY-MM-DD'),
      prevDate: dayjs(date).subtract(1, 'day').format('YYYY-MM-DD'),
      nextDate: dayjs(date).add(1, 'day').format('YYYY-MM-DD'),
      classesToday,
      totalChildren,
      totalFilled,
      mealLabels: MEAL_LABELS,
      napLabels: NAP_LABELS,
      moodLabels: MOOD_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Monthly PDF reports ----------
router.get('/reports', async (req, res, next) => {
  try {
    const month = req.query.month && dayjs(req.query.month, 'YYYY-MM', true).isValid() ? req.query.month : dayjs().format('YYYY-MM');
    const { classes } = await getMonthlyReportData(db, month);
    res.render('admin/reports', {
      title: 'التقارير الشهرية',
      month,
      monthLabel: dayjs(month, 'YYYY-MM').format('MMMM YYYY'),
      prevMonth: dayjs(month, 'YYYY-MM').subtract(1, 'month').format('YYYY-MM'),
      nextMonth: dayjs(month, 'YYYY-MM').add(1, 'month').format('YYYY-MM'),
      classes,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/reports/download', async (req, res, next) => {
  try {
    const month = req.query.month && dayjs(req.query.month, 'YYYY-MM', true).isValid() ? req.query.month : dayjs().format('YYYY-MM');
    const pdfBuffer = await buildMonthlyReportPdf(db, month, getLogoDataUri());
    const filename = `التقرير-الشهري-${month}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// ---------- Data export / backup ----------
router.get('/export', async (req, res, next) => {
  try {
    const counts = await Promise.all([
      db.execute('SELECT COUNT(*) AS c FROM users'),
      db.execute('SELECT COUNT(*) AS c FROM children'),
      db.execute('SELECT COUNT(*) AS c FROM attendance'),
      db.execute('SELECT COUNT(*) AS c FROM parent_notes'),
      db.execute('SELECT COUNT(*) AS c FROM items'),
      db.execute('SELECT COUNT(*) AS c FROM events'),
    ]);
    res.render('admin/export', {
      title: 'تصدير ونسخ احتياطي',
      counts: {
        users: Number(counts[0].rows[0].c),
        children: Number(counts[1].rows[0].c),
        attendance: Number(counts[2].rows[0].c),
        notes: Number(counts[3].rows[0].c),
        items: Number(counts[4].rows[0].c),
        events: Number(counts[5].rows[0].c),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/export/download', async (req, res, next) => {
  try {
    const workbook = await buildBackupWorkbook(db);
    const filename = `نسخة-احتياطية-روضة-ماما-ماريا-${dayjs().format('YYYY-MM-DD')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// ---------- Announcements (broadcast notifications, targeted by audience) ----------
// Reuses the existing per-user `notifications` table rather than a new
// schema — a "sent announcement" doesn't need its own row; the audit_log
// entry below is what lets the admin see broadcast history.
router.get('/announcements', async (req, res, next) => {
  try {
    const classesResult = await db.execute('SELECT * FROM classes ORDER BY name');
    const recentResult = await db.execute(
      "SELECT * FROM audit_log WHERE action = 'announcement.broadcast' ORDER BY created_at DESC LIMIT 20"
    );
    res.render('admin/announcements', {
      title: 'الإعلانات',
      classes: classesResult.rows,
      recent: recentResult.rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : {} })),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/announcements', async (req, res, next) => {
  try {
    const { title, message, audience, class_id } = req.body;
    if (!title || !title.trim() || !message || !message.trim()) {
      const classesResult = await db.execute('SELECT * FROM classes ORDER BY name');
      const recentResult = await db.execute("SELECT * FROM audit_log WHERE action = 'announcement.broadcast' ORDER BY created_at DESC LIMIT 20");
      return res.status(400).render('admin/announcements', {
        title: 'الإعلانات',
        classes: classesResult.rows,
        recent: recentResult.rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : {} })),
        error: 'يرجى كتابة العنوان والنص.',
      });
    }

    let recipientIds = [];
    let audienceLabel = '';
    if (audience === 'all_parents') {
      const r = await db.execute("SELECT id FROM users WHERE role = 'parent' AND active = 1");
      recipientIds = r.rows.map((row) => row.id);
      audienceLabel = 'جميع الأولياء';
    } else if (audience === 'all_staff') {
      const r = await db.execute("SELECT id FROM users WHERE role IN ('director','teacher','staff') AND active = 1");
      recipientIds = r.rows.map((row) => row.id);
      audienceLabel = 'جميع الطاقم';
    } else if (audience === 'class' && class_id) {
      const r = await db.execute({
        sql: `SELECT DISTINCT users.id FROM users JOIN children ON children.parent_id = users.id
              WHERE children.class_id = ? AND users.active = 1`,
        args: [class_id],
      });
      recipientIds = r.rows.map((row) => row.id);
      const classResult = await db.execute({ sql: 'SELECT name FROM classes WHERE id = ?', args: [class_id] });
      audienceLabel = `أولياء فصل ${classResult.rows[0] ? classResult.rows[0].name : ''}`;
    }

    await notifyMany(recipientIds, title.trim(), message.trim(), '/notifications');
    await logAudit(req.session.user, 'announcement.broadcast', {
      details: { title: title.trim(), audience: audienceLabel, recipientCount: recipientIds.length },
    });

    res.redirect('/admin/announcements');
  } catch (err) {
    next(err);
  }
});

// ---------- Audit log ----------
router.get('/audit-log', async (req, res, next) => {
  try {
    const result = await db.execute("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200");
    res.render('admin/audit-log', {
      title: 'سجل العمليات',
      logs: result.rows.map((r) => ({ ...r, details: r.details ? safeParse(r.details) : null })),
    });
  } catch (err) {
    next(err);
  }
});

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

module.exports = router;
