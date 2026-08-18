// Seeds the database with an initial admin account, a director, sample
// classrooms, teachers, children and parents so the app is usable immediately
// after installation. Safe to call multiple times: it only seeds when the
// users table is empty. Exported as a function so it can run automatically
// on first boot (see db/index.js) as well as from the CLI (db/seed.js).
const bcrypt = require('bcryptjs');

// The full list of demo accounts. Used both by the fresh-install seed below
// AND by ensureDemoUsersExist() (see below), which adds any of these that
// are still missing on an already-running site — e.g. when a later update
// introduces a brand-new demo account (like the 'staff' one) but the site's
// database already has real data in it, so the fresh-install seed never runs
// again and that new demo account would otherwise never appear.
const DEMO_USERS = [
  { name: 'مديرة روضة ماما ماريا', email: 'mama.mariakids@gmail.com', password: 'Admin@2026', role: 'admin', phone: '0500000000', avatar_color: '#B65C9E' },
  { name: 'أ. سارة أحمد', email: 'director@mamamaria.test', password: 'Director@123', role: 'director', phone: '0501111111', avatar_color: '#4A7CE0' },
  { name: 'أ. منى خالد', email: 'teacher1@mamamaria.test', password: 'Teacher@123', role: 'teacher', phone: '0502222222', avatar_color: '#3AA0A0' },
  { name: 'أ. ريم سالم', email: 'teacher2@mamamaria.test', password: 'Teacher@123', role: 'teacher', phone: '0503333333', avatar_color: '#E0A23A' },
  { name: 'ولي أمر - أحمد محمد', email: 'parent1@mamamaria.test', password: 'Parent@123', role: 'parent', phone: '0504444444', avatar_color: '#7A5CB6' },
  { name: 'إدارية الاستقبال', email: 'staff1@mamamaria.test', password: 'Staff@123', role: 'staff', phone: '0505555555', avatar_color: '#D9634F' },
  { name: 'سائق الحافلة', email: 'driver1@mamamaria.test', password: 'Driver@123', role: 'driver', phone: '0506666666', avatar_color: '#5B8DEF' },
];

// Runs on every boot (fresh install or not). Only INSERTS a demo account if
// no user with that exact email already exists — it never touches, renames,
// or overwrites any existing account (demo or real), so it's safe to run
// against a live production database on every deploy.
async function ensureDemoUsersExist(db) {
  const hash = (pwd) => bcrypt.hashSync(pwd, 10);
  for (const u of DEMO_USERS) {
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [u.email] });
    if (existing.rows.length) continue; // already there (real or demo) — leave it alone
    await db.execute({
      sql: `INSERT INTO users (name, email, password_hash, role, phone, avatar_color)
            VALUES (@name, @email, @password_hash, @role, @phone, @avatar_color)`,
      args: {
        name: u.name,
        email: u.email,
        password_hash: hash(u.password),
        role: u.role,
        phone: u.phone,
        avatar_color: u.avatar_color,
      },
    });
  }
}

async function seedIfEmpty(db) {
  const countResult = await db.execute('SELECT COUNT(*) AS c FROM users');
  const userCount = Number(countResult.rows[0].c);
  if (userCount > 0) return false;

  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  const insertUser = (u) =>
    db.execute({
      sql: `INSERT INTO users (name, email, password_hash, role, phone, avatar_color)
            VALUES (@name, @email, @password_hash, @role, @phone, @avatar_color)`,
      args: u,
    });

  await insertUser({
    name: 'مديرة روضة ماما ماريا',
    email: 'mama.mariakids@gmail.com',
    password_hash: hash('Admin@2026'),
    role: 'admin',
    phone: '0500000000',
    avatar_color: '#B65C9E',
  });

  await insertUser({
    name: 'أ. سارة أحمد',
    email: 'director@mamamaria.test',
    password_hash: hash('Director@123'),
    role: 'director',
    phone: '0501111111',
    avatar_color: '#4A7CE0',
  });

  const teacher1 = await insertUser({
    name: 'أ. منى خالد',
    email: 'teacher1@mamamaria.test',
    password_hash: hash('Teacher@123'),
    role: 'teacher',
    phone: '0502222222',
    avatar_color: '#3AA0A0',
  });

  const teacher2 = await insertUser({
    name: 'أ. ريم سالم',
    email: 'teacher2@mamamaria.test',
    password_hash: hash('Teacher@123'),
    role: 'teacher',
    phone: '0503333333',
    avatar_color: '#E0A23A',
  });

  const parent1 = await insertUser({
    name: 'ولي أمر - أحمد محمد',
    email: 'parent1@mamamaria.test',
    password_hash: hash('Parent@123'),
    role: 'parent',
    phone: '0504444444',
    avatar_color: '#7A5CB6',
  });

  await insertUser({
    name: 'إدارية الاستقبال',
    email: 'staff1@mamamaria.test',
    password_hash: hash('Staff@123'),
    role: 'staff',
    phone: '0505555555',
    avatar_color: '#D9634F',
  });

  const driver1 = await insertUser({
    name: 'سائق الحافلة',
    email: 'driver1@mamamaria.test',
    password_hash: hash('Driver@123'),
    role: 'driver',
    phone: '0506666666',
    avatar_color: '#5B8DEF',
  });

  const insertClass = (c) =>
    db.execute({
      sql: `INSERT INTO classes (name, age_range, teacher_id, color) VALUES (@name, @age_range, @teacher_id, @color)`,
      args: c,
    });

  const classA = await insertClass({
    name: 'فصل البراعم',
    age_range: '3-4 سنوات',
    teacher_id: Number(teacher1.lastInsertRowid),
    color: '#3AA0A0',
  });

  const classB = await insertClass({
    name: 'فصل الفراشات',
    age_range: '4-5 سنوات',
    teacher_id: Number(teacher2.lastInsertRowid),
    color: '#E0A23A',
  });

  const insertChild = (c) =>
    db.execute({
      sql: `INSERT INTO children (name, class_id, parent_id) VALUES (@name, @class_id, @parent_id)`,
      args: c,
    });

  const child1 = await insertChild({ name: 'يوسف أحمد', class_id: Number(classA.lastInsertRowid), parent_id: Number(parent1.lastInsertRowid) });
  await insertChild({ name: 'لجين سالم', class_id: Number(classB.lastInsertRowid), parent_id: null });

  // A demo transport route so the النقل المدرسي module isn't empty on first look.
  const route1 = await db.execute({
    sql: `INSERT INTO transport_routes (name, driver_id, trip_type) VALUES (?, ?, 'both')`,
    args: ['خط حي النصر', Number(driver1.lastInsertRowid)],
  });
  await db.execute({
    sql: `INSERT INTO transport_assignments (child_id, route_id, pickup_point, stop_order) VALUES (?, ?, ?, 0)`,
    args: [Number(child1.lastInsertRowid), Number(route1.lastInsertRowid), 'أمام المسجد الكبير'],
  });

  return true;
}

module.exports = { seedIfEmpty, ensureDemoUsersExist };
