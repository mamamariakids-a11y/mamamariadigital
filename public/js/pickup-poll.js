// Polls the pickup queue every few seconds so reception/admin/director see
// new "أنا أمام الروضة" requests from any number of simultaneous parents
// without needing to refresh manually. Rather than silently re-rendering the
// whole list (which would wipe out a delivered_to_name field someone is
// mid-typing), it shows a small "طلبات جديدة" banner the staff member clicks
// when ready — the underlying data is always safe (each request is its own
// row), this is purely about not disrupting an in-progress action.
(function () {
  const banner = document.getElementById('pickupNewBanner');
  const countBadge = document.getElementById('pickupPendingCount');
  if (!countBadge) return; // not on the queue page

  const knownIds = new Set(
    Array.from(document.querySelectorAll('[data-pickup-id]')).map((el) => el.dataset.pickupId)
  );

  async function poll() {
    try {
      const res = await fetch('/pickup/queue.json');
      const data = await res.json();
      const hasNew = data.pending.some((p) => !knownIds.has(String(p.id)));
      if (hasNew && banner) banner.style.display = 'flex';
      countBadge.textContent = data.pending.length;
    } catch (e) {
      /* ignore transient network errors — next poll will retry */
    }
  }

  setInterval(poll, 5000);
})();
