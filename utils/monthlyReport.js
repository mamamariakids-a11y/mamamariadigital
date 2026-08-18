const path = require('path');
const React = require('react');
const { Document, Page, Text, View, Image, Font, StyleSheet, renderToBuffer } = require('@react-pdf/renderer');

// @react-pdf/renderer does full Unicode BiDi + Arabic contextual shaping
// internally, so plain Arabic strings render correctly (joined letters,
// right-to-left order, correct mixed Arabic/Latin/number runs) as long as
// the embedded font actually contains Arabic glyphs — which Cairo does.
// The .ttf files here are the same Cairo font used across the web app,
// pre-converted from Google Fonts' .woff2 so no network fetch is needed
// at runtime (important for Render's free tier).
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let fontsRegistered = false;
function registerFonts() {
  if (fontsRegistered) return;
  Font.register({
    family: 'Cairo',
    fonts: [
      { src: path.join(FONTS_DIR, 'Cairo-Regular.ttf'), fontWeight: 'normal' },
      { src: path.join(FONTS_DIR, 'Cairo-SemiBold.ttf'), fontWeight: 600 },
      { src: path.join(FONTS_DIR, 'Cairo-Bold.ttf'), fontWeight: 'bold' },
    ],
  });
  // react-pdf's default hyphenation callback breaks Arabic words at odd
  // points when a line wraps; disabling it just lets long words wrap whole.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

const e = React.createElement;

const COLORS = {
  primary: '#4A7CE0',
  primaryDark: '#3A63B8',
  primaryLight: '#EAF0FD',
  secondary: '#3AA0A0',
  secondaryLight: '#E6F5F5',
  danger: '#D9634F',
  dangerLight: '#FBEAE7',
  text: '#26314D',
  textMuted: '#6B7690',
  border: '#E7EAF3',
};

const styles = StyleSheet.create({
  page: { padding: 36, fontFamily: 'Cairo', direction: 'rtl', fontSize: 10.5, color: COLORS.text },
  headerRow: { flexDirection: 'row-reverse', alignItems: 'center', marginBottom: 18, gap: 12 },
  logo: { width: 46, height: 46, borderRadius: 23 },
  kgName: { fontSize: 16, fontWeight: 'bold', textAlign: 'right' },
  reportTitle: { fontSize: 11, color: COLORS.textMuted, textAlign: 'right', marginTop: 2 },
  classHeader: {
    backgroundColor: COLORS.primaryLight, borderRadius: 8, padding: '10 14', marginBottom: 14,
    flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center',
  },
  className: { fontSize: 13, fontWeight: 'bold', color: COLORS.primaryDark, textAlign: 'right' },
  classMeta: { fontSize: 10, color: COLORS.textMuted, textAlign: 'right' },
  statsRow: { flexDirection: 'row-reverse', marginBottom: 16, gap: 10 },
  statBox: { flex: 1, backgroundColor: '#F5F7FB', borderRadius: 8, padding: 10, alignItems: 'flex-end' },
  statValue: { fontSize: 15, fontWeight: 'bold', textAlign: 'right' },
  statLabel: { fontSize: 8.5, color: COLORS.textMuted, textAlign: 'right', marginTop: 2 },
  table: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 6, overflow: 'hidden' },
  tRowHead: { flexDirection: 'row-reverse', backgroundColor: COLORS.primaryLight },
  tRow: { flexDirection: 'row-reverse', borderTopWidth: 1, borderTopColor: COLORS.border },
  tRowAlt: { backgroundColor: '#FAFBFD' },
  tCellName: { flex: 2.2, padding: '7 10', textAlign: 'right' },
  tCell: { flex: 1, padding: '7 10', textAlign: 'center' },
  tHeadText: { fontSize: 9.5, fontWeight: 'bold', color: COLORS.primaryDark },
  tCellText: { fontSize: 9.5 },
  rateGood: { color: COLORS.secondary, fontWeight: 'bold' },
  rateBad: { color: COLORS.danger, fontWeight: 'bold' },
  notesLine: { fontSize: 9.5, color: COLORS.textMuted, textAlign: 'right', marginTop: 14 },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 8, color: COLORS.textMuted, textAlign: 'center' },
});

function rateStyle(rate) {
  if (rate === null) return styles.tCellText;
  return rate >= 80 ? [styles.tCellText, styles.rateGood] : [styles.tCellText, styles.rateBad];
}

function ClassPage({ logoBase64, monthLabel, generatedAt, cls, notesSummary }) {
  return e(
    Page,
    { size: 'A4', style: styles.page },
    e(
      View,
      { style: styles.headerRow },
      logoBase64 ? e(Image, { src: logoBase64, style: styles.logo }) : null,
      e(
        View,
        null,
        e(Text, { style: styles.kgName }, 'روضة ماما ماريا'),
        e(Text, { style: styles.reportTitle }, `التقرير الشهري — ${monthLabel}`)
      )
    ),
    e(
      View,
      { style: styles.classHeader },
      e(Text, { style: styles.className }, cls.name),
      e(Text, { style: styles.classMeta }, cls.teacherName ? `المربية: ${cls.teacherName}` : '')
    ),
    e(
      View,
      { style: styles.statsRow },
      e(
        View,
        { style: styles.statBox },
        e(Text, { style: styles.statValue }, cls.rate === null ? '—' : `${cls.rate}%`),
        e(Text, { style: styles.statLabel }, 'متوسط نسبة الحضور')
      ),
      e(
        View,
        { style: styles.statBox },
        e(Text, { style: styles.statValue }, `${cls.executedItems} / ${cls.totalItems}`),
        e(Text, { style: styles.statLabel }, 'الدروس والأنشطة المنفذة')
      ),
      e(
        View,
        { style: styles.statBox },
        e(Text, { style: styles.statValue }, String(cls.children.length)),
        e(Text, { style: styles.statLabel }, 'عدد الأطفال')
      )
    ),
    e(
      View,
      { style: styles.table },
      e(
        View,
        { style: styles.tRowHead },
        e(View, { style: styles.tCellName }, e(Text, { style: styles.tHeadText }, 'اسم الطفل')),
        e(View, { style: styles.tCell }, e(Text, { style: styles.tHeadText }, 'أيام الحضور')),
        e(View, { style: styles.tCell }, e(Text, { style: styles.tHeadText }, 'أيام الغياب')),
        e(View, { style: styles.tCell }, e(Text, { style: styles.tHeadText }, 'نسبة الحضور'))
      ),
      ...cls.children.map((ch, i) =>
        e(
          View,
          { key: ch.child_id, style: [styles.tRow, i % 2 === 1 ? styles.tRowAlt : null] },
          e(View, { style: styles.tCellName }, e(Text, { style: styles.tCellText }, ch.child_name)),
          e(View, { style: styles.tCell }, e(Text, { style: styles.tCellText }, String(ch.present_count))),
          e(View, { style: styles.tCell }, e(Text, { style: styles.tCellText }, String(ch.absent_count))),
          e(View, { style: styles.tCell }, e(Text, { style: rateStyle(ch.rate) }, ch.rate === null ? '—' : `${ch.rate}%`))
        )
      )
    ),
    e(
      Text,
      { style: styles.notesLine },
      `ملاحظات الأولياء هذا الشهر: ${notesSummary.total} — تم التعامل مع ${notesSummary.done} منها`
    ),
    e(Text, { style: styles.footer }, `تم إصدار هذا التقرير تلقائيًا بتاريخ ${generatedAt}`)
  );
}

// Shared by both the PDF builder and the admin preview page, so the numbers
// shown on-screen always match exactly what gets downloaded.
async function getMonthlyReportData(db, month) {
  const dayjs = require('dayjs');
  const arLocale = require('dayjs/locale/ar');
  // Same "أوت" override as app.js (see the comment there) — kept here too so
  // this function's month label is correct even if it's ever called before
  // app.js has run (e.g. in a standalone script or test). Spreading the full
  // base locale keeps weekdays/formats intact; dayjs.locale(name, obj) would
  // otherwise replace the whole locale definition, not merge into it.
  const monthsWithAout = 'يناير_فبراير_مارس_أبريل_مايو_يونيو_يوليو_أوت_سبتمبر_أكتوبر_نوفمبر_ديسمبر'.split('_');
  dayjs.locale('ar', { ...arLocale, months: monthsWithAout, monthsShort: monthsWithAout });
  const monthStart = dayjs(month, 'YYYY-MM').startOf('month').format('YYYY-MM-DD');
  const monthEnd = dayjs(month, 'YYYY-MM').endOf('month').format('YYYY-MM-DD');
  const monthLabel = dayjs(month, 'YYYY-MM').locale('ar').format('MMMM YYYY');
  const generatedAt = dayjs().format('YYYY-MM-DD HH:mm');

  const attendanceResult = await db.execute({
    sql: `SELECT children.id AS child_id, children.name AS child_name,
                 classes.id AS class_id, classes.name AS class_name, users.name AS teacher_name,
                 SUM(CASE WHEN attendance.status='present' THEN 1 ELSE 0 END) AS present_count,
                 SUM(CASE WHEN attendance.status='absent' THEN 1 ELSE 0 END) AS absent_count
          FROM children
          JOIN classes ON classes.id = children.class_id
          LEFT JOIN users ON users.id = classes.teacher_id
          LEFT JOIN attendance ON attendance.child_id = children.id AND attendance.date BETWEEN ? AND ?
          GROUP BY children.id
          ORDER BY classes.name, children.name`,
    args: [monthStart, monthEnd],
  });

  const itemsResult = await db.execute({
    sql: `SELECT classes.id AS class_id, COUNT(item_assignments.id) AS total,
                 SUM(CASE WHEN item_assignments.status='executed' THEN 1 ELSE 0 END) AS executed
          FROM item_assignments
          JOIN items ON items.id = item_assignments.item_id
          JOIN classes ON classes.id = item_assignments.class_id
          WHERE items.scheduled_date BETWEEN ? AND ?
          GROUP BY classes.id`,
    args: [monthStart, monthEnd],
  });
  const itemsByClass = new Map();
  itemsResult.rows.forEach((r) => itemsByClass.set(r.class_id, { total: Number(r.total), executed: Number(r.executed) }));

  const notesResult = await db.execute({
    sql: `SELECT classes.id AS class_id, COUNT(*) AS total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done
          FROM parent_notes
          JOIN classes ON classes.id = parent_notes.class_id
          WHERE parent_notes.created_at BETWEEN ? AND ?
          GROUP BY classes.id`,
    args: [`${monthStart} 00:00:00`, `${monthEnd} 23:59:59`],
  });
  const notesByClass = new Map();
  notesResult.rows.forEach((r) => notesByClass.set(r.class_id, { total: Number(r.total), done: Number(r.done) }));

  const classesMap = new Map();
  attendanceResult.rows.forEach((r) => {
    const present = Number(r.present_count);
    const absent = Number(r.absent_count);
    const marked = present + absent;
    if (!classesMap.has(r.class_id)) {
      classesMap.set(r.class_id, { id: r.class_id, name: r.class_name, teacherName: r.teacher_name, children: [], presentSum: 0, markedSum: 0 });
    }
    const cls = classesMap.get(r.class_id);
    cls.children.push({ child_id: r.child_id, child_name: r.child_name, present_count: present, absent_count: absent, rate: marked ? Math.round((present / marked) * 100) : null });
    cls.presentSum += present;
    cls.markedSum += marked;
  });

  const classes = [...classesMap.values()].map((cls) => {
    const itemsInfo = itemsByClass.get(cls.id) || { total: 0, executed: 0 };
    const notesInfo = notesByClass.get(cls.id) || { total: 0, done: 0 };
    return {
      ...cls,
      rate: cls.markedSum ? Math.round((cls.presentSum / cls.markedSum) * 100) : null,
      totalItems: itemsInfo.total,
      executedItems: itemsInfo.executed,
      notesSummary: notesInfo,
    };
  });

  return { monthLabel, generatedAt, classes };
}

async function buildMonthlyReportPdf(db, month, logoBase64) {
  registerFonts();
  const { monthLabel, generatedAt, classes } = await getMonthlyReportData(db, month);

  const doc = e(
    Document,
    { title: `التقرير الشهري - ${monthLabel}` },
    ...(classes.length
      ? classes.map((cls) => ClassPage({ logoBase64, monthLabel, generatedAt, cls, notesSummary: cls.notesSummary }))
      : [
          e(
            Page,
            { size: 'A4', style: styles.page, key: 'empty' },
            e(Text, { style: styles.kgName }, 'روضة ماما ماريا'),
            e(Text, { style: styles.reportTitle }, `التقرير الشهري — ${monthLabel}`),
            e(Text, { style: styles.notesLine }, 'لا توجد فصول أو بيانات حضور مسجّلة لهذا الشهر.')
          ),
        ])
  );

  return renderToBuffer(doc);
}

module.exports = { buildMonthlyReportPdf, getMonthlyReportData };
