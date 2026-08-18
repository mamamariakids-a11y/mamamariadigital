// Shared label maps for the daily report feature (meals / nap / mood),
// reused by the teacher form, the parent feed, and the admin oversight view
// so the wording stays consistent everywhere.
const MEAL_LABELS = { all: 'أكل الوجبة كاملة', some: 'أكل جزءًا من الوجبة', none: 'لم يأكل' };
const NAP_LABELS = { yes: 'نام', no: 'لم ينم' };
const MOOD_LABELS = { happy: '😊 سعيد', normal: '😐 عادي', tired: '😴 متعب', upset: '😢 منزعج' };
const MOOD_ICONS = { happy: '😊', normal: '😐', tired: '😴', upset: '😢' };

module.exports = { MEAL_LABELS, NAP_LABELS, MOOD_LABELS, MOOD_ICONS };
