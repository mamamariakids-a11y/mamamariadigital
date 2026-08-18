// روضة ماما ماريا — سلوكيات الواجهة العامة
(function () {
  const bellBtn = document.getElementById('bellBtn');
  const dropdown = document.getElementById('notifDropdown');
  const notifList = document.getElementById('notifList');

  function timeAgo(dateStr) {
    const diff = (Date.now() - new Date(dateStr.replace(' ', 'T') + 'Z').getTime()) / 1000;
    if (diff < 60) return 'الآن';
    if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
    if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
    return `منذ ${Math.floor(diff / 86400)} يوم`;
  }

  async function loadRecentNotifications() {
    try {
      const res = await fetch('/notifications/recent');
      const data = await res.json();
      if (!data.items || !data.items.length) {
        notifList.innerHTML = '<div class="notif-empty">لا توجد إشعارات بعد</div>';
        return;
      }
      notifList.innerHTML = data.items
        .map(
          (n) => `
        <div class="notif-item">
          <div class="nt">${escapeHtml(n.title)}</div>
          ${n.message ? `<div class="nm">${escapeHtml(n.message)}</div>` : ''}
          <div class="nd">${timeAgo(n.created_at)}</div>
        </div>`
        )
        .join('');
    } catch (e) {
      notifList.innerHTML = '<div class="notif-empty">تعذر تحميل الإشعارات</div>';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  if (bellBtn) {
    bellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
      if (dropdown.classList.contains('open')) loadRecentNotifications();
    });
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== bellBtn) {
        dropdown.classList.remove('open');
      }
    });

    async function pollUnread() {
      try {
        const res = await fetch('/notifications/unread-count');
        const data = await res.json();
        bellBtn.classList.toggle('has-unread', data.count > 0);
      } catch (e) {
        /* ignore */
      }
    }
    setInterval(pollUnread, 30000);
  }

  // Checkbox pill visual state (class selection in item form)
  document.querySelectorAll('.checkbox-pill input[type=checkbox]').forEach((cb) => {
    const pill = cb.closest('.checkbox-pill');
    if (cb.checked) pill.classList.add('checked');
    cb.addEventListener('change', () => pill.classList.toggle('checked', cb.checked));
  });

  // File input preview label
  document.querySelectorAll('input[type=file]').forEach((input) => {
    const label = input.parentElement.querySelector('.file-label-text');
    if (!label) return;
    input.addEventListener('change', () => {
      label.textContent = input.files.length ? `${input.files.length} ملف/ملفات محددة` : label.dataset.default;
    });
  });
})();
