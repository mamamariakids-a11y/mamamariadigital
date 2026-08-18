// روضة ماما ماريا — تنبيه صوتي عند اقتراب وقت تنفيذ ملاحظة الأولياء
// يعمل فقط في الصفحات التي تحتوي على العناصر أدناه (مثل ملاحظات المربية).
(function () {
  const root = document.getElementById('noteAlerts');
  const dataEl = document.getElementById('noteAlertsData');
  if (!root || !dataEl) return;

  let notes = [];
  try {
    notes = JSON.parse(dataEl.textContent || '[]');
  } catch (e) {
    notes = [];
  }
  if (!notes.length) return;

  const toggleBtn = document.getElementById('noteSoundToggle');
  const banner = document.getElementById('noteAlertBanner');
  const list = document.getElementById('noteAlertList');
  const originalTitle = document.title;

  function soundEnabled() {
    return sessionStorage.getItem('noteSoundEnabled') === '1';
  }

  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      [880, 660].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = now + i * 0.28;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.26);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.28);
      });
    } catch (e) {
      /* بعض المتصفحات تمنع الصوت قبل أي تفاعل من المستخدم — لا مشكلة، التنبيه المرئي يبقى ظاهرًا */
    }
  }

  function updateToggleLabel() {
    if (!toggleBtn) return;
    if (soundEnabled()) {
      toggleBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i> التنبيه الصوتي مُفعّل';
      toggleBtn.classList.remove('btn-secondary');
      toggleBtn.classList.add('btn-success');
    } else {
      toggleBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i> فعّلي التنبيه الصوتي';
      toggleBtn.classList.remove('btn-success');
      toggleBtn.classList.add('btn-secondary');
    }
  }

  if (toggleBtn) {
    updateToggleLabel();
    toggleBtn.addEventListener('click', () => {
      sessionStorage.setItem('noteSoundEnabled', '1');
      beep();
      updateToggleLabel();
    });
  }

  function targetFor(note, now) {
    if (!note.note_time) return null;
    let dateStr = note.note_date;
    if (note.note_type === 'permanent') {
      // الملاحظة الدائمة تتكرر كل يوم في نفس الوقت المحدد
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      dateStr = `${y}-${m}-${d}`;
    }
    if (!dateStr) return null;
    const t = new Date(`${dateStr}T${note.note_time}:00`);
    return isNaN(t.getTime()) ? null : t;
  }

  function fmtRemaining(diffMin) {
    const abs = Math.abs(Math.round(diffMin));
    if (diffMin > 0) return `بعد ${abs} دقيقة`;
    if (abs < 1) return 'الآن';
    return `متأخرة ${abs} دقيقة`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function check() {
    const now = new Date();
    const due = [];
    notes.forEach((n) => {
      const target = targetFor(n, now);
      if (!target) return;
      const diffMin = (target - now) / 60000;
      // نطاق التنبيه: من 10 دقائق قبل الموعد وحتى ساعة كاملة بعده (لتفادي تنبيه متأخر لساعات طويلة)
      if (diffMin <= 10 && diffMin >= -60) {
        due.push({ note: n, diffMin });
      }
    });

    if (!due.length) {
      if (banner) banner.style.display = 'none';
      document.title = originalTitle;
      return;
    }

    due.sort((a, b) => a.diffMin - b.diffMin);
    if (banner) banner.style.display = 'flex';
    if (list) {
      list.innerHTML = due
        .map(
          (d) =>
            `<div class="note-alert-item">🔔 <b>${escapeHtml(d.note.child_name)}</b> — ${escapeHtml(d.note.content)} <span class="note-alert-time">(${fmtRemaining(d.diffMin)})</span></div>`
        )
        .join('');
    }
    document.title = `🔔 (${due.length}) ${originalTitle}`;

    if (soundEnabled()) {
      const last = Number(localStorage.getItem('noteAlertLastPlayed') || 0);
      if (Date.now() - last > 3 * 60 * 1000) {
        beep();
        localStorage.setItem('noteAlertLastPlayed', String(Date.now()));
      }
    }
  }

  check();
  setInterval(check, 20000);
})();
