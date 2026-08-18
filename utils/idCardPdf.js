const path = require('path');
const React = require('react');
const { Document, Page, Text, View, Image, Font, StyleSheet, renderToBuffer } = require('@react-pdf/renderer');

// Same offline-Cairo-font approach as utils/monthlyReport.js (see the
// comment there for why this matters on Render's free tier) — duplicated
// here rather than shared because @react-pdf/renderer's Font.register is
// process-wide and idempotent-per-family-name, so re-registering from a
// second module is harmless and keeps each PDF builder self-contained.
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

const styles = StyleSheet.create({
  page: { padding: 0, fontFamily: 'Cairo', direction: 'rtl' },
  card: {
    margin: 28, borderRadius: 18, border: '2 solid #4A7CE0', padding: 22,
    height: 300, justifyContent: 'space-between',
  },
  headerRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  logo: { width: 38, height: 38, borderRadius: 19 },
  kgName: { fontSize: 13, fontWeight: 'bold', color: '#26314D', textAlign: 'right' },
  kgSub: { fontSize: 8.5, color: '#6B7690', textAlign: 'right', marginTop: 1 },
  body: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  infoCol: { flex: 1, alignItems: 'flex-end', gap: 6 },
  childName: { fontSize: 18, fontWeight: 'bold', color: '#26314D', textAlign: 'right' },
  infoLine: { fontSize: 10.5, color: '#6B7690', textAlign: 'right' },
  idBadge: {
    marginTop: 6, backgroundColor: '#EAF0FD', color: '#3A63B8', fontSize: 10, fontWeight: 'bold',
    borderRadius: 20, paddingVertical: 4, paddingHorizontal: 12, alignSelf: 'flex-end',
  },
  qr: { width: 96, height: 96 },
  footer: { fontSize: 8, color: '#99A2B8', textAlign: 'center', marginTop: 4 },
});

async function buildIdCardPdf({ child, className, qrDataUrl, logoBase64 }) {
  registerFonts();
  const doc = e(
    Document,
    { title: `بطاقة تعريف - ${child.name}` },
    e(
      Page,
      { size: 'A4', style: styles.page },
      e(
        View,
        { style: styles.card },
        e(
          View,
          { style: styles.headerRow },
          logoBase64 ? e(Image, { src: logoBase64, style: styles.logo }) : null,
          e(
            View,
            null,
            e(Text, { style: styles.kgName }, 'روضة ماما ماريا'),
            e(Text, { style: styles.kgSub }, 'بطاقة تعريف الطفل')
          )
        ),
        e(
          View,
          { style: styles.body },
          e(Image, { src: qrDataUrl, style: styles.qr }),
          e(
            View,
            { style: styles.infoCol },
            e(Text, { style: styles.childName }, child.name),
            e(Text, { style: styles.infoLine }, className ? `الفصل: ${className}` : 'غير مسجّل في فصل بعد'),
            e(Text, { style: styles.idBadge }, `الرقم التعريفي: #${String(child.id).padStart(4, '0')}`)
          )
        ),
        e(Text, { style: styles.footer }, 'يُستخدم هذا الرمز للتعرف السريع على الطفل عند الاستقبال والاستدعاء.')
      )
    )
  );
  return renderToBuffer(doc);
}

module.exports = { buildIdCardPdf };
