const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

const ROLE_HOME = {
  admin: '/admin',
  director: '/director',
  teacher: '/teacher',
  parent: '/parent',
  staff: '/staff',
  driver: '/driver',
};

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(ROLE_HOME[req.session.user.role]);
  res.render('auth/login', { error: null, layout: false });
});

router.post('/login', async (req, res, next) => {
  try {
  const { email, password } = req.body;
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ? AND active = 1',
    args: [(email || '').trim().toLowerCase()],
  });
  const user = result.rows[0];

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).render('auth/login', {
      error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
      layout: false,
    });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar_color: user.avatar_color,
  };

  res.redirect(ROLE_HOME[user.role] || '/');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
