-- Mama Maria Kindergarten Management System - Database Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','director','teacher','parent','staff','driver')),
  phone TEXT,
  avatar_color TEXT DEFAULT '#5B8DEF',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  age_range TEXT,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  color TEXT DEFAULT '#5B8DEF',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lessons & activities created by the education director
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('lesson','activity')),
  title TEXT NOT NULL,
  description TEXT,
  objective TEXT,
  materials TEXT,
  scheduled_date TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important','urgent')),
  attachments TEXT DEFAULT '[]',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (item, class) assignment -> tracks each class/teacher's status
CREATE TABLE IF NOT EXISTS item_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','executed')),
  received_at TEXT,
  received_by INTEGER REFERENCES users(id),
  executed_at TEXT,
  executed_by INTEGER REFERENCES users(id),
  execution_notes TEXT,
  execution_photos TEXT DEFAULT '[]',
  UNIQUE(item_id, class_id)
);

-- Daily attendance: one row per (child, date), recorded by the teacher
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent')),
  marked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(child_id, date)
);

-- Notes/instructions from parents (relayed by front-desk staff) about a child:
-- e.g. "give medicine at noon", "allergic to nuts", "leaves by the school bus
-- today". 'daily' notes only matter on their note_date; 'permanent' notes stay
-- visible until archived (e.g. a standing allergy).
CREATE TABLE IF NOT EXISTS parent_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  note_type TEXT NOT NULL CHECK (note_type IN ('daily','permanent')),
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('health','food','transport','other')),
  content TEXT NOT NULL,
  note_date TEXT,
  note_time TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  created_by INTEGER REFERENCES users(id),
  done_by INTEGER REFERENCES users(id),
  done_at TEXT,
  done_note TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- General kindergarten-wide events (holidays, trips, parent meetings,
-- celebrations...) visible to every role, unlike `items` which are
-- lessons/activities scoped to specific classes and only managed/seen by
-- staff roles.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  event_date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('holiday','trip','meeting','celebration','other')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily per-child report filled by the teacher: meals, nap, mood, bathroom —
-- visible to the parent, one row per child per day.
CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meal_status TEXT CHECK (meal_status IN ('all','some','none')),
  nap_status TEXT CHECK (nap_status IN ('yes','no')),
  nap_minutes INTEGER,
  mood TEXT CHECK (mood IN ('happy','normal','tired','upset')),
  bathroom_count INTEGER,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(child_id, date)
);

-- Permanent health profile per child (blood type, allergies, chronic
-- conditions, medications, doctor info). Editable by admin/director/staff
-- and by the child's own parent; read-only for the child's teacher.
CREATE TABLE IF NOT EXISTS health_profiles (
  child_id INTEGER PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
  blood_type TEXT,
  allergies TEXT,
  chronic_conditions TEXT,
  medications TEXT,
  doctor_name TEXT,
  doctor_phone TEXT,
  notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Emergency contacts / authorized-pickup list per child.
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT,
  phone TEXT NOT NULL,
  can_pickup INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_date ON items(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_assignments_class ON item_assignments(class_id);
CREATE INDEX IF NOT EXISTS idx_assignments_item ON item_assignments(item_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_class_date ON attendance(class_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_child ON attendance(child_id);
CREATE INDEX IF NOT EXISTS idx_notes_class ON parent_notes(class_id, archived);
CREATE INDEX IF NOT EXISTS idx_notes_child ON parent_notes(child_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_notes_date ON parent_notes(note_date);
CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(date);
CREATE INDEX IF NOT EXISTS idx_daily_reports_child ON daily_reports(child_id);
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_child ON emergency_contacts(child_id);

-- =========================================================================
-- Phase 2 additions: pickup requests, pedagogical development, audit log,
-- and the full financial/accounting module. children.qr_token and
-- users.finance_permission are added via idempotent ALTER TABLE migrations
-- in db/index.js (see migrateAddColumns) since they attach to tables that
-- already exist on deployed databases.
-- =========================================================================

-- A parent pressing "أنا أمام الروضة" creates one row here. Auto-ID on
-- purpose (not child_id+date) — a family may need to request pickup more
-- than once in a day (forgotten item, changed plan...), and two different
-- parents/children requesting at the exact same moment must never collide.
CREATE TABLE IF NOT EXISTS pickup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'cancelled')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_to_name TEXT,
  delivered_by INTEGER REFERENCES users(id),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pickup_requests_status ON pickup_requests(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_pickup_requests_child ON pickup_requests(child_id);

-- Periodic pedagogical development assessments per child/domain, entered by
-- the teacher and visible to the parent.
CREATE TABLE IF NOT EXISTS development_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain IN ('motor', 'cognitive', 'language', 'social', 'autonomy')),
  level TEXT NOT NULL CHECK (level IN ('emerging', 'developing', 'proficient')),
  note TEXT,
  assessed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dev_assessments_child ON development_assessments(child_id);

-- General-purpose sensitive-operation audit trail (payments voided,
-- discounts granted, health record edits, child delivered to a pickup
-- person, expenses recorded...). Never deleted from the app.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

-- =========================================================================
-- Financial module. Restricted to admin + users.finance_permission holders
-- (never educator/driver by default; parent view only when
-- financial_settings.parent_finance_visible = 1).
-- =========================================================================

-- Configurable subscription plans (full day / half day / custom...) — name
-- and price editable from the admin settings screen, never hardcoded.
CREATE TABLE IF NOT EXISTS fee_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per child holding their subscription/registration/transport
-- configuration. The actual month-by-month ledger lives in monthly_fees —
-- this is the *settings* for that child's account, not a transaction log.
CREATE TABLE IF NOT EXISTS financial_accounts (
  child_id INTEGER PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
  fee_plan_id INTEGER REFERENCES fee_plans(id) ON DELETE SET NULL,
  registration_fee REAL NOT NULL DEFAULT 0,
  registration_paid INTEGER NOT NULL DEFAULT 0,
  transport_enabled INTEGER NOT NULL DEFAULT 0,
  transport_fee REAL NOT NULL DEFAULT 0,
  sibling_rank INTEGER NOT NULL DEFAULT 1,
  discount_type TEXT CHECK (discount_type IN ('fixed', 'percent')),
  discount_value REAL NOT NULL DEFAULT 0,
  discount_reason TEXT,
  exempt INTEGER NOT NULL DEFAULT 0,
  exempt_reason TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (child, month) — the actual monthly due/paid ledger.
-- Deterministic UNIQUE(child_id, month) makes "generate this month's dues"
-- an idempotent upsert; a payment updates amount_paid/status here.
CREATE TABLE IF NOT EXISTS monthly_fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount_due REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partial', 'paid', 'exempt')),
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(child_id, month)
);
CREATE INDEX IF NOT EXISTS idx_monthly_fees_month ON monthly_fees(month);
CREATE INDEX IF NOT EXISTS idx_monthly_fees_child ON monthly_fees(child_id);

-- Every payment ever recorded (registration, monthly, transport, service...).
-- Never hard-deleted — a mistaken entry is voided (status + reason + who +
-- when), never removed, per the audit/integrity requirement.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  monthly_fee_id INTEGER REFERENCES monthly_fees(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank_transfer', 'ccp', 'baridimob', 'other')),
  reason TEXT NOT NULL DEFAULT 'monthly' CHECK (reason IN ('registration', 'monthly', 'transport', 'service', 'other')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_child ON payments(child_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

-- Sequentially numbered receipt per payment (e.g. MM-2026-000001). The
-- number is reserved from the `counters` table inside the same write
-- transaction that inserts the payment — see utils/finance.js — so two
-- concurrent payments can never receive the same number.
CREATE TABLE IF NOT EXISTS payment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL UNIQUE,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES children(id),
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Named sequential counters (receipt numbers per year, etc.) — incremented
-- transactionally, see utils/finance.js.
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank_transfer', 'ccp', 'baridimob', 'other')),
  expense_date TEXT NOT NULL,
  invoice_number TEXT,
  invoice_photo TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_reason TEXT,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

-- Full cashbox transaction log (opening balance + every income/expense),
-- kept separate from `payments`/`expenses` so the cashbox balance is a
-- simple SUM(amount) over this one table regardless of source.
CREATE TABLE IF NOT EXISTS cashbox_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'opening')),
  amount REAL NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row settings table (id is always 1) for every configurable
-- financial parameter — no code changes needed to adjust these.
CREATE TABLE IF NOT EXISTS financial_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_fee_default REAL NOT NULL DEFAULT 0,
  due_day INTEGER NOT NULL DEFAULT 5,
  grace_period_days INTEGER NOT NULL DEFAULT 5,
  currency TEXT NOT NULL DEFAULT 'دج',
  receipt_prefix TEXT NOT NULL DEFAULT 'MM',
  sibling_discount_2nd REAL NOT NULL DEFAULT 0,
  sibling_discount_3rd REAL NOT NULL DEFAULT 0,
  parent_finance_visible INTEGER NOT NULL DEFAULT 0,
  cashbox_opening_balance REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Phase 3: school transport, payroll, messaging, self-registration
-- ============================================================

-- A named bus/van line with an assigned driver (a `users` row with
-- role='driver') and an optional assistant (not necessarily a system user).
CREATE TABLE IF NOT EXISTS transport_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assistant_name TEXT,
  trip_type TEXT NOT NULL DEFAULT 'both' CHECK (trip_type IN ('morning','evening','both')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each child has at most one active route assignment at a time, with an
-- optional named pickup/dropoff point and order-on-route for the driver board.
CREATE TABLE IF NOT EXISTS transport_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL UNIQUE REFERENCES children(id) ON DELETE CASCADE,
  route_id INTEGER NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  pickup_point TEXT,
  stop_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transport_assignments_route ON transport_assignments(route_id);

-- One row per child per day per trip (morning/evening) — the driver board
-- checks these off as boarded/dropped in real time.
CREATE TABLE IF NOT EXISTS transport_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  route_id INTEGER REFERENCES transport_routes(id) ON DELETE SET NULL,
  log_date TEXT NOT NULL,
  trip TEXT NOT NULL CHECK (trip IN ('morning','evening')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','boarded','dropped','absent')),
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT,
  UNIQUE(child_id, log_date, trip)
);
CREATE INDEX IF NOT EXISTS idx_transport_logs_date ON transport_logs(log_date);

-- Base monthly salary per employee (one row per user, any role).
CREATE TABLE IF NOT EXISTS salaries (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_salary REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Salary advances (سلفة) given to an employee, tracked separately from
-- payroll so a single advance can span multiple payroll deductions.
CREATE TABLE IF NOT EXISTS salary_advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  reason TEXT,
  advance_date TEXT NOT NULL DEFAULT (date('now')),
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','repaid')),
  repaid_amount REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_salary_advances_user ON salary_advances(user_id);

-- One generated payroll record per employee per month, with manual
-- bonuses/deductions and any advance repayment applied that month.
CREATE TABLE IF NOT EXISTS payroll_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  base_salary REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0,
  bonus_note TEXT,
  deduction REAL NOT NULL DEFAULT 0,
  deduction_note TEXT,
  advance_deduction REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid')),
  paid_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, month)
);

-- Threaded teacher <-> parent(s) messages, scoped to a specific child.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_child ON messages(child_id, created_at);

-- Public self-service parent registration: a request sits here (password
-- already hashed at submission time) until an admin reviews and approves
-- it — approval is what actually creates the `users` row. This is a
-- deliberate security choice: no account is ever usable before review.
CREATE TABLE IF NOT EXISTS registration_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT,
  child_name TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_registration_requests_status ON registration_requests(status);
