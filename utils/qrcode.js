// Thin wrapper around the `qrcode` package (pure JS, no network calls —
// works fine on Render's free tier / fully offline) used to render each
// child's permanent QR token as a data: URI PNG for the printable ID card.
const QRCode = require('qrcode');

async function qrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, width: 260, color: { dark: '#26314D', light: '#FFFFFFFF' } });
}

module.exports = { qrDataUrl };
