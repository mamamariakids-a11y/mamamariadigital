const cron = require('node-cron');
const dayjs = require('dayjs');
const db = require('../db');
const finance = require('./finance');
const { notify, notifyMany } = require('./notify');

// ---------- Automatic monthly fee generation ----------
// Scheduled for 06:00 on the 1st of every month. Render's free tier can
// spin the app down while idle, so a scheduled job only fires if the
// process happens to be awake at that exact minute — not guaranteed. As a
// safety net, `catchUpMonthlyFees()` also runs once at every server boot
// and generates the current month's fees if they haven't been generated
// yet (generateMonthlyFee is idempotent/ON CONFLICT, so this never
// double-charges or overwrites an already-paid fee).
async function generateCurrentMonthFees() {
  const month = dayjs().format('YYYY-MM');
  try {
    const created = await finance.generateMonthlyFeesForAllChildren(month);
    console.log(`[أتمتة] تم توليد رسوم شهر ${month} لعدد ${created.length} طفل.`);
  } catch (err) {
    console.error('[أتمتة] فشل توليد الرسوم الشهرية التلقائي:', err);
  }
}

async function catchUpMonthlyFees() {
  try {
    const month = dayjs().format('YYYY-MM');
    const existing = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM monthly_fees WHERE month = ?', args: [month] });
    const accounts = await db.execute('SELECT COUNT(*) AS c FROM financial_accounts');
    // Only auto-generate if there ARE financial accounts but none of them
    // has a fee row for this month yet — avoids re-running pointlessly on
    // every restart once the month's fees already exist.
    if (Number(accounts.rows[0].c) > 0 && Number(existing.rows[0].c) === 0) {
      await generateCurrentMonthFees();
    }
  } catch (err) {
    console.error('[أتمتة] فشل التحقق من رسوم الشهر الحالي عند الإقلاع:', err);
  }
}

// ---------- Overdue payment reminders ----------
// Runs once daily at 08:00. Notifies each parent with an overdue balance,
// plus every finance-permission holder (full/accountant), with a one-line
// summary. Deliberately at most one notification per recipient per day.
async function sendOverdueReminders() {
  try {
    const overdue = await db.execute(`
      SELECT children.id AS child_id, children.name AS child_name, children.parent_id,
             SUM(monthly_fees.amount_due - monthly_fees.amount_paid) AS remaining
      FROM monthly_fees
      JOIN children ON children.id = monthly_fees.child_id
      WHERE monthly_fees.status IN ('unpaid','partial') AND monthly_fees.due_date < date('now')
      GROUP BY children.id
      HAVING remaining > 0
    `);
    if (!overdue.rows.length) return;

    const settings = await finance.getFinancialSettings();
    for (const row of overdue.rows) {
      if (row.parent_id) {
        // eslint-disable-next-line no-await-in-loop
        await notify(
          row.parent_id,
          'تذكير بمستحقات مالية',
          `يوجد مبلغ متبقٍ قدره ${row.remaining} ${settings.currency} بخصوص ${row.child_name}. يرجى التسديد في أقرب وقت.`,
          '/parent/finance'
        );
      }
    }

    const financeStaff = await db.execute("SELECT id FROM users WHERE role = 'admin' OR finance_permission IN ('full','accountant')");
    const totalRemaining = overdue.rows.reduce((sum, r) => sum + Number(r.remaining || 0), 0);
    await notifyMany(
      financeStaff.rows.map((r) => r.id),
      'تقرير المتأخرات اليومي',
      `يوجد ${overdue.rows.length} طفل لديهم مستحقات متأخرة بإجمالي ${totalRemaining} ${settings.currency}.`,
      '/finance/overdue'
    );
    console.log(`[أتمتة] تم إرسال تذكيرات المتأخرات لعدد ${overdue.rows.length} طفل.`);
  } catch (err) {
    console.error('[أتمتة] فشل إرسال تذكيرات المتأخرات:', err);
  }
}

function startScheduledJobs() {
  // '0 6 1 * *' = 06:00 on day 1 of every month.
  cron.schedule('0 6 1 * *', generateCurrentMonthFees);
  // '0 8 * * *' = every day at 08:00.
  cron.schedule('0 8 * * *', sendOverdueReminders);
  catchUpMonthlyFees();
  console.log('[أتمتة] تم تفعيل المهام المجدولة (توليد الرسوم الشهرية + تذكيرات المتأخرات).');
}

module.exports = { startScheduledJobs, generateCurrentMonthFees, sendOverdueReminders, catchUpMonthlyFees };
