const db = require('../db');

/**
 * Records a sensitive operation (payment voided, discount granted, health
 * record edited, child delivered to a pickup person, expense recorded...)
 * into the permanent audit_log table. Never fails the calling request — a
 * logging problem should not block the underlying operation, so errors are
 * swallowed after being printed to the server console.
 *
 * @param {object} user   req.session.user (or null for system actions)
 * @param {string} action e.g. 'payment.void', 'health.update', 'pickup.deliver'
 * @param {object} [opts]
 * @param {string} [opts.entityType]
 * @param {number|string} [opts.entityId]
 * @param {object|string} [opts.details] serialized as JSON if an object
 */
async function logAudit(user, action, opts = {}) {
  try {
    const details = opts.details && typeof opts.details === 'object' ? JSON.stringify(opts.details) : opts.details || null;
    await db.execute({
      sql: `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, details)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [user ? user.id : null, user ? user.name : 'النظام', action, opts.entityType || null, opts.entityId || null, details],
    });
  } catch (err) {
    console.error('تعذر تسجيل العملية في سجل العمليات:', err);
  }
}

module.exports = { logAudit };
