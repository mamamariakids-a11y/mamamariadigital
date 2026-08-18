const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('driver'));

// A driver may (rarely) be assigned more than one route; the board shows
// all of the caller's routes together, grouped, for the chosen trip.
async function loadBoard(driverId, date, trip) {
  const routesResult = await db.execute({ sql: 'SELECT * FROM transport_routes WHERE driver_id = ?', args: [driverId] });
  const routes = routesResult.rows;
  if (!routes.length) return [];

  const routeIds = routes.map((r) => r.id);
  const placeholders = routeIds.map(() => '?').join(',');
  const childrenResult = await db.execute({
    sql: `SELECT transport_assignments.route_id, transport_assignments.child_id, transport_assignments.pickup_point,
                 transport_assignments.stop_order, children.name AS child_name, classes.name AS class_name,
                 transport_logs.status AS log_status, transport_logs.marked_at
          FROM transport_assignments
          JOIN children ON children.id = transport_assignments.child_id
          LEFT JOIN classes ON classes.id = children.class_id
          LEFT JOIN transport_logs ON transport_logs.child_id = transport_assignments.child_id
            AND transport_logs.log_date = ? AND transport_logs.trip = ?
          WHERE transport_assignments.route_id IN (${placeholders})
          ORDER BY transport_assignments.route_id, transport_assignments.stop_order, children.name`,
    args: [date, trip, ...routeIds],
  });

  return routes.map((route) => ({
    ...route,
    children: childrenResult.rows.filter((c) => c.route_id === route.id).map((c) => ({ ...c, status: c.log_status || 'pending' })),
  }));
}

router.get('/', async (req, res, next) => {
  try {
    const date = req.query.date && dayjs(req.query.date).isValid() ? req.query.date : dayjs().format('YYYY-MM-DD');
    const trip = ['morning', 'evening'].includes(req.query.trip) ? req.query.trip : (dayjs().hour() < 13 ? 'morning' : 'evening');
    const routes = await loadBoard(req.session.user.id, date, trip);
    res.render('driver/board', { title: 'لوحة السائق', routes, date, trip, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/mark', async (req, res, next) => {
  try {
    const { child_id, route_id, date, trip, status } = req.body;
    if (!['boarded', 'dropped', 'absent', 'pending'].includes(status)) return res.redirect('/driver');
    // Ownership check: the route must actually belong to this driver.
    const routeCheck = await db.execute({ sql: 'SELECT id FROM transport_routes WHERE id = ? AND driver_id = ?', args: [route_id, req.session.user.id] });
    if (!routeCheck.rows.length) return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الخط ليس مسندًا إليك.', user: req.session.user });

    await db.execute({
      sql: `INSERT INTO transport_logs (child_id, route_id, log_date, trip, status, marked_by, marked_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(child_id, log_date, trip) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
      args: [child_id, route_id, date, trip, status, req.session.user.id],
    });
    res.redirect(`/driver?date=${encodeURIComponent(date)}&trip=${encodeURIComponent(trip)}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
