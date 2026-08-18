const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { notifyMany } = require('../utils/notify');

const router = express.Router();
router.use(requireLogin);

// General kindergarten-wide events (holidays, trips, meetings, celebrations)
// — visible in a shared calendar to EVERY role (unlike the lessons/activities
// calendar under /director, which is staff-only). Only admin/director can
// add or remove events; everyone else has read-only access.
const CATEGORY_LABELS = {
  holiday: '🏖️ عطلة/إجازة',
  trip: '🚌 رحلة',
  meeting: '🤝 اجتماع أولياء أمور',
  celebration: '🎉 احتفال/مناسبة',
  other: '📌 أخرى',
};

function canManage(req) {
  return ['admin', 'director'].includes(req.session.user.role);
}

async function eventsInRange(start, end) {
  const result = await db.execute({
    sql: `SELECT events.*, users.name AS created_by_name
          FROM events LEFT JOIN users ON users.id = events.created_by
          WHERE event_date BETWEEN ? AND ?
          ORDER BY event_date ASC, events.id ASC`,
    args: [start, end],
  });
  return result.rows;
}

async function buildCalendarView(req) {
  const view = req.query.view === 'week' ? 'week' : 'month';
  const anchor = req.query.date && dayjs(req.query.date).isValid() ? dayjs(req.query.date) : dayjs();

  const start = view === 'month' ? anchor.startOf('month').startOf('week') : anchor.startOf('week');
  const end = view === 'month' ? anchor.endOf('month').endOf('week') : anchor.endOf('week');

  const events = await eventsInRange(start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD'));

  const days = [];
  let cursor = start.clone();
  while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
    const dateStr = cursor.format('YYYY-MM-DD');
    days.push({
      date: dateStr,
      label: cursor.format('dddd'),
      dayNum: cursor.format('D'),
      isToday: cursor.isSame(dayjs(), 'day'),
      inMonth: cursor.isSame(anchor, 'month'),
      events: events.filter((e) => e.event_date === dateStr),
    });
    cursor = cursor.add(1, 'day');
  }

  return {
    view,
    anchor: anchor.format('YYYY-MM-DD'),
    monthLabel: anchor.format('MMMM YYYY'),
    prevDate: (view === 'month' ? anchor.subtract(1, 'month') : anchor.subtract(1, 'week')).format('YYYY-MM-DD'),
    nextDate: (view === 'month' ? anchor.add(1, 'month') : anchor.add(1, 'week')).format('YYYY-MM-DD'),
    days,
    categoryLabels: CATEGORY_LABELS,
    canManage: canManage(req),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const calendarData = await buildCalendarView(req);
    res.render('events/calendar', {
      title: 'الفعاليات العامة',
      ...calendarData,
      error: req.query.error === '1' ? 'يرجى كتابة عنوان الفعالية واختيار تاريخ صحيح.' : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    if (!canManage(req)) {
      return res.status(403).render('error', {
        title: 'غير مصرح',
        message: 'ليس لديك صلاحية لإضافة فعاليات.',
      });
    }

    const { title, description, event_date, category } = req.body;
    if (!title || !title.trim() || !event_date || !dayjs(event_date).isValid()) {
      return res.redirect(`/events?error=1&date=${encodeURIComponent(event_date || '')}`);
    }

    const finalCategory = Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category) ? category : 'other';

    await db.execute({
      sql: `INSERT INTO events (title, description, event_date, category, created_by)
            VALUES (?, ?, ?, ?, ?)`,
      args: [title.trim(), (description || '').trim() || null, event_date, finalCategory, req.session.user.id],
    });

    const allUsers = await db.execute('SELECT id FROM users WHERE active = 1');
    await notifyMany(
      allUsers.rows.map((r) => r.id),
      `فعالية جديدة: ${title.trim()}`,
      `بتاريخ ${dayjs(event_date).format('YYYY-MM-DD')}${description ? ' — ' + description.trim() : ''}`,
      '/events'
    );

    res.redirect(`/events?date=${event_date}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    if (!canManage(req)) {
      return res.status(403).render('error', {
        title: 'غير مصرح',
        message: 'ليس لديك صلاحية لحذف الفعاليات.',
      });
    }
    await db.execute({ sql: 'DELETE FROM events WHERE id = ?', args: [req.params.id] });
    res.redirect('/events' + (req.query.date ? `?date=${req.query.date}` : ''));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
