const path = require('path');
const React = require('react');
const { Document, Page, Text, View, Image, Font, StyleSheet, renderToBuffer } = require('@react-pdf/renderer');

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
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

const e = React.createElement;
const C = { primary: '#4A7CE0', primaryDark: '#3A63B8', primaryLight: '#EAF0FD', text: '#26314D', muted: '#6B7690', border: '#E7EAF3', secondary: '#3AA0A0', danger: '#D9634F' };

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Cairo', direction: 'rtl', fontSize: 10.5, color: C.text },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 },
  brandRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  logo: { width: 40, height: 40, borderRadius: 20 },
  kgName: { fontSize: 14, fontWeight: 'bold', textAlign: 'right' },
  title: { fontSize: 18, fontWeight: 'bold', color: C.primaryDark, textAlign: 'left' },
  sub: { fontSize: 10, color: C.muted, textAlign: 'left', marginTop: 3 },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 11, fontWeight: 'bold', marginBottom: 8, color: C.primaryDark },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border },
  label: { fontSize: 10, color: C.muted },
  value: { fontSize: 10.5, fontWeight: 'bold' },
  totalBox: { backgroundColor: C.primaryLight, borderRadius: 10, padding: 16, marginTop: 6, flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { fontSize: 11, fontWeight: 'bold', color: C.primaryDark },
  totalValue: { fontSize: 20, fontWeight: 'bold' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, fontSize: 8, color: C.muted, textAlign: 'center' },
});

function Row({ label, value }) {
  return e(View, { style: styles.row }, e(Text, { style: styles.label }, label), e(Text, { style: styles.value }, value));
}

async function buildProfitLossPdf({ month, monthLabel, incomeByReason, expensesByCategory, totalIncome, totalExpenses, logoBase64, generatedAt }) {
  registerFonts();
  const net = totalIncome - totalExpenses;
  const doc = e(
    Document,
    { title: `التقرير المالي المبسط ${month}` },
    e(
      Page,
      { size: 'A4', style: styles.page },
      e(
        View,
        { style: styles.headerRow },
        e(View, { style: styles.brandRow }, logoBase64 ? e(Image, { src: logoBase64, style: styles.logo }) : null, e(Text, { style: styles.kgName }, 'روضة ماما ماريا')),
        e(View, null, e(Text, { style: styles.title }, 'التقرير المالي المبسط'), e(Text, { style: styles.sub }, monthLabel))
      ),
      e(
        View,
        { style: styles.section },
        e(Text, { style: styles.sectionTitle }, 'الإيرادات حسب النوع'),
        ...incomeByReason.map((r) => Row({ label: r.label, value: `${Number(r.amount).toLocaleString('ar')} دج` }))
      ),
      e(
        View,
        { style: styles.section },
        e(Text, { style: styles.sectionTitle }, 'المصاريف حسب الفئة'),
        ...expensesByCategory.map((x) => Row({ label: x.label, value: `${Number(x.amount).toLocaleString('ar')} دج` }))
      ),
      e(
        View,
        { style: styles.totalBox },
        e(Text, { style: styles.totalLabel }, net >= 0 ? 'صافي الربح' : 'صافي الخسارة'),
        e(Text, { style: [styles.totalValue, { color: net >= 0 ? C.secondary : C.danger }] }, `${Math.abs(net).toLocaleString('ar')} دج`)
      ),
      e(Text, { style: styles.footer }, `تم إصدار هذا التقرير تلقائيًا من نظام روضة ماما ماريا بتاريخ ${generatedAt}`)
    )
  );
  return renderToBuffer(doc);
}

module.exports = { buildProfitLossPdf };
