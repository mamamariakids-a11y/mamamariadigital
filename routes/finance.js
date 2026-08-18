const express = require('express');
const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const multer = require('multer');
const db = require('../db');
const { requireLogin, requireFinance, requireRole } = require('../middleware/auth');
const finance = require('../utils/finance');
const { logAudit } = require('../utils/audit');
const { buildReceiptPdf } = require('../utils/receiptPdf');
const { buildProfitLossPdf } = require('../utils/plPdf');
const { buildDetailedMonthlyReport } = require('../utils/financialExcel');
const { METHOD_LABELS, REASON_LABELS, FEE_STATUS_LABELS, FEE_STATUS_BADGE, FINANCE_LEVEL_LABELS } = require('../utils/financeLabels');

const router = express.Router();
router.use(requireLogin);

// Invoice photos are kept in memory and stored as base64 inside the
// database row, same approach as utils/upload.js — no persistent disk
// dependency (see that file's comment for why).
const invoiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

let logoDataUri = null;
function getLogoDataUri() {
  if (logoDataUri === null) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png'));
      logoDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    } catch (e) {
      logoDataUri = '';
    }
  }
  return logoDataUri;
}

// ---------- Dashboard ----------
router.get('/', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
    const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD');

    const [todayIncome, monthIncome, monthExpenses, cashboxSum, dueSummary, overdueCount, transportIncome] = await Promise.all([
      db.execute({ sql: "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='active' AND date(created_at) = ?", args: [today] }),
      db.execute({ sql: "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='active' AND date(created_at) BETWEEN ? AND ?", args: [monthStart, monthEnd] }),
      db.execute({ sql: "SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE status='active' AND expense_date BETWEEN ? AND ?", args: [monthStart, monthEnd] }),
      db.execute("SELECT COALESCE(SUM(CASE WHEN type='income' OR type='opening' THEN amount ELSE -amount END),0) AS s FROM cashbox_transactions"),
      db.execute("SELECT COALESCE(SUM(amount_due),0) AS due, COALESCE(SUM(amount_paid),0) AS paid FROM monthly_fees WHERE month = strftime('%Y-%m','now')"),
      db.execute("SELECT COUNT(DISTINCT child_id) AS c FROM monthly_fees WHERE status IN ('unpaid','partial') AND due_date < date('now')"),
      db.execute({ sql: "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='active' AND reason='transport' AND date(created_at) BETWEEN ? AND ?", args: [monthStart, monthEnd] }),
    ]);

    res.render('finance/dashboard', {
      title: 'اللوحة المالية',
      todayIncome: Number(todayIncome.rows[0].s),
      monthIncome: Number(monthIncome.rows[0].s),
      monthExpenses: Number(monthExpenses.rows[0].s),
      netFlow: Number(monthIncome.rows[0].s) - Number(monthExpenses.rows[0].s),
      cashboxBalance: Number(cashboxSum.rows[0].s),
      monthDue: Number(dueSummary.rows[0].due),
      monthPaid: Number(dueSummary.rows[0].paid),
      overdueCount: Number(overdueCount.rows[0].c),
      transportIncome: Number(transportIncome.rows[0].s),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Children finance list ----------
router.get('/children', requireFinance('full', 'accountant', 'secretary'), async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const childrenResult = await db.execute(
      `SELECT children.id, children.name, classes.name AS class_name,
              financial_accounts.child_id AS has_account, financial_accounts.exempt
       FROM children
       LEFT JOIN classes ON classes.id = children.class_id
       LEFT JOIN financial_accounts ON financial_accounts.child_id = children.id
       ORDER BY classes.name, children.name`
    );
    let children = childrenResult.rows;
    if (q) children = children.filter((c) => c.name.toLowerCase().includes(q));

    const balances = {};
    for (const c of children) {
      if (c.has_account) {
        // eslint-disable-next-line no-await-in-loop
        balances[c.id] = await finance.getChildBalance(c.id);
      }
    }

    res.render('finance/children', { title: 'الوضعية المالية للأطفال', children, balances, q: req.query.q || '' });
  } catch (err) {
    next(err);
  }
});

async function loadChildFinance(childId) {
  const childResult = await db.execute({
    sql: `SELECT children.*, classes.name AS class_name, users.name AS parent_name, users.id AS parent_id
          FROM children LEFT JOIN classes ON classes.id = children.class_id
          LEFT JOIN users ON users.id = children.parent_id WHERE children.id = ?`,
    args: [childId],
  });
  const child = childResult.rows[0];
  if (!child) return null;
  const accountResult = await db.execute({ sql: 'SELECT * FROM financial_accounts WHERE child_id = ?', args: [childId] });
  const balance = await finance.getChildBalance(childId);
  const paymentsResult = await db.execute({
    sql: `SELECT payments.*, payment_receipts.receipt_number
          FROM payments LEFT JOIN payment_receipts ON payment_receipts.payment_id = payments.id
          WHERE payments.child_id = ? ORDER BY payments.created_at DESC LIMIT 50`,
    args: [childId],
  });
  return { child, account: accountResult.rows[0] || null, balance, payments: paymentsResult.rows };
}

router.get('/children/:id', requireFinance('full', 'accountant', 'secretary'), async (req, res, next) => {
  try {
    const detail = await loadChildFinance(req.params.id);
    if (!detail) return res.status(404).render('error', { title: 'غير موجود', message: 'الطفل غير موجود.' });
    const plansResult = await db.execute("SELECT * FROM fee_plans WHERE active = 1 ORDER BY name");
    res.render('finance/child-detail', {
      title: `الوضعية المالية - ${detail.child.name}`,
      ...detail,
      plans: plansResult.rows,
      methodLabels: METHOD_LABELS,
      reasonLabels: REASON_LABELS,
      feeStatusLabels: FEE_STATUS_LABELS,
      feeStatusBadge: FEE_STATUS_BADGE,
      canEditAccount: ['full', 'accountant'].includes(req.financeLevel) || req.session.user.role === 'admin',
      canVoid: ['full', 'accountant'].includes(req.financeLevel) || req.session.user.role === 'admin',
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/account', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const { fee_plan_id, registration_fee, transport_enabled, transport_fee, sibling_rank, discount_type, discount_value, discount_reason, exempt, exempt_reason, notes } = req.body;
    await db.execute({
      sql: `INSERT INTO financial_accounts (child_id, fee_plan_id, registration_fee, transport_enabled, transport_fee, sibling_rank, discount_type, discount_value, discount_reason, exempt, exempt_reason, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(child_id) DO UPDATE SET
              fee_plan_id=excluded.fee_plan_id, registration_fee=excluded.registration_fee,
              transport_enabled=excluded.transport_enabled, transport_fee=excluded.transport_fee,
              sibling_rank=excluded.sibling_rank, discount_type=excluded.discount_type, discount_value=excluded.discount_value,
              discount_reason=excluded.discount_reason, exempt=excluded.exempt, exempt_reason=excluded.exempt_reason,
              notes=excluded.notes, updated_at=datetime('now')`,
      args: [
        req.params.id, fee_plan_id || null, Number(registration_fee) || 0, transport_enabled ? 1 : 0, Number(transport_fee) || 0,
        Number(sibling_rank) || 1, discount_type || null, Number(discount_value) || 0, (discount_reason || '').trim() || null,
        exempt ? 1 : 0, (exempt_reason || '').trim() || null, (notes || '').trim() || null,
      ],
    });
    await logAudit(req.session.user, 'finance.account.update', { entityType: 'child', entityId: req.params.id, details: req.body });
    res.redirect(`/finance/children/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/children/:id/generate-month', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const month = req.body.month && dayjs(req.body.month, 'YYYY-MM', true).isValid() ? req.body.month : dayjs().format('YYYY-MM');
    await finance.generateMonthlyFee(req.params.id, month);
    res.redirect(`/finance/children/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/generate-month-all', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const month = req.body.month && dayjs(req.body.month, 'YYYY-MM', true).isValid() ? req.body.month : dayjs().format('YYYY-MM');
    const created = await finance.generateMonthlyFeesForAllChildren(month);
    await logAudit(req.session.user, 'finance.month.generate', { details: { month, count: created.length } });
    res.redirect('/finance/children?generated=' + month);
  } catch (err) {
    next(err);
  }
});

// ---------- Record a payment (admin / accountant / secretary) ----------
router.post('/children/:id/payments', requireFinance('full', 'accountant', 'secretary'), async (req, res, next) => {
  try {
    const { monthly_fee_id, amount, method, reason, note } = req.body;
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) {
      const detail = await loadChildFinance(req.params.id);
      const plansResult = await db.execute('SELECT * FROM fee_plans WHERE active = 1 ORDER BY name');
      return res.status(400).render('finance/child-detail', {
        title: `الوضعية المالية - ${detail.child.name}`,
        ...detail,
        plans: plansResult.rows,
        methodLabels: METHOD_LABELS,
        reasonLabels: REASON_LABELS,
        feeStatusLabels: FEE_STATUS_LABELS,
        feeStatusBadge: FEE_STATUS_BADGE,
        canEditAccount: ['full', 'accountant'].includes(req.financeLevel) || req.session.user.role === 'admin',
        canVoid: ['full', 'accountant'].includes(req.financeLevel) || req.session.user.role === 'admin',
        error: 'يرجى إدخال مبلغ صحيح أكبر من صفر.',
      });
    }

    const result = await finance.recordPayment({
      childId: Number(req.params.id),
      monthlyFeeId: monthly_fee_id ? Number(monthly_fee_id) : null,
      amount: amountNum,
      method: ['cash', 'bank_transfer', 'ccp', 'baridimob', 'other'].includes(method) ? method : 'cash',
      reason: ['registration', 'monthly', 'transport', 'service', 'other'].includes(reason) ? reason : 'other',
      note,
      recordedBy: req.session.user.id,
    });

    await logAudit(req.session.user, 'finance.payment.record', {
      entityType: 'payment', entityId: result.paymentId, details: { childId: req.params.id, amount: amountNum, receipt: result.receiptNumber },
    });

    res.redirect(`/finance/receipts/${result.paymentId}`);
  } catch (err) {
    next(err);
  }
});

router.post('/payments/:id/void', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const payment = await finance.voidPayment(Number(req.params.id), { reason: req.body.reason || 'بدون سبب مذكور', voidedBy: req.session.user.id });
    await logAudit(req.session.user, 'finance.payment.void', { entityType: 'payment', entityId: req.params.id, details: { reason: req.body.reason } });
    res.redirect(`/finance/children/${payment.child_id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Receipts ----------
async function loadReceiptData(paymentId) {
  const paymentResult = await db.execute({
    sql: `SELECT payments.*, payment_receipts.receipt_number, children.name AS child_name, classes.name AS class_name,
                 users.name AS parent_name, employee.name AS employee_name, monthly_fees.month AS fee_month
          FROM payments
          JOIN payment_receipts ON payment_receipts.payment_id = payments.id
          JOIN children ON children.id = payments.child_id
          LEFT JOIN classes ON classes.id = children.class_id
          LEFT JOIN users ON users.id = children.parent_id
          LEFT JOIN users employee ON employee.id = payments.recorded_by
          LEFT JOIN monthly_fees ON monthly_fees.id = payments.monthly_fee_id
          WHERE payments.id = ?`,
    args: [paymentId],
  });
  const payment = paymentResult.rows[0];
  if (!payment) return null;
  let remaining = null;
  if (payment.monthly_fee_id) {
    const feeResult = await db.execute({ sql: 'SELECT * FROM monthly_fees WHERE id = ?', args: [payment.monthly_fee_id] });
    const fee = feeResult.rows[0];
    if (fee) remaining = Math.max(0, Number(fee.amount_due) - Number(fee.amount_paid));
  }
  return { payment, remaining };
}

// Receipts are also reachable by the paying parent themselves (e.g. from
// their /parent/finance page), but only when the admin has turned on
// parent-facing financial visibility, and only for their own child's
// payment — never anyone else's.
async function canViewReceipt(req, paymentChildId) {
  if (req.session.user.role === 'admin') return true;
  if (req.session.user.role === 'parent') {
    const settings = await finance.getFinancialSettings();
    if (!settings.parent_finance_visible) return false;
    const childResult = await db.execute({ sql: 'SELECT parent_id FROM children WHERE id = ?', args: [paymentChildId] });
    return childResult.rows[0] && childResult.rows[0].parent_id === req.session.user.id;
  }
  const result = await db.execute({ sql: 'SELECT finance_permission FROM users WHERE id = ?', args: [req.session.user.id] });
  return Boolean(result.rows[0] && result.rows[0].finance_permission);
}

router.get('/receipts/:id', async (req, res, next) => {
  try {
    const data = await loadReceiptData(req.params.id);
    if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'الوصل غير موجود.' });
    if (!(await canViewReceipt(req, data.payment.child_id))) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'ليس لديك صلاحية لعرض هذا الوصل.' });
    }
    res.render('finance/receipt', { title: `وصل ${data.payment.receipt_number}`, ...data, methodLabels: METHOD_LABELS, reasonLabels: REASON_LABELS });
  } catch (err) {
    next(err);
  }
});

router.get('/receipts/:id/pdf', async (req, res, next) => {
  try {
    const data = await loadReceiptData(req.params.id);
    if (!data) return res.status(404).render('error', { title: 'غير موجود', message: 'الوصل غير موجود.' });
    if (!(await canViewReceipt(req, data.payment.child_id))) {
      return res.status(403).render('error', { title: 'غير مصرح', message: 'ليس لديك صلاحية لعرض هذا الوصل.' });
    }
    const { payment, remaining } = data;
    const pdfBuffer = await buildReceiptPdf({
      receiptNumber: payment.receipt_number,
      createdAt: dayjs(payment.created_at).format('YYYY-MM-DD HH:mm'),
      childName: payment.child_name,
      className: payment.class_name,
      parentName: payment.parent_name,
      reasonLabel: REASON_LABELS[payment.reason] || payment.reason,
      methodLabel: METHOD_LABELS[payment.method] || payment.method,
      monthLabel: payment.fee_month || null,
      amount: payment.amount,
      remaining,
      employeeName: payment.employee_name,
      logoBase64: getLogoDataUri(),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${payment.receipt_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// ---------- Overdue payments ----------
router.get('/overdue', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const rowsResult = await db.execute(
      `SELECT monthly_fees.*, children.name AS child_name, classes.name AS class_name, users.phone AS parent_phone,
              CAST(julianday('now') - julianday(monthly_fees.due_date) AS INTEGER) AS days_overdue
       FROM monthly_fees
       JOIN children ON children.id = monthly_fees.child_id
       LEFT JOIN classes ON classes.id = children.class_id
       LEFT JOIN users ON users.id = children.parent_id
       WHERE monthly_fees.status IN ('unpaid','partial') AND monthly_fees.due_date < date('now')
       ORDER BY days_overdue DESC`
    );
    res.render('finance/overdue', { title: 'المتأخرات', rows: rowsResult.rows, feeStatusLabels: FEE_STATUS_LABELS });
  } catch (err) {
    next(err);
  }
});

// ---------- Expenses ----------
router.get('/expenses', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const [expensesResult, categoriesResult, suppliersResult] = await Promise.all([
      db.execute(
        `SELECT expenses.*, expense_categories.name AS category_name, suppliers.name AS supplier_name, users.name AS recorded_by_name
         FROM expenses
         LEFT JOIN expense_categories ON expense_categories.id = expenses.category_id
         LEFT JOIN suppliers ON suppliers.id = expenses.supplier_id
         LEFT JOIN users ON users.id = expenses.recorded_by
         ORDER BY expenses.expense_date DESC, expenses.id DESC LIMIT 100`
      ),
      db.execute('SELECT * FROM expense_categories WHERE active = 1 ORDER BY name'),
      db.execute('SELECT * FROM suppliers ORDER BY name'),
    ]);
    res.render('finance/expenses', {
      title: 'المصاريف',
      expenses: expensesResult.rows,
      categories: categoriesResult.rows,
      suppliers: suppliersResult.rows,
      methodLabels: METHOD_LABELS,
      today: dayjs().format('YYYY-MM-DD'),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/expenses', requireFinance('full', 'accountant'), invoiceUpload.single('invoice_photo'), async (req, res, next) => {
  try {
    const { category_id, supplier_id, description, amount, method, expense_date, invoice_number } = req.body;
    let invoicePhoto = null;
    if (req.file) {
      invoicePhoto = JSON.stringify({ name: req.file.originalname, mime: req.file.mimetype, data: req.file.buffer.toString('base64') });
    }
    const result = await finance.recordExpense({
      categoryId: category_id || null,
      supplierId: supplier_id || null,
      description: (description || '').trim(),
      amount: Number(amount) || 0,
      method: ['cash', 'bank_transfer', 'ccp', 'baridimob', 'other'].includes(method) ? method : 'cash',
      expenseDate: expense_date && dayjs(expense_date).isValid() ? expense_date : dayjs().format('YYYY-MM-DD'),
      invoiceNumber: invoice_number || null,
      invoicePhoto,
      recordedBy: req.session.user.id,
    });
    await logAudit(req.session.user, 'finance.expense.record', { entityType: 'expense', entityId: result.expenseId, details: { amount, description } });
    res.redirect('/finance/expenses');
  } catch (err) {
    next(err);
  }
});

router.post('/expenses/:id/void', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    await finance.voidExpense(Number(req.params.id), { reason: req.body.reason || 'بدون سبب مذكور', voidedBy: req.session.user.id });
    await logAudit(req.session.user, 'finance.expense.void', { entityType: 'expense', entityId: req.params.id, details: { reason: req.body.reason } });
    res.redirect('/finance/expenses');
  } catch (err) {
    next(err);
  }
});

router.post('/suppliers', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const { name, phone, notes } = req.body;
    if (name && name.trim()) {
      await db.execute({ sql: 'INSERT INTO suppliers (name, phone, notes) VALUES (?, ?, ?)', args: [name.trim(), (phone || '').trim(), (notes || '').trim() || null] });
    }
    res.redirect('/finance/expenses');
  } catch (err) {
    next(err);
  }
});

// ---------- Cashbox ----------
router.get('/cashbox', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const txResult = await db.execute(
      `SELECT cashbox_transactions.*, users.name AS created_by_name
       FROM cashbox_transactions LEFT JOIN users ON users.id = cashbox_transactions.created_by
       ORDER BY cashbox_transactions.created_at DESC LIMIT 200`
    );
    const balanceResult = await db.execute("SELECT COALESCE(SUM(CASE WHEN type='income' OR type='opening' THEN amount ELSE -amount END),0) AS s FROM cashbox_transactions");
    res.render('finance/cashbox', { title: 'الصندوق', transactions: txResult.rows, balance: Number(balanceResult.rows[0].s) });
  } catch (err) {
    next(err);
  }
});

// ---------- Settings (admin only) ----------
router.get('/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const [plansResult, settingsResult, categoriesResult, financeUsersResult] = await Promise.all([
      db.execute('SELECT * FROM fee_plans ORDER BY active DESC, name'),
      finance.getFinancialSettings(),
      db.execute('SELECT * FROM expense_categories ORDER BY name'),
      db.execute("SELECT * FROM users WHERE active = 1 AND role != 'parent' ORDER BY role, name"),
    ]);
    res.render('finance/settings', {
      title: 'الإعدادات المالية',
      plans: plansResult.rows,
      settings: settingsResult,
      categories: categoriesResult.rows,
      users: financeUsersResult.rows,
      financeLevelLabels: FINANCE_LEVEL_LABELS,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const { registration_fee_default, due_day, grace_period_days, currency, receipt_prefix, sibling_discount_2nd, sibling_discount_3rd, parent_finance_visible, cashbox_opening_balance } = req.body;
    await db.execute({
      sql: `UPDATE financial_settings SET
              registration_fee_default=?, due_day=?, grace_period_days=?, currency=?, receipt_prefix=?,
              sibling_discount_2nd=?, sibling_discount_3rd=?, parent_finance_visible=?, cashbox_opening_balance=?,
              updated_at=datetime('now')
            WHERE id = 1`,
      args: [
        Number(registration_fee_default) || 0, Number(due_day) || 5, Number(grace_period_days) || 5,
        currency || 'دج', receipt_prefix || 'MM', Number(sibling_discount_2nd) || 0, Number(sibling_discount_3rd) || 0,
        parent_finance_visible ? 1 : 0, Number(cashbox_opening_balance) || 0,
      ],
    });
    await logAudit(req.session.user, 'finance.settings.update', { details: req.body });
    res.redirect('/finance/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/plans', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, description, price } = req.body;
    if (name && name.trim()) {
      await db.execute({ sql: 'INSERT INTO fee_plans (name, description, price) VALUES (?, ?, ?)', args: [name.trim(), (description || '').trim() || null, Number(price) || 0] });
    }
    res.redirect('/finance/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/plans/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, description, price } = req.body;
    await db.execute({ sql: 'UPDATE fee_plans SET name=?, description=?, price=? WHERE id=?', args: [name, (description || '').trim() || null, Number(price) || 0, req.params.id] });
    res.redirect('/finance/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/plans/:id/toggle', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT active FROM fee_plans WHERE id = ?', args: [req.params.id] });
    if (result.rows[0]) await db.execute({ sql: 'UPDATE fee_plans SET active = ? WHERE id = ?', args: [result.rows[0].active ? 0 : 1, req.params.id] });
    res.redirect('/finance/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/categories', requireRole('admin'), async (req, res, next) => {
  try {
    const { name } = req.body;
    if (name && name.trim()) {
      await db.execute({ sql: 'INSERT INTO expense_categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING', args: [name.trim()] });
    }
    res.redirect('/finance/settings');
  } catch (err) {
    next(err);
  }
});

// ---------- Reports (detailed Excel + simplified P&L PDF) ----------
router.get('/reports', requireFinance('full', 'accountant'), (req, res) => {
  const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : dayjs().format('YYYY-MM');
  res.render('finance/reports', { title: 'التقارير المالية', month });
});

router.get('/reports/detailed.xlsx', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : dayjs().format('YYYY-MM');
    const workbook = await buildDetailedMonthlyReport(db, month);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`تقرير-مالي-مفصل-${month}.xlsx`)}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/reports/pl.pdf', requireFinance('full', 'accountant'), async (req, res, next) => {
  try {
    const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : dayjs().format('YYYY-MM');
    const monthStart = `${month}-01`;
    const monthEndResult = await db.execute({ sql: "SELECT date(?, 'start of month', '+1 month', '-1 day') AS d", args: [monthStart] });
    const monthEnd = monthEndResult.rows[0].d;

    const incomeRows = await db.execute({
      sql: `SELECT reason, COALESCE(SUM(amount),0) AS amount FROM payments
            WHERE status = 'active' AND date(created_at) BETWEEN ? AND ? GROUP BY reason`,
      args: [monthStart, monthEnd],
    });
    const expenseRows = await db.execute({
      sql: `SELECT COALESCE(expense_categories.name, 'أخرى') AS category, COALESCE(SUM(expenses.amount),0) AS amount
            FROM expenses LEFT JOIN expense_categories ON expense_categories.id = expenses.category_id
            WHERE expenses.status = 'active' AND expenses.expense_date BETWEEN ? AND ? GROUP BY category`,
      args: [monthStart, monthEnd],
    });

    const incomeByReason = incomeRows.rows.map((r) => ({ label: REASON_LABELS[r.reason] || r.reason, amount: r.amount }));
    const expensesByCategory = expenseRows.rows.map((r) => ({ label: r.category, amount: r.amount }));
    const totalIncome = incomeByReason.reduce((s, r) => s + Number(r.amount), 0);
    const totalExpenses = expensesByCategory.reduce((s, r) => s + Number(r.amount), 0);

    const pdfBuffer = await buildProfitLossPdf({
      month,
      monthLabel: dayjs(monthStart).format('MMMM YYYY'),
      incomeByReason: incomeByReason.length ? incomeByReason : [{ label: 'لا توجد إيرادات', amount: 0 }],
      expensesByCategory: expensesByCategory.length ? expensesByCategory : [{ label: 'لا توجد مصاريف', amount: 0 }],
      totalIncome,
      totalExpenses,
      logoBase64: getLogoDataUri(),
      generatedAt: dayjs().format('DD/MM/YYYY HH:mm'),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`تقرير-مالي-مبسط-${month}.pdf`)}`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

router.post('/settings/users/:id/permission', requireRole('admin'), async (req, res, next) => {
  try {
    const level = ['full', 'accountant', 'secretary'].includes(req.body.level) ? req.body.level : null;
    await db.execute({ sql: 'UPDATE users SET finance_permission = ? WHERE id = ?', args: [level, req.params.id] });
    await logAudit(req.session.user, 'finance.permission.update', { entityType: 'user', entityId: req.params.id, details: { level } });
    res.redirect('/finance/settings');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
