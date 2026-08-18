const path = require('path');
const multer = require('multer');

// Files are kept in memory (never written to disk) and the route handlers
// convert them to base64 and store them directly inside the database row
// (see routes/director.js and routes/teacher.js). This means there is no
// local/persistent-disk dependency at all for uploads — everything lives in
// the same place as the rest of the data (Turso in production, or the local
// SQLite file during development).
const ALLOWED = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx', '.ppt', '.pptx',
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED.has(ext)) return cb(null, true);
  cb(new Error('نوع الملف غير مدعوم'));
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  // Kept modest since files are stored as base64 text inside the database
  // (free database tiers have a total storage budget, not per-file).
  limits: { fileSize: 4 * 1024 * 1024, files: 8 },
});

// Converts a multer in-memory file into the {name, mime, size, data} shape
// stored in items.attachments / item_assignments.execution_photos.
function fileToRecord(file) {
  return {
    id: 'a' + Date.now() + Math.random().toString(36).slice(2, 8),
    name: file.originalname,
    mime: file.mimetype,
    size: file.size,
    data: file.buffer.toString('base64'),
  };
}

module.exports = upload;
module.exports.fileToRecord = fileToRecord;
