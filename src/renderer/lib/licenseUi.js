
(function () {
  const POLL_MS = 30000;
  let bannerEl = null;

  function ensureBanner() {
    if (bannerEl) return bannerEl;
    bannerEl = document.createElement('div');
    bannerEl.id = 'rackd-license-banner';
    bannerEl.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
      'display:none', 'align-items:center', 'justify-content:center', 'gap:12px',
      'padding:10px 18px', 'font-size:14px', 'font-weight:600', 'text-align:center',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
    ].join(';');
    document.body.appendChild(bannerEl);
    return bannerEl;
  }

  function render(status) {
    const el = ensureBanner();
    const level = (status.banner && status.banner.level) || 'none';
    const message = (status.banner && status.banner.message) || '';

    if (level === 'none' || !message) {
      el.style.display = 'none';
      document.body.style.paddingTop = '';
      return;
    }

    el.style.background = level === 'warning' ? '#b45309' : '#a02020';
    el.style.color = '#fff';
    el.innerHTML = '';

    const icon = document.createElement('span');
    icon.textContent = level === 'warning' ? '⚠' : '🔒';
    const txt = document.createElement('span');
    txt.textContent = message;
    el.appendChild(icon);
    el.appendChild(txt);

    if (status.readOnly) {
      const btn = document.createElement('button');
      btn.textContent = 'Retry';
      btn.style.cssText =
        'margin-left:10px;padding:4px 12px;border:1px solid rgba(255,255,255,0.6);' +
        'background:rgba(255,255,255,0.15);color:#fff;border-radius:5px;cursor:pointer;font-weight:600';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Checking…';
        try { await window.api.licenseRefresh(); } catch (e) {  }
        await poll();
      };
      el.appendChild(btn);
    }

    el.style.display = 'flex';
    document.body.style.paddingTop = (el.offsetHeight || 42) + 'px';
  }

  function applyLockdown(readOnly) {
    document.querySelectorAll('[data-write-action]').forEach((node) => {
      if (readOnly && !node.dataset.rackdLocked) {
        node.dataset.rackdLocked = '1';
        node.dataset.rackdPrevDisabled = node.disabled ? '1' : '0';
        node.disabled = true;
        node.classList.add('rackd-locked');
        node.setAttribute('title', 'Read-only — license inactive');
        if (node.tagName === 'BUTTON' && !node.querySelector('.rackd-lock-icon')) {
          const i = document.createElement('span');
          i.className = 'rackd-lock-icon';
          i.textContent = ' 🔒';
          node.appendChild(i);
        }
      } else if (!readOnly && node.dataset.rackdLocked) {
        delete node.dataset.rackdLocked;
        node.disabled = node.dataset.rackdPrevDisabled === '1';
        node.classList.remove('rackd-locked');
        node.removeAttribute('title');
        const i = node.querySelector('.rackd-lock-icon');
        if (i) i.remove();
      }
    });
  }

  async function poll() {
    try {
      const res = await window.api.licenseStatus();
      const status = res && res.status;
      if (!status) return;
      window.__rackdLicense = status;
      window.dispatchEvent(new CustomEvent('rackd:license', { detail: status }));
      render(status);
      applyLockdown(!!status.readOnly);
    } catch (e) {  }
  }

  document.addEventListener('DOMContentLoaded', () => {
    poll();
    setInterval(poll, POLL_MS);
  });
  if (window.api && window.api.on) window.api.on('sync:status', () => poll());
})();
