const ExcelJS = require('exceljs');

// Builds a full, human-readable backup of every important table in the app
// as a multi-sheet Excel workbook — so مديرة الروضة always has an offline
// copy she controls, independent of Turso/Render. Read-only export: this
// never modifies the database. Password hashes are deliberately excluded.
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

async function buildBackupWorkbook(db) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'نظام روضة ماما ماريا';
  workbook.created = new Date();

  // ---------- المستخدمون ----------
  {
    const sheet = workbook.addWorksheet('المستخدمون');
    sheet.columns = [
      { header: 'الاسم', key: 'name' },
      { header: 'البريد الإلكتروني', key: 'email' },
      { header: 'الدور', key: 'role' },
      { header: 'الهاتف', key: 'phone' },
      { header: 'الحالة', key: 'active' },
      { header: 'تاريخ الإنشاء', key: 'created_at' },
    ];
    const roleLabels = { admin: 'مديرة الروضة', director: 'المديرة التربوية', teacher: 'مربية', parent: 'ولي أمر', staff: 'إدارية', driver: 'سائق' };
    const rows = await db.execute('SELECT name, email, role, phone, active, created_at FROM users ORDER BY role, name');
    rows.rows.forEach((r) => {
      sheet.addRow({
        name: r.name,
        email: r.email,
        role: roleLabels[r.role] || r.role,
        phone: r.phone || '',
        active: r.active ? 'نشط' : 'موقوف',
        created_at: r.created_at,
      });
    });
    styleHeader(sheet);
  }

  // ---------- الفصول ----------
  {
    const sheet = workbook.addWorksheet('الفصول');
    sheet.columns = [
      { header: 'اسم الفصل', key: 'name' },
      { header: 'الفئة العمرية', key: 'age_range' },
      { header: 'المربية', key: 'teacher_name' },
    ];
    const rows = await db.execute(
      `SELECT classes.name, classes.age_range, users.name AS teacher_name
       FROM classes LEFT JOIN users ON users.id = classes.teacher_id ORDER BY classes.name`
    );
    rows.rows.forEach((r) => sheet.addRow({ name: r.name, age_range: r.age_range || '', teacher_name: r.teacher_name || '—' }));
    styleHeader(sheet);
  }

  // ---------- الأطفال ----------
  {
    const sheet = workbook.addWorksheet('الأطفال');
    sheet.columns = [
      { header: 'اسم الطفل', key: 'child_name' },
      { header: 'الفصل', key: 'class_name' },
      { header: 'اسم ولي الأمر', key: 'parent_name' },
      { header: 'بريد ولي الأمر', key: 'parent_email' },
      { header: 'هاتف ولي الأمر', key: 'parent_phone' },
    ];
    const rows = await db.execute(
      `SELECT children.name AS child_name, classes.name AS class_name,
              users.name AS parent_name, users.email AS parent_email, users.phone AS parent_phone
       FROM children
       LEFT JOIN classes ON classes.id = children.class_id
       LEFT JOIN users ON users.id = children.parent_id
       ORDER BY classes.name, children.name`
    );
    rows.rows.forEach((r) =>
      sheet.addRow({
        child_name: r.child_name,
        class_name: r.class_name || '—',
        parent_name: r.parent_name || '—',
        parent_email: r.parent_email || '',
        parent_phone: r.parent_phone || '',
      })
    );
    styleHeader(sheet);
  }

  // ---------- الحضور والغياب ----------
  {
    const sheet = workbook.addWorksheet('الحضور والغياب');
    sheet.columns = [
      { header: 'التاريخ', key: 'date' },
      { header: 'اسم الطفل', key: 'child_name' },
      { header: 'الفصل', key: 'class_name' },
      { header: 'الحالة', key: 'status' },
      { header: 'سجّلتها', key: 'marked_by_name' },
    ];
    const rows = await db.execute(
      `SELECT attendance.date, children.name AS child_name, classes.name AS class_name,
              attendance.status, users.name AS marked_by_name
       FROM attendance
       JOIN children ON children.id = attendance.child_id
       JOIN classes ON classes.id = attendance.class_id
       LEFT JOIN users ON users.id = attendance.marked_by
       ORDER BY attendance.date DESC, classes.name, children.name`
    );
    rows.rows.forEach((r) =>
      sheet.addRow({
        date: r.date,
        child_name: r.child_name,
        class_name: r.class_name,
        status: r.status === 'present' ? 'حاضر' : 'غائب',
        marked_by_name: r.marked_by_name || '—',
      })
    );
    styleHeader(sheet);
  }

  // ---------- ملاحظات وتوصيات الأولياء ----------
  {
    const sheet = workbook.addWorksheet('ملاحظات الأولياء');
    sheet.columns = [
      { header: 'اسم الطفل', key: 'child_name' },
      { header: 'الفصل', key: 'class_name' },
      { header: 'النوع', key: 'note_type' },
      { header: 'التصنيف', key: 'category' },
      { header: 'الملاحظة', key: 'content' },
      { header: 'التاريخ', key: 'note_date' },
      { header: 'وقت التنبيه', key: 'note_time' },
      { header: 'الحالة', key: 'status' },
      { header: 'بواسطة', key: 'created_by_name' },
      { header: 'مؤرشفة؟', key: 'archived' },
    ];
    const categoryLabels = { health: 'صحة/دواء', food: 'طعام', transport: 'نقل', other: 'أخرى' };
    const rows = await db.execute(
      `SELECT parent_notes.*, children.name AS child_name, classes.name AS class_name, users.name AS created_by_name
       FROM parent_notes
       JOIN children ON children.id = parent_notes.child_id
       JOIN classes ON classes.id = parent_notes.class_id
       LEFT JOIN users ON users.id = parent_notes.created_by
       ORDER BY parent_notes.created_at DESC`
    );
    rows.rows.forEach((r) =>
      sheet.addRow({
        child_name: r.child_name,
        class_name: r.class_name,
        note_type: r.note_type === 'daily' ? 'يوم واحد' : 'دائمة',
        category: categoryLabels[r.category] || r.category,
        content: r.content,
        note_date: r.note_date || '',
        note_time: r.note_time || '',
        status: r.status === 'done' ? 'تم الاطلاع' : 'بانتظار الاطلاع',
        created_by_name: r.created_by_name || '—',
        archived: r.archived ? 'نعم' : 'لا',
      })
    );
    styleHeader(sheet);
  }

  // ---------- الدروس والأنشطة ----------
  {
    const sheet = workbook.addWorksheet('الدروس والأنشطة');
    sheet.columns = [
      { header: 'العنوان', key: 'title' },
      { header: 'النوع', key: 'type' },
      { header: 'التاريخ', key: 'scheduled_date' },
      { header: 'الأولوية', key: 'priority' },
      { header: 'أنشأتها', key: 'created_by_name' },
      { header: 'الفصول', key: 'class_names' },
      { header: 'حالة التنفيذ', key: 'exec_summary' },
    ];
    const rows = await db.execute(
      `SELECT items.title, items.type, items.scheduled_date, items.priority, users.name AS created_by_name,
              GROUP_CONCAT(DISTINCT classes.name) AS class_names,
              COUNT(item_assignments.id) AS total, SUM(CASE WHEN item_assignments.status='executed' THEN 1 ELSE 0 END) AS done
       FROM items
       LEFT JOIN users ON users.id = items.created_by
       LEFT JOIN item_assignments ON item_assignments.item_id = items.id
       LEFT JOIN classes ON classes.id = item_assignments.class_id
       GROUP BY items.id
       ORDER BY items.scheduled_date DESC`
    );
    rows.rows.forEach((r) =>
      sheet.addRow({
        title: r.title,
        type: r.type === 'lesson' ? 'درس' : 'نشاط',
        scheduled_date: r.scheduled_date,
        priority: { normal: 'عادية', important: 'مهمة', urgent: 'عاجلة' }[r.priority] || r.priority,
        created_by_name: r.created_by_name || '—',
        class_names: r.class_names || '—',
        exec_summary: `${r.done || 0} / ${r.total || 0} تم تنفيذها`,
      })
    );
    styleHeader(sheet);
  }

  // ---------- الفعاليات العامة ----------
  {
    const sheet = workbook.addWorksheet('الفعاليات العامة');
    sheet.columns = [
      { header: 'العنوان', key: 'title' },
      { header: 'التاريخ', key: 'event_date' },
      { header: 'النوع', key: 'category' },
      { header: 'تفاصيل', key: 'description' },
      { header: 'أضافتها', key: 'created_by_name' },
    ];
    const categoryLabels = { holiday: 'عطلة/إجازة', trip: 'رحلة', meeting: 'اجتماع أولياء أمور', celebration: 'احتفال/مناسبة', other: 'أخرى' };
    const rows = await db.execute(
      `SELECT events.*, users.name AS created_by_name FROM events LEFT JOIN users ON users.id = events.created_by ORDER BY event_date DESC`
    );
    rows.rows.forEach((r) =>
      sheet.addRow({
        title: r.title,
        event_date: r.event_date,
        category: categoryLabels[r.category] || r.category,
        description: r.description || '',
        created_by_name: r.created_by_name || '—',
      })
    );
    styleHeader(sheet);
  }

  return workbook;
}

module.exports = { buildBackupWorkbook };
