const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireLogin, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
      args: [req.session.user.id],
    });
    await db.execute({ sql: 'UPDATE notifications SET is_read = 1 WHERE user_id = ?', args: [req.session.user.id] });
    res.render('notifications', { items: result.rows, title: 'الإشعارات' });
  } catch (err) {
    next(err);
  }
});

// Lightweight polling endpoint used by the bell icon
router.get('/unread-count', requireLogin, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0',
      args: [req.session.user.id],
    });
    res.json({ count: Number(result.rows[0].c) });
  } catch (err) {
    next(err);
  }
});

router.get('/recent', requireLogin, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 8',
      args: [req.session.user.id],
    });
    res.json({ items: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', requireLogin, async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE notifications SET is_read = 1 WHERE user_id = ?', args: [req.session.user.id] });
    res.redirect(req.get('Referrer') || '/notifications');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
