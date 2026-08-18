const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin', 'director'));

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.render('search/results', { title: 'البحث الشامل', q: '', children: [], users: [] });
    }
    const like = `%${q}%`;
    const [children, users] = await Promise.all([
      db.execute({
        sql: `SELECT children.id, children.name, classes.name AS class_name, parent.name AS parent_name
              FROM children
              LEFT JOIN classes ON classes.id = children.class_id
              LEFT JOIN users parent ON parent.id = children.parent_id
              WHERE children.name LIKE ? ORDER BY children.name LIMIT 30`,
        args: [like],
      }),
      db.execute({
        sql: `SELECT id, name, email, role, phone FROM users
              WHERE (name LIKE ? OR email LIKE ? OR phone LIKE ?) ORDER BY role, name LIMIT 30`,
        args: [like, like, like],
      }),
    ]);
    res.render('search/results', { title: 'البحث الشامل', q, children: children.rows, users: users.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
