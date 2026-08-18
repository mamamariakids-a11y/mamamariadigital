// Shared label maps for the financial module — kept in one place so the
// wording is identical across admin finance pages, receipts, and the
// parent-facing financial view.
const METHOD_LABELS = { cash: 'نقدًا', bank_transfer: 'تحويل بنكي', ccp: 'CCP', baridimob: 'BaridiMob', other: 'أخرى' };
const REASON_LABELS = { registration: 'رسوم التسجيل', monthly: 'اشتراك شهري', transport: 'رسوم النقل', service: 'خدمة إضافية', other: 'أخرى' };
const FEE_STATUS_LABELS = { unpaid: 'غير مدفوع', partial: 'مدفوع جزئيًا', paid: 'مدفوع بالكامل', exempt: 'معفى' };
const FEE_STATUS_BADGE = { unpaid: 'badge-urgent', partial: 'badge-important', paid: 'badge-executed', exempt: 'badge-lesson' };
const FINANCE_LEVEL_LABELS = { full: 'محاسب (كامل)', accountant: 'محاسب (دخل ومصاريف)', secretary: 'سكرتيرة (تسجيل الدفعات فقط)' };

module.exports = { METHOD_LABELS, REASON_LABELS, FEE_STATUS_LABELS, FEE_STATUS_BADGE, FINANCE_LEVEL_LABELS };
