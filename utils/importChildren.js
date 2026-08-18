const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');

// A dedicated (small, memory-only) upload handler just for the children
// import spreadsheet. The file is parsed immediately and never stored.
const ALLOWED = new Set(['.xlsx', '.xls', '.csv']);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED.has(ext)) return cb(null, true);
  cb(new Error('صيغة الملف غير مدعومة. يرجى استخدام ملف Excel (.xlsx) أو CSV.'));
}

const uploadImportFile = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// Minimal RFC4180-style CSV parser (handles quoted fields, escaped quotes,
// and commas/newlines inside quotes) — kept dependency-free and simple.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch === '\r') {
      // skip, handled by \n
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const HEADER_ALIASES = {
  child_name: ['اسم الطفل', 'الاسم', 'اسم الطالب', 'اسم الطفلة', 'name', 'child name', 'childname'],
  class_name: ['الفصل', 'الصف', 'الشعبة', 'class', 'classname'],
  parent_name: ['اسم ولي الأمر', 'ولي الأمر', 'اسم الأب', 'اسم الأم', 'parent name', 'parentname', 'guardian'],
  parent_email: ['بريد ولي الأمر الإلكتروني', 'بريد ولي الأمر', 'البريد الإلكتروني', 'الايميل', 'الإيميل', 'email', 'parent email'],
  parent_phone: ['هاتف ولي الأمر', 'رقم هاتف ولي الأمر', 'رقم الهاتف', 'الهاتف', 'phone', 'parent phone', 'mobile'],
};

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.richText) return v.richText.map((r) => r.text).join('');
  }
  return String(v).trim();
}

async function parseImportFile(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  let rows;

  if (ext === '.csv') {
    rows = parseCSV(buffer.toString('utf8'));
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    rows = [];
    if (sheet) {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        rows.push(row.values.slice(1).map(cellToString));
      });
    }
  }

  if (!rows.length) return { records: [], matchedColumns: [] };

  const headerRow = rows[0].map(normalizeHeader);
  const colIndex = {};
  Object.entries(HEADER_ALIASES).forEach(([key, aliases]) => {
    const normAliases = aliases.map(normalizeHeader);
    const idx = headerRow.findIndex((h) => normAliases.includes(h));
    if (idx !== -1) colIndex[key] = idx;
  });

  const get = (r, key) => (colIndex[key] !== undefined ? cellToString(r[colIndex[key]]) : '');

  const records = rows
    .slice(1)
    .map((r, i) => ({
      rowNum: i + 2,
      child_name: get(r, 'child_name'),
      class_name: get(r, 'class_name'),
      parent_name: get(r, 'parent_name'),
      parent_email: get(r, 'parent_email').toLowerCase(),
      parent_phone: get(r, 'parent_phone'),
    }))
    .filter((r) => r.child_name || r.class_name || r.parent_name || r.parent_email)
    // Ignore the template's own example row if the admin left it in place.
    .filter((r) => r.parent_email !== 'ahmed.mohamed@example.com');

  return { records, matchedColumns: Object.keys(colIndex) };
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

module.exports = { uploadImportFile, parseImportFile, randomPassword };
