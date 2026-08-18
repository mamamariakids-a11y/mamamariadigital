const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

router.get('/change-password', (req, res) => {
  res.render('account/change-password', { title: 'تغيير كلمة المرور', error: null, success: null });
});

router.post('/change-password', async (req, res, next) => {
 try {
  const { current_password, new_password, confirm_password } = req.body;
  const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.session.user.id] });
  const user = result.rows[0];

  if (!current_password || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).render('account/change-password', {
      title: 'تغيير كلمة المرور',
      error: 'كلمة المرور الحالية غير صحيحة.',
      success: null,
    });
  }
  if (!new_password || new_password.length < 6) {
    return res.status(400).render('account/change-password', {
      title: 'تغيير كلمة المرور',
      error: 'يجب أن تتكون كلمة المرور الجديدة من 6 أحرف على الأقل.',
      success: null,
    });
  }
  if (new_password !== confirm_password) {
    return res.status(400).render('account/change-password', {
      title: 'تغيير كلمة المرور',
      error: 'كلمة المرور الجديدة وتأكيدها غير متطابقين.',
      success: null,
    });
  }

  await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [bcrypt.hashSync(new_password, 10), user.id] });
  res.render('account/change-password', { title: 'تغيير كلمة المرور', error: null, success: 'تم تغيير كلمة المرور بنجاح.' });
 } catch (err) {
   next(err);
 }
});

module.exports = router;
