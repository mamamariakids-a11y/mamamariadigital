// Financial module helpers: atomic payment recording (payment + receipt +
// monthly-fee balance + cashbox entry, all-or-nothing), sequential receipt
// numbering safe under concurrency, monthly-due generation with the
// sibling-discount policy, and void/cancel (never hard-delete) flows.
//
// @libsql/client's db.transaction('write') maps to a real SQLite
// transaction, but concurrent writers on the *local* file driver can throw
// SQLITE_BUSY while one transaction is in flight (verified locally — Turso's
// hosted/remote connection queues these server-side instead). withRetry()
// backs off and retries so two admins recording payments at the same moment
// both succeed instead of one erroring out.
const dayjs = require('dayjs');
const db = require('../db');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      const busy = err && (err.code === 'SQLITE_BUSY' || /locked|busy/i.test(err.message || ''));
      if (!busy || i === attempts - 1) throw err;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25 * (i + 1) + Math.random() * 25);
    }
  }
  return undefined;
}

async function runTransaction(work) {
  return withRetry(async () => {
    const tx = await db.transaction('write');
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch (e2) {
        /* transaction may already be closed — ignore */
      }
      throw err;
    }
  });
}

// Reserves the next sequential receipt number for the given year inside an
// already-open write transaction (so the counter bump and the receipt
// insert commit together or not at all). Format: MM-2026-000001.
async function nextReceiptNumber(tx, prefix, year) {
  const counterName = `receipt_${year}`;
  const result = await tx.execute({ sql: 'SELECT value FROM counters WHERE name = ?', args: [counterName] });
  const current = result.rows.length ? Number(result.rows[0].value) : 0;
  const next = current + 1;
  await tx.execute({
    sql: `INSERT INTO counters (name, value) VALUES (?, ?)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
    args: [counterName, next],
  });
  return `${prefix}-${year}-${String(next).padStart(6, '0')}`;
}

async function getFinancialSettings() {
  const result = await db.execute('SELECT * FROM financial_settings WHERE id = 1');
  return result.rows[0];
}

// Computes what a given child owes for one calendar month, applying (in
// order): plan price + transport fee -> full exemption -> manual
// fixed/percent discount -> otherwise the configurable sibling-rank
// discount. Manual discounts and the sibling policy are intentionally
// mutually exclusive per child (a directly-granted discount is a deliberate
// override, not stacked on top of the automatic policy).
function computeMonthlyAmount(account, plan, settings) {
  if (account.exempt) return 0;
  const base = (plan ? Number(plan.price) : 0) + (account.transport_enabled ? Number(account.transport_fee) : 0);
  if (account.discount_type === 'fixed') return Math.max(0, base - Number(account.discount_value));
  if (account.discount_type === 'percent') return Math.max(0, base * (1 - Number(account.discount_value) / 100));
  if (account.sibling_rank >= 3 && settings.sibling_discount_3rd > 0) {
    return Math.max(0, base * (1 - Number(settings.sibling_discount_3rd) / 100));
  }
  if (account.sibling_rank === 2 && settings.sibling_discount_2nd > 0) {
    return Math.max(0, base * (1 - Number(settings.sibling_discount_2nd) / 100));
  }
  return base;
}

// Idempotent upsert — safe to click "generate this month's dues" more than
// once; re-running it after a plan/discount change recalculates amount_due
// for any month not already fully paid, without touching what's already paid.
async function generateMonthlyFee(childId, month) {
  const settings = await getFinancialSettings();
  const accountResult = await db.execute({ sql: 'SELECT * FROM financial_accounts WHERE child_id = ?', args: [childId] });
  const account = accountResult.rows[0];
  if (!account) return null;
  const planResult = account.fee_plan_id
    ? await db.execute({ sql: 'SELECT * FROM fee_plans WHERE id = ?', args: [account.fee_plan_id] })
    : { rows: [] };
  const plan = planResult.rows[0] || null;

  const amountDue = computeMonthlyAmount(account, plan, settings);
  const dueDate = dayjs(month, 'YYYY-MM').date(Number(settings.due_day) || 1).format('YYYY-MM-DD');
  const status = account.exempt ? 'exempt' : 'unpaid';

  await db.execute({
    sql: `INSERT INTO monthly_fees (child_id, month, amount_due, amount_paid, status, due_date)
          VALUES (?, ?, ?, 0, ?, ?)
          ON CONFLICT(child_id, month) DO UPDATE SET
            amount_due = excluded.amount_due,
            due_date = excluded.due_date,
            status = CASE WHEN monthly_fees.amount_paid >= excluded.amount_due AND excluded.amount_due > 0 THEN 'paid'
                          WHEN monthly_fees.amount_paid > 0 THEN 'partial'
                          ELSE excluded.status END,
            updated_at = datetime('now')`,
    args: [childId, month, amountDue, status, dueDate],
  });
  const result = await db.execute({ sql: 'SELECT * FROM monthly_fees WHERE child_id = ? AND month = ?', args: [childId, month] });
  return result.rows[0];
}

async function generateMonthlyFeesForAllChildren(month) {
  const result = await db.execute('SELECT child_id FROM financial_accounts');
  const created = [];
  for (const row of result.rows) {
    // eslint-disable-next-line no-await-in-loop
    const fee = await generateMonthlyFee(row.child_id, month);
    if (fee) created.push(fee);
  }
  return created;
}

function statusForBalance(due, paid) {
  if (due <= 0) return 'exempt';
  if (paid <= 0) return 'unpaid';
  if (paid >= due) return 'paid';
  return 'partial';
}

// The atomic core of the module: creates the payment, reserves+creates its
// receipt, updates the linked monthly fee's paid amount/status (if any),
// and writes a cashbox income entry — all inside one write transaction, so
// a payment can never be saved without every downstream effect landing too.
async function recordPayment({ childId, monthlyFeeId, amount, method, reason, note, recordedBy }) {
  const settings = await getFinancialSettings();
  const year = dayjs().format('YYYY');
  const amountNum = Number(amount);

  return runTransaction(async (tx) => {
    const paymentResult = await tx.execute({
      sql: `INSERT INTO payments (child_id, monthly_fee_id, amount, method, reason, note, recorded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [childId, monthlyFeeId || null, amountNum, method, reason, note || null, recordedBy],
    });
    const paymentId = Number(paymentResult.lastInsertRowid);

    const receiptNumber = await nextReceiptNumber(tx, settings.receipt_prefix || 'MM', year);
    await tx.execute({
      sql: 'INSERT INTO payment_receipts (receipt_number, payment_id, child_id, amount) VALUES (?, ?, ?, ?)',
      args: [receiptNumber, paymentId, childId, amountNum],
    });

    let updatedFee = null;
    if (monthlyFeeId) {
      const feeResult = await tx.execute({ sql: 'SELECT * FROM monthly_fees WHERE id = ?', args: [monthlyFeeId] });
      const fee = feeResult.rows[0];
      if (fee) {
        const newPaid = Number(fee.amount_paid) + amountNum;
        const newStatus = statusForBalance(Number(fee.amount_due), newPaid);
        await tx.execute({
          sql: "UPDATE monthly_fees SET amount_paid = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
          args: [newPaid, newStatus, monthlyFeeId],
        });
        updatedFee = { ...fee, amount_paid: newPaid, status: newStatus };
      }
    }

    if (reason === 'registration') {
      await tx.execute({
        sql: "UPDATE financial_accounts SET registration_paid = CASE WHEN ? >= registration_fee AND registration_fee > 0 THEN 1 ELSE registration_paid END, updated_at = datetime('now') WHERE child_id = ?",
        args: [amountNum, childId],
      });
    }

    await tx.execute({
      sql: `INSERT INTO cashbox_transactions (type, amount, ref_type, ref_id, note, created_by)
            VALUES ('income', ?, 'payment', ?, ?, ?)`,
      args: [amountNum, paymentId, note || null, recordedBy],
    });

    return { paymentId, receiptNumber, updatedFee };
  });
}

// Voids (never deletes) a payment: marks it voided with reason/user/time,
// reverses its effect on the linked monthly fee, and writes a matching
// negative cashbox entry so the cashbox total stays correct.
async function voidPayment(paymentId, { reason, voidedBy }) {
  return runTransaction(async (tx) => {
    const paymentResult = await tx.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [paymentId] });
    const payment = paymentResult.rows[0];
    if (!payment) throw new Error('الدفعة غير موجودة.');
    if (payment.status === 'voided') return payment; // already voided — no-op

    await tx.execute({
      sql: "UPDATE payments SET status = 'voided', voided_reason = ?, voided_by = ?, voided_at = datetime('now') WHERE id = ?",
      args: [reason, voidedBy, paymentId],
    });

    if (payment.monthly_fee_id) {
      const feeResult = await tx.execute({ sql: 'SELECT * FROM monthly_fees WHERE id = ?', args: [payment.monthly_fee_id] });
      const fee = feeResult.rows[0];
      if (fee) {
        const newPaid = Math.max(0, Number(fee.amount_paid) - Number(payment.amount));
        const newStatus = statusForBalance(Number(fee.amount_due), newPaid);
        await tx.execute({
          sql: "UPDATE monthly_fees SET amount_paid = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
          args: [newPaid, newStatus, payment.monthly_fee_id],
        });
      }
    }

    await tx.execute({
      sql: `INSERT INTO cashbox_transactions (type, amount, ref_type, ref_id, note, created_by)
            VALUES ('expense', ?, 'payment_void', ?, ?, ?)`,
      args: [payment.amount, paymentId, `إلغاء دفعة: ${reason}`, voidedBy],
    });

    return payment;
  });
}

async function recordExpense({ categoryId, supplierId, description, amount, method, expenseDate, invoiceNumber, invoicePhoto, recordedBy }) {
  return runTransaction(async (tx) => {
    const amountNum = Number(amount);
    const expenseResult = await tx.execute({
      sql: `INSERT INTO expenses (category_id, supplier_id, description, amount, method, expense_date, invoice_number, invoice_photo, recorded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [categoryId || null, supplierId || null, description, amountNum, method, expenseDate, invoiceNumber || null, invoicePhoto || null, recordedBy],
    });
    const expenseId = Number(expenseResult.lastInsertRowid);
    await tx.execute({
      sql: `INSERT INTO cashbox_transactions (type, amount, ref_type, ref_id, note, created_by)
            VALUES ('expense', ?, 'expense', ?, ?, ?)`,
      args: [amountNum, expenseId, description, recordedBy],
    });
    return { expenseId };
  });
}

async function voidExpense(expenseId, { reason, voidedBy }) {
  return runTransaction(async (tx) => {
    const expenseResult = await tx.execute({ sql: 'SELECT * FROM expenses WHERE id = ?', args: [expenseId] });
    const expense = expenseResult.rows[0];
    if (!expense) throw new Error('المصروف غير موجود.');
    if (expense.status === 'voided') return expense;

    await tx.execute({
      sql: "UPDATE expenses SET status = 'voided', voided_reason = ?, voided_by = ?, voided_at = datetime('now') WHERE id = ?",
      args: [reason, voidedBy, expenseId],
    });
    await tx.execute({
      sql: `INSERT INTO cashbox_transactions (type, amount, ref_type, ref_id, note, created_by)
            VALUES ('income', ?, 'expense_void', ?, ?, ?)`,
      args: [expense.amount, expenseId, `إلغاء مصروف: ${reason}`, voidedBy],
    });
    return expense;
  });
}

// Per-child rollup used by the admin children-finance list, the child
// detail page, and the parent-facing financial view.
async function getChildBalance(childId) {
  const feesResult = await db.execute({
    sql: 'SELECT * FROM monthly_fees WHERE child_id = ? ORDER BY month DESC',
    args: [childId],
  });
  const totals = feesResult.rows.reduce(
    (acc, f) => ({ due: acc.due + Number(f.amount_due), paid: acc.paid + Number(f.amount_paid) }),
    { due: 0, paid: 0 }
  );
  return {
    months: feesResult.rows,
    totalDue: totals.due,
    totalPaid: totals.paid,
    totalRemaining: Math.max(0, totals.due - totals.paid),
  };
}

module.exports = {
  runTransaction,
  withRetry,
  nextReceiptNumber,
  getFinancialSettings,
  computeMonthlyAmount,
  generateMonthlyFee,
  generateMonthlyFeesForAllChildren,
  recordPayment,
  voidPayment,
  recordExpense,
  voidExpense,
  getChildBalance,
};
