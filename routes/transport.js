const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
// Route/assignment management is an admin & director job; the day-to-day
// boarding checklist itself lives in routes/driver.js for the 'driver' role.
router.use(requireRole('admin', 'director'));

const TRIP_LABELS = { morning: 'صباحًا فقط', evening: 'مساءً فقط', both: 'صباحًا ومساءً' };

async function loadRoutesWithCounts() {
  const result = await db.execute(`
    SELECT transport_routes.*, users.name AS driver_name,
           (SELECT COUNT(*) FROM transport_assignments WHERE transport_assignments.route_id = transport_routes.id) AS children_count
    FROM transport_routes
    LEFT JOIN users ON users.id = transport_routes.driver_id
    ORDER BY transport_routes.created_at DESC
  `);
  return result.rows;
}

async function loadDrivers() {
  const result = await db.execute("SELECT id, name FROM users WHERE role = 'driver' AND active = 1 ORDER BY name");
  return result.rows;
}

router.get('/', async (req, res, next) => {
  try {
    const [routes, drivers] = await Promise.all([loadRoutesWithCounts(), loadDrivers()]);
    res.render('admin/transport-routes', {
      title: 'النقل المدرسي',
      routes,
      drivers,
      tripLabels: TRIP_LABELS,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, driver_id, assistant_name, trip_type, notes } = req.body;
    if (!name || !name.trim()) {
      const [routes, drivers] = await Promise.all([loadRoutesWithCounts(), loadDrivers()]);
      return res.status(400).render('admin/transport-routes', {
        title: 'النقل المدرسي',
        routes,
        drivers,
        tripLabels: TRIP_LABELS,
        error: 'يرجى إدخال اسم الخط.',
      });
    }
    const finalTrip = ['morning', 'evening', 'both'].includes(trip_type) ? trip_type : 'both';
    await db.execute({
      sql: 'INSERT INTO transport_routes (name, driver_id, assistant_name, trip_type, notes) VALUES (?, ?, ?, ?, ?)',
      args: [name.trim(), driver_id || null, assistant_name || null, finalTrip, notes || null],
    });
    await logAudit(req.session.user, 'transport_route_created', { entityType: 'transport_route', details: { name: name.trim() } });
    res.redirect('/transport');
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { name, driver_id, assistant_name, trip_type, notes } = req.body;
    const finalTrip = ['morning', 'evening', 'both'].includes(trip_type) ? trip_type : 'both';
    await db.execute({
      sql: 'UPDATE transport_routes SET name = ?, driver_id = ?, assistant_name = ?, trip_type = ?, notes = ? WHERE id = ?',
      args: [name.trim(), driver_id || null, assistant_name || null, finalTrip, notes || null, req.params.id],
    });
    await logAudit(req.session.user, 'transport_route_updated', { entityType: 'transport_route', entityId: req.params.id });
    res.redirect('/transport');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM transport_routes WHERE id = ?', args: [req.params.id] });
    await logAudit(req.session.user, 'transport_route_deleted', { entityType: 'transport_route', entityId: req.params.id });
    res.redirect('/transport');
  } catch (err) {
    next(err);
  }
});

// ---------- Assign children to a route ----------
router.get('/:id/assign', async (req, res, next) => {
  try {
    const routeResult = await db.execute({ sql: 'SELECT * FROM transport_routes WHERE id = ?', args: [req.params.id] });
    const route = routeResult.rows[0];
    if (!route) return res.status(404).render('error', { title: 'غير موجود', message: 'الخط غير موجود.', user: req.session.user });

    const [assigned, unassigned] = await Promise.all([
      db.execute({
        sql: `SELECT transport_assignments.*, children.name AS child_name, classes.name AS class_name
              FROM transport_assignments
              JOIN children ON children.id = transport_assignments.child_id
              LEFT JOIN classes ON classes.id = children.class_id
              WHERE transport_assignments.route_id = ?
              ORDER BY transport_assignments.stop_order, children.name`,
        args: [req.params.id],
      }),
      db.execute({
        sql: `SELECT children.id, children.name, classes.name AS class_name
              FROM children LEFT JOIN classes ON classes.id = children.class_id
              WHERE children.id NOT IN (SELECT child_id FROM transport_assignments)
              ORDER BY children.name`,
      }),
    ]);

    res.render('admin/transport-assign', {
      title: `تعيين أطفال — ${route.name}`,
      route,
      assigned: assigned.rows,
      unassigned: unassigned.rows,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/assign', async (req, res, next) => {
  try {
    const { child_id, pickup_point } = req.body;
    if (!child_id) return res.redirect(`/transport/${req.params.id}/assign`);
    const maxOrder = await db.execute({ sql: 'SELECT COALESCE(MAX(stop_order), -1) AS m FROM transport_assignments WHERE route_id = ?', args: [req.params.id] });
    const nextOrder = Number(maxOrder.rows[0].m) + 1;
    await db.execute({
      sql: `INSERT INTO transport_assignments (child_id, route_id, pickup_point, stop_order) VALUES (?, ?, ?, ?)
            ON CONFLICT(child_id) DO UPDATE SET route_id = excluded.route_id, pickup_point = excluded.pickup_point`,
      args: [child_id, req.params.id, pickup_point || null, nextOrder],
    });
    res.redirect(`/transport/${req.params.id}/assign`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/unassign/:childId', async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM transport_assignments WHERE route_id = ? AND child_id = ?', args: [req.params.id, req.params.childId] });
    res.redirect(`/transport/${req.params.id}/assign`);
  } catch (err) {
    next(err);
  }
});

// ---------- Read-only log history for admin/director ----------
router.get('/:id/logs', async (req, res, next) => {
  try {
    const date = req.query.date && dayjs(req.query.date).isValid() ? req.query.date : dayjs().format('YYYY-MM-DD');
    const [routeResult, logs] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM transport_routes WHERE id = ?', args: [req.params.id] }),
      db.execute({
        sql: `SELECT transport_logs.*, children.name AS child_name
              FROM transport_logs JOIN children ON children.id = transport_logs.child_id
              WHERE transport_logs.route_id = ? AND transport_logs.log_date = ?
              ORDER BY children.name`,
        args: [req.params.id, date],
      }),
    ]);
    const route = routeResult.rows[0];
    if (!route) return res.status(404).render('error', { title: 'غير موجود', message: 'الخط غير موجود.', user: req.session.user });
    res.render('admin/transport-logs', { title: `سجل النقل — ${route.name}`, route, logs: logs.rows, date });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
