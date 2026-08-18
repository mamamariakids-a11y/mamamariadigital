const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const { seedIfEmpty, ensureDemoUsersExist } = require('./seed-data');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Two ways to run this app, using the exact same code:
//
// 1) Locally / no setup: leave TURSO_DATABASE_URL unset and the app stores
//    everything in a local file (db/mamamaria.db) — nothing to configure.
// 2) Deployed (e.g. on Render's free tier): set TURSO_DATABASE_URL and
//    TURSO_AUTH_TOKEN to a free https://turso.tech database. This makes the
//    data persist reliably even though the host's own filesystem is wiped
//    on every restart/redeploy — no paid disk needed.
const LOCAL_DB_PATH = path.join(__dirname, 'mamamaria.db');
const url = process.env.TURSO_DATABASE_URL || `file:${LOCAL_DB_PATH}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const db = createClient({ url, authToken });

// SQLite (and libSQL) cannot ALTER a CHECK constraint in place. When a new
// role is added to the app (e.g. 'staff'), an already-deployed database still
// has the old, narrower constraint baked into its `users` table and would
// reject inserting that role with a CHECK-constraint error. This rebuilds
// the table with the up-to-date constraint, preserving every existing row,
// and only runs when needed (a fresh install already gets the new
// constraint straight from schema.sql, so this is a no-op there).
async function migrateUsersRoleCheck() {
  const existing = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
  if (!existing.rows.length) return; // fresh install — schema.sql below creates it correctly
  const currentSql = String(existing.rows[0].sql || '');
  if (currentSql.includes("'staff'") && currentSql.includes("'driver'")) return; // already up to date

  try {
    await db.execute('PRAGMA foreign_keys = OFF');
  } catch (e) {
    // ignore if unsupported
  }
  await db.execute(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','director','teacher','parent','staff','driver')),
      phone TEXT,
      avatar_color TEXT DEFAULT '#5B8DEF',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    INSERT INTO users_new (id, name, email, password_hash, role, phone, avatar_color, active, created_at)
    SELECT id, name, email, password_hash, role, phone, avatar_color, active, created_at FROM users
  `);
  await db.execute('DROP TABLE users');
  await db.execute('ALTER TABLE users_new RENAME TO users');
  try {
    await db.execute('PRAGMA foreign_keys = ON');
  } catch (e) {
    // ignore if unsupported
  }
}

// Adds the optional note_time column to an already-existing parent_notes
// table (used for the "sound alert as note time approaches" feature).
// Unlike the CHECK-constraint change above, adding a plain nullable column
// is natively supported by SQLite/libSQL via ALTER TABLE ... ADD COLUMN, so
// no table rebuild is needed here — just a guarded, idempotent add.
async function migrateParentNotesAddTime() {
  const existing = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='parent_notes'");
  if (!existing.rows.length) return; // table doesn't exist yet — schema.sql below creates it with note_time already
  const cols = await db.execute('PRAGMA table_info(parent_notes)');
  const hasTime = cols.rows.some((r) => r.name === 'note_time');
  if (hasTime) return; // already up to date
  await db.execute('ALTER TABLE parent_notes ADD COLUMN note_time TEXT');
}

// Adds a plain nullable column to an already-existing table if it's missing.
// Safe/idempotent — used for every Phase 2 column addition (qr_token,
// finance_permission...) since none of them need a CHECK constraint (which
// would require the full table-rebuild dance used in migrateUsersRoleCheck).
async function migrateAddColumn(table, column, ddlType) {
  const existing = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    args: [table],
  });
  if (!existing.rows.length) return; // table doesn't exist yet — schema.sql creates it correctly
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  if (cols.rows.some((r) => r.name === column)) return; // already up to date
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
}

// Every child needs a permanent, unique QR token (used for the printable ID
// card and for QR-based check-in/search). Existing children created before
// this feature shipped get one generated here, once.
function generateQrToken() {
  return 'MMD-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
async function backfillQrTokens() {
  const missing = await db.execute("SELECT id FROM children WHERE qr_token IS NULL OR qr_token = ''");
  for (const row of missing.rows) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute({ sql: 'UPDATE children SET qr_token = ? WHERE id = ?', args: [generateQrToken(), row.id] });
  }
}

// Ensures the single financial_settings row (id=1) exists with sane
// defaults, and that the standard expense category list exists — both are
// safe to call on every boot (INSERT OR IGNORE / ON CONFLICT DO NOTHING).
async function ensureFinancialDefaults() {
  await db.execute(`
    INSERT INTO financial_settings (id, registration_fee_default, due_day, grace_period_days, currency, receipt_prefix, sibling_discount_2nd, sibling_discount_3rd, parent_finance_visible, cashbox_opening_balance)
    VALUES (1, 0, 5, 5, 'دج', 'MM', 0, 0, 0, 0)
    ON CONFLICT(id) DO NOTHING
  `);
  const defaultCategories = ['طعام', 'نظافة', 'مستلزمات تربوية', 'صيانة', 'كهرباء وماء', 'إنترنت واتصالات', 'وقود ونقل', 'تجهيزات', 'مصاريف إدارية', 'أخرى'];
  for (const name of defaultCategories) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute({ sql: 'INSERT INTO expense_categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING', args: [name] });
  }
}

async function init() {
  await migrateUsersRoleCheck();
  await migrateParentNotesAddTime();
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await db.executeMultiple(schema);
  try {
    await db.execute('PRAGMA foreign_keys = ON');
  } catch (e) {
    // Not critical if the underlying engine ignores this pragma.
  }
  try {
    // WAL lets reads proceed concurrently with the write transactions used
    // by the atomic payment-recording flow (see utils/finance.js), and is
    // what makes the busy-retry wrapper there converge quickly instead of
    // constantly colliding. Ignored gracefully if the host doesn't support it.
    await db.execute('PRAGMA journal_mode = WAL');
  } catch (e) {
    // ignore — remote Turso connections manage this server-side regardless.
  }

  await migrateAddColumn('children', 'qr_token', 'TEXT');
  await migrateAddColumn('users', 'finance_permission', 'TEXT');
  await backfillQrTokens();
  await ensureFinancialDefaults();

  const didSeed = await seedIfEmpty(db);
  if (didSeed) {
    console.log('تمت تعبئة قاعدة البيانات ببيانات أولية تلقائيًا (أول تشغيل).');
  } else {
    // Site already has real data — still make sure any demo accounts added
    // in a later update (e.g. staff1@mamamaria.test) exist, without
    // touching any existing (real or demo) account.
    await ensureDemoUsersExist(db);
  }
  // Runs again after seeding so demo children created just above (which
  // don't set qr_token themselves) get one immediately instead of waiting
  // for a second boot.
  await backfillQrTokens();
}

// Exposed so app.js/db/seed.js can wait for schema+seed before serving requests.
db.ready = init();

module.exports = db;
