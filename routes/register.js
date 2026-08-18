const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ---------- Public self-service registration ----------
// Deliberately does NOT create a usable account immediately: the password
// is hashed and stored on a `registration_requests` row, and only becomes
// a real, loginable `users` row once an admin reviews and approves it.
router.get('/register', (req, res) => {
  res.render('auth/register', { error: null, success: null, layout: false });
});

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, phone, child_name, notes } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!name || !name.trim() || !cleanEmail || !password || password.length < 6) {
      return res.status(400).render('auth/register', {
        error: 'يرجى تعبئة الاسم، بريد إلكتروني صالح، وكلمة مرور من 6 أحرف على الأقل.',
        success: null,
        layout: false,
      });
    }

    const existingUser = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [cleanEmail] });
    const existingRequest = await db.execute({ sql: "SELECT id FROM registration_requests WHERE email = ? AND status = 'pending'", args: [cleanEmail] });
    if (existingUser.rows.length || existingRequest.rows.length) {
      return res.status(400).render('auth/register', {
        error: 'هذا البريد الإلكتروني مسجّل بالفعل أو بانتظار المراجعة.',
        success: null,
        layout: false,
      });
    }

    await db.execute({
      sql: `INSERT INTO registration_requests (name, email, password_hash, phone, child_name, notes)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [name.trim(), cleanEmail, bcrypt.hashSync(password, 10), phone || null, child_name || null, notes || null],
    });

    const admins = await db.execute("SELECT id FROM users WHERE role IN ('admin','director') AND active = 1");
    for (const a of admins.rows) {
      // eslint-disable-next-line no-await-in-loop
      await notify(a.id, 'طلب تسجيل جديد', `${name.trim()} تقدّم بطلب حساب ولي أمر جديد`, '/admin/registration-requests');
    }

    res.render('auth/register', { error: null, success: 'تم إرسال طلبك بنجاح. سيتم مراجعته من قبل الإدارة وسيتم إعلامك عند التفعيل.', layout: false });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin review ----------
router.get('/admin/registration-requests', requireRole('admin', 'director'), async (req, res, next) => {
  try {
    const [pending, reviewed, classes] = await Promise.all([
      db.execute("SELECT * FROM registration_requests WHERE status = 'pending' ORDER BY created_at ASC"),
      db.execute("SELECT * FROM registration_requests WHERE status != 'pending' ORDER BY reviewed_at DESC LIMIT 30"),
      db.execute('SELECT id, name FROM classes ORDER BY name'),
    ]);
    res.render('admin/registration-requests', {
      title: 'طلبات التسجيل الذاتي',
      pending: pending.rows,
      reviewed: reviewed.rows,
      classes: classes.rows,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/registration-requests/:id/approve', requireRole('admin', 'director'), async (req, res, next) => {
  try {
    const reqRow = await db.execute({ sql: "SELECT * FROM registration_requests WHERE id = ? AND status = 'pending'", args: [req.params.id] });
    const request = reqRow.rows[0];
    if (!request) return res.redirect('/admin/registration-requests');

    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [request.email] });
    if (existing.rows.length) {
      // Email got taken by another account after the request was submitted — reject instead of silently failing.
      await db.execute({
        sql: "UPDATE registration_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), reject_reason = ? WHERE id = ?",
        args: [req.session.user.id, 'البريد الإلكتروني مستخدم بالفعل في حساب آخر', req.params.id],
      });
      return res.redirect('/admin/registration-requests');
    }

    const userResult = await db.execute({
      sql: `INSERT INTO users (name, email, password_hash, role, phone, avatar_color)
            VALUES (?, ?, ?, 'parent', ?, ?)`,
      args: [request.name, request.email, request.password_hash, request.phone, '#5B8DEF'],
    });
    const newUserId = Number(userResult.lastInsertRowid);

    if (request.child_name && request.child_name.trim()) {
      const classId = req.body.class_id || null;
      await db.execute({
        sql: 'INSERT INTO children (name, class_id, parent_id) VALUES (?, ?, ?)',
        args: [request.child_name.trim(), classId, newUserId],
      });
    }

    await db.execute({
      sql: "UPDATE registration_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      args: [req.session.user.id, req.params.id],
    });
    await logAudit(req.session.user, 'registration_request_approved', { entityType: 'registration_request', entityId: req.params.id, details: { email: request.email } });
    await notify(newUserId, 'تم تفعيل حسابك', 'مرحبًا بك في نظام روضة ماما ماريا! يمكنك الآن تسجيل الدخول.', '/login');

    res.redirect('/admin/registration-requests');
  } catch (err) {
    next(err);
  }
});

router.post('/admin/registration-requests/:id/reject', requireRole('admin', 'director'), async (req, res, next) => {
  try {
    await db.execute({
      sql: "UPDATE registration_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), reject_reason = ? WHERE id = ? AND status = 'pending'",
      args: [req.session.user.id, req.body.reject_reason || null, req.params.id],
    });
    await logAudit(req.session.user, 'registration_request_rejected', { entityType: 'registration_request', entityId: req.params.id });
    res.redirect('/admin/registration-requests');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
