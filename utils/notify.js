const db = require('../db');

/**
 * Create a notification for a single user.
 */
async function notify(userId, title, message, link) {
  await db.execute({
    sql: `INSERT INTO notifications (user_id, title, message, link) VALUES (@user_id, @title, @message, @link)`,
    args: { user_id: userId, title, message: message || null, link: link || null },
  });
}

/**
 * Create the same notification for a list of user ids.
 */
async function notifyMany(userIds, title, message, link) {
  const ids = (userIds || []).filter(Boolean);
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await notify(id, title, message, link);
  }
}

module.exports = { notify, notifyMany };
