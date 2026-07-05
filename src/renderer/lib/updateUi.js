/* Rackd auto-update notifier — shows a banner when a new version is downloaded.
 * Updates also install automatically on app quit; this just offers "restart now". */
(function () {
  let bar = null;
  function ensure() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'rackd-update-bar';
    bar.style.cssText =
      'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:9997;display:none;' +
      'align-items:center;gap:12px;background:#1b1e22;color:#fff;padding:10px 16px;border-radius:10px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,0.35);font-size:14px';
    document.body.appendChild(bar);
    return bar;
  }
  function show(html) { const b = ensure(); b.innerHTML = html; b.style.display = 'flex'; }
  function hide() { if (bar) bar.style.display = 'none'; }

  function onStatus(s) {
    if (!s) return;
    if (s.state === 'ready') {
      show(
        '<span>✅ Update ' + (s.version ? 'v' + s.version + ' ' : '') + 'ready.</span>' +
        '<button id="ru-restart" style="padding:5px 12px;border:none;border-radius:6px;background:#3d8a28;color:#fff;font-weight:700;cursor:pointer">Restart to update</button>' +
        '<button id="ru-later" style="padding:5px 10px;border:1px solid rgba(255,255,255,0.3);border-radius:6px;background:transparent;color:#fff;cursor:pointer">Later</button>'
      );
      document.getElementById('ru-restart').onclick = () => window.api.updateInstall();
      document.getElementById('ru-later').onclick = hide;
    } else if (s.state === 'downloading') {
      show('<span>⬇ Downloading update… ' + (s.percent || 0) + '%</span>');
    }
  }

  if (window.api && window.api.on) window.api.on('update:status', onStatus);
})();
