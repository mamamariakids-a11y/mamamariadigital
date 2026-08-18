const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// Every child's printable QR card encodes a link to /q/<token> — scanning it
// with any phone camera (no in-app scanner needed) opens this route, which
// sends the logged-in staff member straight to the page most useful to
// them for that child, without exposing the raw child id or requiring a
// manual search. An unauthenticated scan just lands on the login page.
router.get('/:token', requireLogin, async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM children WHERE qr_token = ?', args: [req.params.token] });
    const child = result.rows[0];
    if (!child) return res.status(404).render('error', { title: 'غير موجود', message: 'رمز QR هذا غير صالح.' });

    const role = req.session.user.role;
    if (role === 'admin') return res.redirect(`/admin/children/${child.id}`);
    if (role === 'parent') {
      if (child.parent_id !== req.session.user.id) {
        return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس مرتبطًا بحسابك.' });
      }
      return res.redirect(`/parent/children/${child.id}`);
    }
    if (role === 'teacher') {
      const classResult = await db.execute({ sql: 'SELECT id FROM classes WHERE teacher_id = ? AND id = ?', args: [req.session.user.id, child.class_id] });
      if (!classResult.rows.length) {
        return res.status(403).render('error', { title: 'غير مصرح', message: 'هذا الطفل ليس في فصلك.' });
      }
      return res.redirect(`/teacher/children/${child.id}/health`);
    }
    // director / staff: no per-child profile page of their own — the pickup
    // queue is the most relevant screen when a card is scanned in person.
    return res.redirect('/pickup');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
