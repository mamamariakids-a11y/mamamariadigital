const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
// Payroll is admin-only — salary figures are sensitive and this module is
// deliberately kept separate from the requireFinance() permission levels
// (an accountant/secretary grant does NOT imply access to salary data).
router.use(requireRole('admin'));

async function loadEmployees() {
  const result = await db.execute(`
    SELECT users.id, users.name, users.role, users.active,
           COALESCE(salaries.base_salary, 0) AS base_salary,
           (SELECT COALESCE(SUM(amount - repaid_amount), 0) FROM salary_advances WHERE user_id = users.id AND status = 'unpaid') AS unpaid_advances
    FROM users
    LEFT JOIN salaries ON salaries.user_id = users.id
    WHERE users.role != 'parent'
    ORDER BY users.role, users.name
  `);
  return result.rows;
}

async function loadAdvances() {
  const result = await db.execute(`
    SELECT salary_advances.*, users.name AS employee_name
    FROM salary_advances JOIN users ON users.id = salary_advances.user_id
    ORDER BY salary_advances.status ASC, salary_advances.advance_date DESC
  `);
  return result.rows;
}

async function loadRecords(month) {
  const result = await db.execute({
    sql: `SELECT payroll_records.*, users.name AS employee_name, users.role AS employee_role
          FROM payroll_records JOIN users ON users.id = payroll_records.user_id
          WHERE payroll_records.month = ?
          ORDER BY users.role, users.name`,
    args: [month],
  });
  return result.rows;
}

router.get('/', async (req, res, next) => {
  try {
    const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : dayjs().format('YYYY-MM');
    const [employees, advances, records] = await Promise.all([loadEmployees(), loadAdvances(), loadRecords(month)]);
    res.render('admin/payroll', {
      title: 'الرواتب والسلف',
      employees,
      advances,
      records,
      month,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/salaries/:userId', async (req, res, next) => {
  try {
    const base = Number(req.body.base_salary) || 0;
    await db.execute({
      sql: `INSERT INTO salaries (user_id, base_salary, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(user_id) DO UPDATE SET base_salary = excluded.base_salary, updated_at = datetime('now')`,
      args: [req.params.userId, base],
    });
    await logAudit(req.session.user, 'salary_updated', { entityType: 'user', entityId: req.params.userId, details: { base_salary: base } });
    res.redirect('/payroll');
  } catch (err) {
    next(err);
  }
});

router.post('/advances', async (req, res, next) => {
  try {
    const { user_id, amount, reason, advance_date } = req.body;
    const amt = Number(amount);
    if (!user_id || !amt || amt <= 0) return res.redirect('/payroll');
    await db.execute({
      sql: 'INSERT INTO salary_advances (user_id, amount, reason, advance_date, created_by) VALUES (?, ?, ?, ?, ?)',
      args: [user_id, amt, reason || null, advance_date && dayjs(advance_date).isValid() ? advance_date : dayjs().format('YYYY-MM-DD'), req.session.user.id],
    });
    await logAudit(req.session.user, 'salary_advance_created', { entityType: 'user', entityId: user_id, details: { amount: amt } });
    res.redirect('/payroll');
  } catch (err) {
    next(err);
  }
});

router.post('/advances/:id/repay', async (req, res, next) => {
  try {
    const adv = await db.execute({ sql: 'SELECT * FROM salary_advances WHERE id = ?', args: [req.params.id] });
    if (!adv.rows.length) return res.redirect('/payroll');
    await db.execute({ sql: "UPDATE salary_advances SET status = 'repaid', repaid_amount = amount WHERE id = ?", args: [req.params.id] });
    await logAudit(req.session.user, 'salary_advance_repaid', { entityType: 'salary_advance', entityId: req.params.id });
    res.redirect('/payroll');
  } catch (err) {
    next(err);
  }
});

// Generates one payroll_records row per active employee (any non-parent
// role) who has a base salary set, for the given month — safe to re-run
// (INSERT OR IGNORE, so it never overwrites a record already reviewed/paid).
router.post('/generate', async (req, res, next) => {
  try {
    const month = req.body.month && /^\d{4}-\d{2}$/.test(req.body.month) ? req.body.month : dayjs().format('YYYY-MM');
    const employees = await db.execute(`
      SELECT users.id, salaries.base_salary FROM users
      JOIN salaries ON salaries.user_id = users.id
      WHERE users.role != 'parent' AND users.active = 1 AND salaries.base_salary > 0
    `);
    for (const emp of employees.rows) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({
        sql: `INSERT INTO payroll_records (user_id, month, base_salary, net_amount, created_by)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, month) DO NOTHING`,
        args: [emp.id, month, emp.base_salary, emp.base_salary, req.session.user.id],
      });
    }
    await logAudit(req.session.user, 'payroll_generated', { details: { month, count: employees.rows.length } });
    res.redirect(`/payroll?month=${encodeURIComponent(month)}`);
  } catch (err) {
    next(err);
  }
});

// Updates a single payroll record's bonus/deduction/advance-repayment and
// recomputes its net amount. If an advance repayment amount is given, it is
// applied FIFO (oldest unpaid advance first) against that employee's
// outstanding advances.
router.post('/records/:id', async (req, res, next) => {
  try {
    const record = await db.execute({ sql: 'SELECT * FROM payroll_records WHERE id = ?', args: [req.params.id] });
    const rec = record.rows[0];
    if (!rec) return res.redirect('/payroll');
    if (rec.status === 'paid') return res.redirect(`/payroll?month=${encodeURIComponent(rec.month)}`); // paid records are locked

    const bonus = Number(req.body.bonus) || 0;
    const deduction = Number(req.body.deduction) || 0;
    const advanceDeduction = Math.max(0, Number(req.body.advance_deduction) || 0);
    const bonusNote = req.body.bonus_note || null;
    const deductionNote = req.body.deduction_note || null;

    if (advanceDeduction > 0) {
      let remaining = advanceDeduction;
      const unpaid = await db.execute({
        sql: "SELECT * FROM salary_advances WHERE user_id = ? AND status = 'unpaid' ORDER BY advance_date ASC",
        args: [rec.user_id],
      });
      for (const adv of unpaid.rows) {
        if (remaining <= 0) break;
        const owed = adv.amount - adv.repaid_amount;
        const applied = Math.min(owed, remaining);
        remaining -= applied;
        const newRepaid = adv.repaid_amount + applied;
        const newStatus = newRepaid >= adv.amount ? 'repaid' : 'unpaid';
        // eslint-disable-next-line no-await-in-loop
        await db.execute({
          sql: 'UPDATE salary_advances SET repaid_amount = ?, status = ? WHERE id = ?',
          args: [newRepaid, newStatus, adv.id],
        });
      }
    }

    const netAmount = rec.base_salary + bonus - deduction - advanceDeduction;
    await db.execute({
      sql: `UPDATE payroll_records SET bonus = ?, bonus_note = ?, deduction = ?, deduction_note = ?, advance_deduction = ?, net_amount = ? WHERE id = ?`,
      args: [bonus, bonusNote, deduction, deductionNote, advanceDeduction, netAmount, req.params.id],
    });
    res.redirect(`/payroll?month=${encodeURIComponent(rec.month)}`);
  } catch (err) {
    next(err);
  }
});

router.post('/records/:id/pay', async (req, res, next) => {
  try {
    const record = await db.execute({ sql: 'SELECT * FROM payroll_records WHERE id = ?', args: [req.params.id] });
    const rec = record.rows[0];
    if (!rec) return res.redirect('/payroll');
    await db.execute({ sql: "UPDATE payroll_records SET status = 'paid', paid_at = datetime('now') WHERE id = ?", args: [req.params.id] });
    await logAudit(req.session.user, 'payroll_paid', { entityType: 'payroll_record', entityId: req.params.id, details: { net_amount: rec.net_amount } });
    res.redirect(`/payroll?month=${encodeURIComponent(rec.month)}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
