const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { notify, notifyMany } = require('../utils/notify');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Staff, the pedagogical director, and the kindergarten director all need to
// see and act on the live pickup queue at the reception desk.
router.use(requireRole('admin', 'director', 'staff'));

async function pendingQueue() {
  const result = await db.execute(
    `SELECT pickup_requests.*, children.name AS child_name, classes.name AS class_name, classes.color AS class_color,
            users.name AS parent_name, users.phone AS parent_phone
     FROM pickup_requests
     JOIN children ON children.id = pickup_requests.child_id
     LEFT JOIN classes ON classes.id = children.class_id
     LEFT JOIN users ON users.id = pickup_requests.parent_id
     WHERE pickup_requests.status = 'pending'
     ORDER BY pickup_requests.requested_at ASC`
  );
  return result.rows;
}

async function recentlyDelivered() {
  const result = await db.execute(
    `SELECT pickup_requests.*, children.name AS child_name, classes.name AS class_name,
            deliverer.name AS delivered_by_name
     FROM pickup_requests
     JOIN children ON children.id = pickup_requests.child_id
     LEFT JOIN classes ON classes.id = children.class_id
     LEFT JOIN users deliverer ON deliverer.id = pickup_requests.delivered_by
     WHERE pickup_requests.status = 'delivered' AND date(pickup_requests.delivered_at) = date('now')
     ORDER BY pickup_requests.delivered_at DESC LIMIT 30`
  );
  return result.rows;
}

// Emergency contacts marked "can pick up" — shown at delivery time so
// whoever is at reception can confirm the person in front of them is
// actually authorized, without having to open the child's full profile.
async function authorizedPersons(childId) {
  const result = await db.execute({
    sql: 'SELECT name, relation, phone FROM emergency_contacts WHERE child_id = ? AND can_pickup = 1 ORDER BY id',
    args: [childId],
  });
  return result.rows;
}

router.get('/', async (req, res, next) => {
  try {
    const [pending, delivered] = await Promise.all([pendingQueue(), recentlyDelivered()]);
    const authorized = {};
    for (const p of pending) {
      // eslint-disable-next-line no-await-in-loop
      authorized[p.child_id] = await authorizedPersons(p.child_id);
    }
    res.render('pickup/queue', { title: 'طلبات الاستدعاء', pending, delivered, authorized });
  } catch (err) {
    next(err);
  }
});

// Polled every few seconds by the queue page (see public/js/pickup-poll.js)
// so multiple simultaneous requests from different parents all show up
// without anyone needing to refresh the page manually.
router.get('/queue.json', async (req, res, next) => {
  try {
    const [pending, delivered] = await Promise.all([pendingQueue(), recentlyDelivered()]);
    res.json({ pending, delivered });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/deliver', async (req, res, next) => {
  try {
    const requestResult = await db.execute({ sql: 'SELECT * FROM pickup_requests WHERE id = ?', args: [req.params.id] });
    const pr = requestResult.rows[0];
    if (!pr || pr.status !== 'pending') {
      return res.status(404).render('error', { title: 'غير موجود', message: 'هذا الطلب لم يعد قيد الانتظار (ربما تم تسليمه بالفعل من جهاز آخر).' });
    }
    const deliveredToName = (req.body.delivered_to_name || '').trim();
    if (!deliveredToName) return res.redirect('/pickup?error=name');

    await db.execute({
      sql: "UPDATE pickup_requests SET status='delivered', delivered_to_name=?, delivered_by=?, delivered_at=datetime('now') WHERE id=? AND status='pending'",
      args: [deliveredToName, req.session.user.id, pr.id],
    });

    const childResult = await db.execute({ sql: 'SELECT name, parent_id FROM children WHERE id = ?', args: [pr.child_id] });
    const child = childResult.rows[0];
    await logAudit(req.session.user, 'pickup.deliver', { entityType: 'pickup_request', entityId: pr.id, details: { child: child && child.name, deliveredToName } });

    if (child && child.parent_id) {
      await notify(child.parent_id, `تم تسليم ${child.name} ✅`, `تم تسليم طفلك إلى: ${deliveredToName}`, '/parent');
    }

    res.redirect('/pickup');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    await db.execute({ sql: "UPDATE pickup_requests SET status='cancelled' WHERE id = ? AND status='pending'", args: [req.params.id] });
    await logAudit(req.session.user, 'pickup.cancel', { entityType: 'pickup_request', entityId: req.params.id });
    res.redirect('/pickup');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
