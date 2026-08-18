const ExcelJS = require('exceljs');
const { METHOD_LABELS, REASON_LABELS } = require('./financeLabels');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0FD' } };

function styleHeader(sheet) {
  sheet.views = [{ rightToLeft: true }];
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
  sheet.columns.forEach((col) => {
    col.width = Math.max(14, (col.header || '').length + 4);
  });
}

// A detailed, per-transaction Excel report for one calendar month: every
// active income (payment) row and every active expense row, plus a summary
// sheet with the month's totals — everything an accountant needs to
// reconcile the month offline, independent of the app.
async function buildDetailedMonthlyReport(db, month) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'نظام روضة ماما ماريا';
  workbook.created = new Date();

  const monthStart = `${month}-01`;
  const monthEndResult = await db.execute({ sql: "SELECT date(?, 'start of month', '+1 month', '-1 day') AS d", args: [monthStart] });
  const monthEnd = monthEndResult.rows[0].d;

  const payments = await db.execute({
    sql: `SELECT payments.*, children.name AS child_name, receipt_number
          FROM payments
          LEFT JOIN children ON children.id = payments.child_id
          LEFT JOIN payment_receipts ON payment_receipts.payment_id = payments.id
          WHERE payments.status = 'active' AND date(payments.created_at) BETWEEN ? AND ?
          ORDER BY payments.created_at`,
    args: [monthStart, monthEnd],
  });

  const expenses = await db.execute({
    sql: `SELECT expenses.*, expense_categories.name AS category_name, suppliers.name AS supplier_name
          FROM expenses
          LEFT JOIN expense_categories ON expense_categories.id = expenses.category_id
          LEFT JOIN suppliers ON suppliers.id = expenses.supplier_id
          WHERE expenses.status = 'active' AND expenses.expense_date BETWEEN ? AND ?
          ORDER BY expenses.expense_date`,
    args: [monthStart, monthEnd],
  });

  {
    const sheet = workbook.addWorksheet('الإيرادات');
    sheet.columns = [
      { header: 'التاريخ', key: 'date' },
      { header: 'رقم الوصل', key: 'receipt' },
      { header: 'الطفل', key: 'child' },
      { header: 'السبب', key: 'reason' },
      { header: 'طريقة الدفع', key: 'method' },
      { header: 'المبلغ', key: 'amount' },
    ];
    payments.rows.forEach((p) => {
      sheet.addRow({
        date: p.created_at,
        receipt: p.receipt_number || '—',
        child: p.child_name || '—',
        reason: REASON_LABELS[p.reason] || p.reason,
        method: METHOD_LABELS[p.method] || p.method,
        amount: p.amount,
      });
    });
    styleHeader(sheet);
  }

  {
    const sheet = workbook.addWorksheet('المصاريف');
    sheet.columns = [
      { header: 'التاريخ', key: 'date' },
      { header: 'الفئة', key: 'category' },
      { header: 'المورد', key: 'supplier' },
      { header: 'الوصف', key: 'description' },
      { header: 'رقم الفاتورة', key: 'invoice' },
      { header: 'المبلغ', key: 'amount' },
    ];
    expenses.rows.forEach((x) => {
      sheet.addRow({
        date: x.expense_date,
        category: x.category_name || '—',
        supplier: x.supplier_name || '—',
        description: x.description || '—',
        invoice: x.invoice_number || '—',
        amount: x.amount,
      });
    });
    styleHeader(sheet);
  }

  {
    const sheet = workbook.addWorksheet('الملخص');
    const totalIncome = payments.rows.reduce((s, p) => s + Number(p.amount), 0);
    const totalExpenses = expenses.rows.reduce((s, x) => s + Number(x.amount), 0);
    sheet.columns = [{ header: 'البند', key: 'label' }, { header: 'القيمة', key: 'value' }];
    sheet.addRow({ label: 'الشهر', value: month });
    sheet.addRow({ label: 'إجمالي الإيرادات', value: totalIncome });
    sheet.addRow({ label: 'إجمالي المصاريف', value: totalExpenses });
    sheet.addRow({ label: 'صافي الشهر', value: totalIncome - totalExpenses });
    styleHeader(sheet);
  }

  return workbook;
}

module.exports = { buildDetailedMonthlyReport };
