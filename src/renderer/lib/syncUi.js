/* Rackd connectivity indicator.
 * - Polls sync:status every 15s (and on sync:status pushes).
 * - Corner dot: green (online + recent sync), yellow (online but pending > 10 or
 *   last sync > 5 min ago), red (offline), gray (cloud sync inactive).
 * - Hover tooltip: last synced / pending / dead letters. Click triggers a sync. */
(function () {
  const POLL_MS = 15000;
  let dot = null;
  let tip = null;

  function ensure() {
    if (dot) return;
    dot = document.createElement('div');
    dot.id = 'rackd-sync-dot';
    dot.style.cssText =
      'position:fixed;bottom:12px;right:12px;width:14px;height:14px;border-radius:50%;' +
      'z-index:9998;cursor:pointer;box-shadow:0 0 0 3px rgba(0,0,0,0.15);transition:background .2s';
    tip = document.createElement('div');
    tip.style.cssText =
      'position:fixed;bottom:34px;right:12px;z-index:9998;background:rgba(20,22,26,0.96);' +
      'color:#fff;font-size:12px;line-height:1.5;padding:8px 10px;border-radius:6px;display:none;' +
      'white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,0.3)';
    dot.addEventListener('mouseenter', () => (tip.style.display = 'block'));
    dot.addEventListener('mouseleave', () => (tip.style.display = 'none'));
    dot.addEventListener('click', async () => {
      dot.style.opacity = '0.5';
      try { await window.api.syncTrigger(); } catch (e) { /* ignore */ }
      await poll();
      dot.style.opacity = '1';
    });
    document.body.appendChild(dot);
    document.body.appendChild(tip);
  }

  function ago(iso) {
    if (!iso) return 'never';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function render(s) {
    ensure();
    const pending = s.pending_sync_count || 0;
    const dead = s.dead_letter_count || 0;
    const last = s.last_sync_succeeded_at;
    const stale = !last || Date.now() - new Date(last).getTime() > 5 * 60 * 1000;

    let color;
    if (!s.last_sync_attempted_at) color = '#888'; // cloud sync inactive
    else if (!s.is_online) color = '#a02020'; // red — offline
    else if (pending > 10 || stale) color = '#c98a1a'; // yellow
    else color = '#3d8a28'; // green

    dot.style.background = color;
    const escFn = typeof esc === 'function' ? esc : (x) => x;
    tip.innerHTML =
      'Last synced: ' + escFn(ago(last)) + '<br>' +
      'Pending: ' + pending + ' records<br>' +
      'Dead letters: ' + dead;
  }

  async function poll() {
    try {
      const res = await window.api.syncStatus();
      if (res && res.status) render(res.status);
    } catch (e) { /* ignore */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    poll();
    setInterval(poll, POLL_MS);
  });
  if (window.api && window.api.on) window.api.on('sync:status', () => poll());
})();
