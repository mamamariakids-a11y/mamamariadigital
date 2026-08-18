function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'غير مصرح',
        message: 'ليس لديك صلاحية للوصول إلى هذه الصفحة.',
        user: req.session.user,
      });
    }
    next();
  };
}

// Financial access is a permission independent of role (per spec: Admin =
// full; Accountant = income+expenses+reports; Secretary = record payment +
// issue receipt only; Educator/Driver = none by default), not something
// `requireRole` can express. Admins always pass (implicit 'full'). Reads
// finance_permission fresh from the database on every request (rather than
// trusting the session, which is only populated at login) so a permission
// grant/revoke from the settings page takes effect immediately, without
// forcing the affected user to log out and back in.
function requireFinance(...allowedLevels) {
  return async (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role === 'admin') return next();
    try {
      const db = require('../db');
      const result = await db.execute({ sql: 'SELECT finance_permission FROM users WHERE id = ?', args: [req.session.user.id] });
      const level = result.rows[0] && result.rows[0].finance_permission;
      if (!level || (allowedLevels.length && !allowedLevels.includes(level))) {
        return res.status(403).render('error', {
          title: 'غير مصرح',
          message: 'ليس لديك صلاحية مالية للوصول إلى هذه الصفحة.',
          user: req.session.user,
        });
      }
      req.financeLevel = level;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Makes the logged-in user + unread notification count available to every view
function attachUser(db) {
  return async (req, res, next) => {
    try {
      res.locals.user = req.session.user || null;
      res.locals.currentPath = req.path;
      res.locals.financePermission = null;
      res.locals.parentFinanceVisible = false;
      if (req.session.user) {
        const result = await db.execute({
          sql: 'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0',
          args: [req.session.user.id],
        });
        res.locals.unreadCount = Number(result.rows[0].c);

        // Cheap enough to compute on every request (single row / single
        // indexed lookup) and it's what lets the sidebar show the "المالية"
        // link only to users who actually have finance access right now —
        // consistent with requireFinance() re-checking the database instead
        // of trusting the (login-time) session.
        if (req.session.user.role === 'admin') {
          res.locals.financePermission = 'full';
        } else {
          const permResult = await db.execute({ sql: 'SELECT finance_permission FROM users WHERE id = ?', args: [req.session.user.id] });
          res.locals.financePermission = (permResult.rows[0] && permResult.rows[0].finance_permission) || null;
        }
        if (req.session.user.role === 'parent') {
          const settingsResult = await db.execute('SELECT parent_finance_visible FROM financial_settings WHERE id = 1');
          res.locals.parentFinanceVisible = Boolean(settingsResult.rows[0] && settingsResult.rows[0].parent_finance_visible);
        }
      } else {
        res.locals.unreadCount = 0;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireLogin, requireRole, requireFinance, attachUser };
