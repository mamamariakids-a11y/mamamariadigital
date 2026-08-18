const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { MEAL_LABELS, NAP_LABELS, MOOD_LABELS } = require('../utils/dailyReportLabels');
const { notifyMany } = require('../utils/notify');
const { logAudit } = require('../utils/audit');
const finance = require('../utils/finance');
const { METHOD_LABELS, REASON_LABELS, FEE_STATUS_LABELS } = require('../utils/financeLabels');

const router = express.Router();
router.use(requireRole('parent'));

async function myChildren(parentId) {
  const result = await db.execute({
    sql: `SELECT children.*, classes.name AS class_name FROM children
          LEFT JOIN classes ON classes.id = children.class_id WHERE children.parent_id = ?`,
    args: [parentId],
  });
  return result.rows;
}

router.get('/', async (req, res, next) => {
  try {
    const childrenResult = await db.execute({
      sql: `SELECT children.*, classes.name AS class_name, classes.id AS class_id
            FROM children LEFT JOIN classes ON classes.id = children.class_id
            WHERE children.parent_id = ?`,
      args: [req.session.user.id],
    });
    const children = childrenResult.rows;
    const childIds = children.map((c) => c.id);

    const classIds = [...new Set(children.map((c) => c.class_id).filter(Boolean))];

    let feed = [];
    if (classIds.length) {
      const placeholders = classIds.map(() => '?').join(',');
      const feedResult = await db.execute({
        sql: `SELECT item_assignments.*, items.title, items.description, items.type, items.scheduled_date,
                     classes.name AS class_name, users.name AS teacher_name
              FROM item_assignments
              JOIN items ON items.id = item_assignments.item_id
              JOIN classes ON classes.id = item_assignments.class_id
              LEFT JOIN users ON users.id = item_assignments.executed_by
              WHERE item_assignments.class_id IN (${placeholders}) AND item_assignments.status = 'executed'
              ORDER BY item_assignments.executed_at DESC
              LIMIT 50`,
        args: classIds,
      });
      feed = feedResult.rows.map((r) => ({ ...r, execution_photos: JSON.parse(r.execution_photos || '[]') }));
    }

    let dailyReports = [];
    if (childIds.length) {
      const placeholders = childIds.map(() => '?').join(',');
      const drResult = await db.execute({
        sql: `SELECT daily_reports.*, children.name AS child_name
              FROM daily_reports JOIN children ON children.id = daily_reports.child_id
              WHERE daily_reports.child_id IN (${placeholders})
              ORDER BY daily_reports.date DESC, daily_reports.updated_at DESC
              LIMIT 20`,
        args: childIds,
      });
      dailyReports = drResult.rows;
    }

    res.render('parent/feed', {
      title: 'أنشطة طفلي',
      children,
      feed,
      dailyReports,
      mealLabels: MEAL_LABELS,
      napLabels: NAP_LABELS,
      moodLabels: MOOD_LABELS,
      hasChildren: children.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Per-child page: health record + emergency contacts (parent can view & edit their own child) ----------
async function loadOwnChild(childId, parentId) {
  const childResult = await db.execute({
    sql: `SELECT children.*, classes.name AS class_name FROM children
          LEFT JOIN classes ON classes.id = children.class_id
          WHERE children.id = ? AND children.parent_id = ?`,
    args: [childId, parentId],
  });
  return childResult.rows[0] || null;
}

router.get('/children/:id', async (req, res, next) => {
  try {
    const child = await loadOwnChild(req.params.id, req.session.user.id);
    if (!child) return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس مرتبطًا بحسابك.' });

    const healthResult = await db.execute({ sql: 'SELECT * FROM health_profiles WHERE child_id = ?', args: [child.id] });
    const contactsResult = await db.execute({ sql: 'SELECT * FROM emergency_contacts WHERE child_id = ? ORDER BY id', args: [child.id] });
    const assessmentsResult = await db.execute({
      sql: `SELECT development_assessments.*, users.name AS assessed_by_name FROM development_assessments
            LEFT JOIN users ON users.id = development_assessments.assessed_by
            WHERE child_id = ? ORDER BY created_at DESC`,
      args: [child.id],
    });
    const pendingPickupResult = await db.execute({
      sql: "SELECT * FROM pickup_requests WHERE child_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
      args: [child.id],
    });

    res.render('parent/child-detail', {
      title: child.name,
      child,
      healthProfile: healthResult.rows[0] || null,
      contacts: contactsResult.rows,
      assessments: assessmentsResult.rows,
      pendingPickup: pendingPickupResult.rows[0] || null,
      editable: true,
      actionPrefix: `/parent/children/${child.id}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/health', async (req, res, next) => {
  try {
    const child = await loadOwnChild(req.params.id, req.session.user.id);
    if (!child) return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس مرتبطًا بحسابك.' });

    const { blood_type, allergies, chronic_conditions, medications, doctor_name, doctor_phone, notes } = req.body;
    await db.execute({
      sql: `INSERT INTO health_profiles (child_id, blood_type, allergies, chronic_conditions, medications, doctor_name, doctor_phone, notes, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(child_id) DO UPDATE SET
              blood_type=excluded.blood_type, allergies=excluded.allergies, chronic_conditions=excluded.chronic_conditions,
              medications=excluded.medications, doctor_name=excluded.doctor_name, doctor_phone=excluded.doctor_phone,
              notes=excluded.notes, updated_by=excluded.updated_by, updated_at=datetime('now')`,
      args: [child.id, blood_type || null, allergies || null, chronic_conditions || null, medications || null, doctor_name || null, doctor_phone || null, notes || null, req.session.user.id],
    });
    res.redirect(`/parent/children/${child.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/contacts', async (req, res, next) => {
  try {
    const child = await loadOwnChild(req.params.id, req.session.user.id);
    if (!child) return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس مرتبطًا بحسابك.' });

    const { name, relation, phone } = req.body;
    if (name && phone) {
      await db.execute({
        sql: 'INSERT INTO emergency_contacts (child_id, name, relation, phone, can_pickup) VALUES (?, ?, ?, ?, ?)',
        args: [child.id, name.trim(), (relation || '').trim(), phone.trim(), req.body.can_pickup ? 1 : 0],
      });
    }
    res.redirect(`/parent/children/${child.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/contacts/:contactId/delete', async (req, res, next) => {
  try {
    const child = await loadOwnChild(req.params.id, req.session.user.id);
    if (!child) return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس مرتبطًا بحسابك.' });

    await db.execute({ sql: 'DELETE FROM emergency_contacts WHERE id = ? AND child_id = ?', args: [req.params.contactId, child.id] });
    res.redirect(`/parent/children/${child.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Pickup request ("أنا أمام الروضة — استدعاء طفلي") ----------
async function staffToNotifyForPickup() {
  const result = await db.execute("SELECT id FROM users WHERE role IN ('admin', 'director', 'staff') AND active = 1");
  return result.rows.map((r) => r.id);
}

router.post('/children/:id/request-pickup', async (req, res, next) => {
  try {
    const child = await loadOwnChild(req.params.id, req.session.user.id);
    if (!child) return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس مرتبطًا بحسابك.' });

    // Guard against a parent double-tapping the button — one open request
    // per child at a time. Different parents/children requesting at the
    // exact same instant are unaffected (each gets its own auto-ID row).
    const existing = await db.execute({ sql: "SELECT id FROM pickup_requests WHERE child_id = ? AND status = 'pending'", args: [child.id] });
    if (!existing.rows.length) {
      const insertResult = await db.execute({
        sql: 'INSERT INTO pickup_requests (child_id, parent_id) VALUES (?, ?)',
        args: [child.id, req.session.user.id],
      });
      await logAudit(req.session.user, 'pickup.request', { entityType: 'pickup_request', entityId: Number(insertResult.lastInsertRowid), details: { child: child.name } });
      await notifyMany(await staffToNotifyForPickup(), `طلب استدعاء: ${child.name} 🚸`, `ولي أمر ${child.name} أمام الروضة الآن لاستلامه.`, '/pickup');
    }

    res.redirect(req.get('Referrer') || '/parent');
  } catch (err) {
    next(err);
  }
});

// Polled by the parent feed page so "بانتظار الاستلام" / "تم التسليم" updates
// live without a manual refresh.
router.get('/pickup/status.json', async (req, res, next) => {
  try {
    const children = await myChildren(req.session.user.id);
    const childIds = children.map((c) => c.id);
    if (!childIds.length) return res.json({ items: [] });
    const placeholders = childIds.map(() => '?').join(',');
    const result = await db.execute({
      sql: `SELECT pickup_requests.*, children.name AS child_name FROM pickup_requests
            JOIN children ON children.id = pickup_requests.child_id
            WHERE pickup_requests.child_id IN (${placeholders})
              AND (pickup_requests.status = 'pending' OR date(pickup_requests.delivered_at) = date('now'))
            ORDER BY pickup_requests.requested_at DESC`,
      args: childIds,
    });
    res.json({ items: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------- Financial view (read-only, only when the admin enables it) ----------
router.get('/finance', async (req, res, next) => {
  try {
    const settings = await finance.getFinancialSettings();
    if (!settings.parent_finance_visible) {
      return res.status(403).render('error', { title: 'غير متاح', message: 'الجانب المالي غير مفعّل حاليًا من إدارة الروضة.' });
    }
    const children = await myChildren(req.session.user.id);
    const perChild = [];
    let familyDue = 0;
    let familyPaid = 0;
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop
      const balance = await finance.getChildBalance(child.id);
      // eslint-disable-next-line no-await-in-loop
      const receiptsResult = await db.execute({
        sql: `SELECT payment_receipts.*, payments.reason, payments.method, payments.created_at
              FROM payment_receipts JOIN payments ON payments.id = payment_receipts.payment_id
              WHERE payment_receipts.child_id = ? AND payments.status = 'active'
              ORDER BY payment_receipts.created_at DESC LIMIT 20`,
        args: [child.id],
      });
      familyDue += balance.totalDue;
      familyPaid += balance.totalPaid;
      perChild.push({ child, balance, receipts: receiptsResult.rows });
    }

    res.render('parent/finance', {
      title: 'الجانب المالي',
      perChild,
      familyDue,
      familyPaid,
      familyRemaining: Math.max(0, familyDue - familyPaid),
      hasMultiple: children.length > 1,
      methodLabels: METHOD_LABELS,
      reasonLabels: REASON_LABELS,
      feeStatusLabels: FEE_STATUS_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
