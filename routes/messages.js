const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');

const router = express.Router();
router.use(requireRole('teacher', 'parent', 'admin', 'director'));

// Returns the list of children this logged-in user is allowed to message
// about: a parent sees their own children; a teacher sees the children in
// classes they teach; admin/director (oversight) see every child.
async function accessibleChildren(user) {
  if (user.role === 'parent') {
    const r = await db.execute({ sql: 'SELECT children.id, children.name FROM children WHERE parent_id = ? ORDER BY children.name', args: [user.id] });
    return r.rows;
  }
  if (user.role === 'teacher') {
    const r = await db.execute({
      sql: `SELECT children.id, children.name FROM children
            JOIN classes ON classes.id = children.class_id
            WHERE classes.teacher_id = ? ORDER BY children.name`,
      args: [user.id],
    });
    return r.rows;
  }
  const r = await db.execute('SELECT id, name FROM children ORDER BY name');
  return r.rows;
}

async function canAccessChild(user, childId) {
  const children = await accessibleChildren(user);
  return children.some((c) => c.id === Number(childId));
}

// Who should be notified about a new message on this child's thread — the
// other party (or parties) in the conversation, never the sender.
async function otherPartyIds(childId, excludeUserId) {
  const result = await db.execute({
    sql: `SELECT children.parent_id, classes.teacher_id
          FROM children LEFT JOIN classes ON classes.id = children.class_id
          WHERE children.id = ?`,
    args: [childId],
  });
  const row = result.rows[0];
  if (!row) return [];
  return [row.parent_id, row.teacher_id].filter((id) => id && id !== excludeUserId);
}

router.get('/', async (req, res, next) => {
  try {
    const children = await accessibleChildren(req.session.user);
    const withUnread = await Promise.all(
      children.map(async (c) => {
        const unread = await db.execute({
          sql: 'SELECT COUNT(*) AS n FROM messages WHERE child_id = ? AND sender_id != ? AND read_at IS NULL',
          args: [c.id, req.session.user.id],
        });
        const last = await db.execute({ sql: 'SELECT body, created_at FROM messages WHERE child_id = ? ORDER BY created_at DESC LIMIT 1', args: [c.id] });
        return { ...c, unread: Number(unread.rows[0].n), lastMessage: last.rows[0] || null };
      })
    );
    res.render('messages/inbox', { title: 'المراسلة', children: withUnread });
  } catch (err) {
    next(err);
  }
});

router.get('/:childId', async (req, res, next) => {
  try {
    if (!(await canAccessChild(req.session.user, req.params.childId))) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك الوصول إلى هذه المحادثة.', user: req.session.user });
    }
    const childResult = await db.execute({ sql: 'SELECT id, name FROM children WHERE id = ?', args: [req.params.childId] });
    const child = childResult.rows[0];
    if (!child) return res.status(404).render('error', { title: 'غير موجود', message: 'الطفل غير موجود.', user: req.session.user });

    const messages = await db.execute({
      sql: `SELECT messages.*, users.name AS sender_name FROM messages
            JOIN users ON users.id = messages.sender_id
            WHERE messages.child_id = ? ORDER BY messages.created_at ASC`,
      args: [req.params.childId],
    });

    await db.execute({
      sql: 'UPDATE messages SET read_at = datetime(\'now\') WHERE child_id = ? AND sender_id != ? AND read_at IS NULL',
      args: [req.params.childId, req.session.user.id],
    });

    res.render('messages/thread', { title: `المراسلة — ${child.name}`, child, messages: messages.rows, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/:childId', async (req, res, next) => {
  try {
    if (!(await canAccessChild(req.session.user, req.params.childId))) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'لا يمكنك الوصول إلى هذه المحادثة.', user: req.session.user });
    }
    const body = (req.body.body || '').trim();
    if (!body) return res.redirect(`/messages/${req.params.childId}`);

    await db.execute({
      sql: 'INSERT INTO messages (child_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?)',
      args: [req.params.childId, req.session.user.id, req.session.user.role, body],
    });

    const childResult = await db.execute({ sql: 'SELECT name FROM children WHERE id = ?', args: [req.params.childId] });
    const childName = childResult.rows[0] ? childResult.rows[0].name : '';
    const recipients = await otherPartyIds(req.params.childId, req.session.user.id);
    for (const uid of recipients) {
      // eslint-disable-next-line no-await-in-loop
      await notify(uid, `رسالة جديدة بخصوص ${childName}`, body, `/messages/${req.params.childId}`);
    }

    res.redirect(`/messages/${req.params.childId}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
