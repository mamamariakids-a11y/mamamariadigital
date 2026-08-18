const path = require('path');
const express = require('express');
const session = require('express-session');

const db = require('./db');
const { attachUser } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions are kept in memory (not persisted to disk/DB). That means a
// restart logs everyone out, which is a minor inconvenience — but it keeps
// the app fully stateless on the host's own filesystem, which is what lets
// it run on a free web service tier (see db/index.js for how the actual
// lesson/activity data stays safe on Turso regardless of restarts).
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'mamamaria-kindergarten-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
      httpOnly: true,
      secure: isProd,
    },
  })
);

app.use(attachUser(db));

app.locals.dayjs = require('dayjs');
const arLocale = require('dayjs/locale/ar');
// Kindergarten director asked for August specifically to read "أوت" (the
// colloquial Algerian name), while every other month keeps its standard
// Modern Standard Arabic name. dayjs.locale(name, obj) REPLACES the whole
// locale definition rather than merging it — so we spread the full base
// 'ar' locale (weekdays, formats, etc.) and only override months/monthsShort,
// instead of switching to the full ar-dz locale (which renames all twelve
// months to their French-derived forms).
const monthsWithAout = 'يناير_فبراير_مارس_أبريل_مايو_يونيو_يوليو_أوت_سبتمبر_أكتوبر_نوفمبر_ديسمبر'.split('_');
app.locals.dayjs.locale('ar', { ...arLocale, months: monthsWithAout, monthsShort: monthsWithAout });
app.locals.dayjs.locale('ar');

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const roleHome = {
    admin: '/admin',
    director: '/director',
    teacher: '/teacher',
    parent: '/parent',
    staff: '/staff',
  };
  res.redirect(roleHome[req.session.user.role] || '/login');
});

app.use('/', require('./routes/auth'));
app.use('/account', require('./routes/account'));
app.use('/notifications', require('./routes/notifications'));
app.use('/director', require('./routes/director'));
app.use('/teacher', require('./routes/teacher'));
app.use('/admin', require('./routes/admin'));
app.use('/parent', require('./routes/parent'));
app.use('/staff', require('./routes/staff'));
app.use('/events', require('./routes/events'));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'الصفحة غير موجودة',
    message: 'عذرًا، الصفحة التي تبحث عنها غير موجودة.',
    user: req.session.user,
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'حدث خطأ',
    message: err.message || 'حدث خطأ غير متوقع، يرجى المحاولة لاحقًا.',
    user: req.session.user,
  });
});

// Wait for the schema to be created (and, on first boot, the demo data
// seeded) before accepting requests.
db.ready.then(() => {
  app.listen(PORT, () => {
    console.log(`🌱 روضة ماما ماريا تعمل الآن على المنفذ ${PORT}`);
  });
}).catch((err) => {
  console.error('فشل الاتصال بقاعدة البيانات عند بدء التشغيل:', err);
  process.exit(1);
});
