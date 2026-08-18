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
const C = { primary: '#4A7CE0', primaryDark: '#3A63B8', primaryLight: '#EAF0FD', text: '#26314D', muted: '#6B7690', border: '#E7EAF3', secondary: '#3AA0A0' };

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Cairo', direction: 'rtl', fontSize: 10.5, color: C.text },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 },
  brandRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  logo: { width: 40, height: 40, borderRadius: 20 },
  kgName: { fontSize: 14, fontWeight: 'bold', textAlign: 'right' },
  receiptTitle: { fontSize: 20, fontWeight: 'bold', color: C.primaryDark, textAlign: 'left' },
  receiptNo: { fontSize: 10, color: C.muted, textAlign: 'left', marginTop: 3 },
  metaBox: { backgroundColor: '#F5F7FB', borderRadius: 10, padding: 14, marginBottom: 18 },
  metaRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 6 },
  metaLabel: { fontSize: 9.5, color: C.muted },
  metaValue: { fontSize: 10.5, fontWeight: 'bold' },
  amountBox: {
    backgroundColor: C.primaryLight, borderRadius: 10, padding: 18, alignItems: 'center', marginBottom: 18,
  },
  amountValue: { fontSize: 26, fontWeight: 'bold', color: C.primaryDark },
  amountLabel: { fontSize: 9.5, color: C.muted, marginTop: 4 },
  table: { borderWidth: 1, borderColor: C.border, borderRadius: 6, overflow: 'hidden', marginBottom: 18 },
  tRow: { flexDirection: 'row-reverse', borderTopWidth: 1, borderTopColor: C.border },
  tRowFirst: { flexDirection: 'row-reverse' },
  tCellLabel: { flex: 1, padding: '9 12', backgroundColor: '#FAFBFD', fontSize: 9.5, color: C.muted, textAlign: 'right' },
  tCellValue: { flex: 1.4, padding: '9 12', fontSize: 10, textAlign: 'right', fontWeight: 'bold' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, fontSize: 8, color: C.muted, textAlign: 'center' },
  stamp: { fontSize: 9, color: C.secondary, textAlign: 'right', marginTop: 6 },
});

function Row({ label, value, first }) {
  return e(
    View,
    { style: first ? styles.tRowFirst : styles.tRow },
    e(View, { style: styles.tCellLabel }, e(Text, null, label)),
    e(View, { style: styles.tCellValue }, e(Text, null, value))
  );
}

async function buildReceiptPdf({ receiptNumber, createdAt, childName, className, parentName, reasonLabel, methodLabel, monthLabel, amount, remaining, employeeName, logoBase64 }) {
  registerFonts();
  const doc = e(
    Document,
    { title: `وصل دفع ${receiptNumber}` },
    e(
      Page,
      { size: 'A4', style: styles.page },
      e(
        View,
        { style: styles.headerRow },
        e(
          View,
          { style: styles.brandRow },
          logoBase64 ? e(Image, { src: logoBase64, style: styles.logo }) : null,
          e(Text, { style: styles.kgName }, 'روضة ماما ماريا')
        ),
        e(
          View,
          null,
          e(Text, { style: styles.receiptTitle }, 'وصل دفع'),
          e(Text, { style: styles.receiptNo }, `رقم الوصل: ${receiptNumber}`)
        )
      ),
      e(
        View,
        { style: styles.amountBox },
        e(Text, { style: styles.amountValue }, `${Number(amount).toLocaleString('ar')} دج`),
        e(Text, { style: styles.amountLabel }, 'المبلغ المدفوع')
      ),
      e(
        View,
        { style: styles.table },
        Row({ label: 'التاريخ', value: createdAt, first: true }),
        Row({ label: 'الطفل', value: childName }),
        Row({ label: 'الفصل', value: className || '—' }),
        Row({ label: 'ولي الأمر', value: parentName || '—' }),
        Row({ label: 'السبب', value: reasonLabel }),
        monthLabel ? Row({ label: 'الشهر', value: monthLabel }) : null,
        Row({ label: 'طريقة الدفع', value: methodLabel }),
        Row({ label: 'الموظف', value: employeeName || '—' }),
        remaining !== null && remaining !== undefined
          ? Row({ label: 'الرصيد المتبقي بعد هذه الدفعة', value: `${Number(remaining).toLocaleString('ar')} دج` })
          : null
      ),
      e(Text, { style: styles.stamp }, 'تم إصدار هذا الوصل تلقائيًا من نظام روضة ماما ماريا.'),
      e(Text, { style: styles.footer }, `طُبع بتاريخ ${createdAt}`)
    )
  );
  return renderToBuffer(doc);
}

module.exports = { buildReceiptPdf };
