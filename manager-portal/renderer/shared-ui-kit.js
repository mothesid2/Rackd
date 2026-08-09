/* AUTO-GENERATED — do not edit directly. Source: shared-ui/kit.js — run `npm run sync:ui` after changing it there. */
/* ============================================================================
 * Rackd shared UI kit — JS half. Vanilla, zero dependencies (matches how
 * shared.js already works in this codebase — no bundler in any of the three
 * Electron renderers).
 *
 * SOURCE OF TRUTH: edit this file, then run `node scripts/sync-shared-ui.js`
 * to copy it into src/renderer/, manager-portal/renderer/, and
 * owner-console/renderer/ (see kit.css header for why three copies exist).
 *
 * Everything hangs off one global, RackdUI, to stay consistent with this
 * app's existing style of globals (showToast, esc, fmt, navigate, etc. in
 * shared.js) rather than introducing a module system these plain <script>
 * tags don't use.
 * ==========================================================================*/
(function (global) {
  'use strict';

  // Restart the .ru-fade-in animation on `el` (adding the class again when
  // it's already present is a no-op in the DOM, so this forces a reflow
  // in between) — the one-line idiom every "swap skeleton for real content"
  // callsite needs, since screens here just do view.innerHTML = `...` rather
  // than mount/unmount.
  function fadeIn(el) {
    if (!el) return;
    el.classList.remove('ru-fade-in');
    void el.offsetWidth;
    el.classList.add('ru-fade-in');
  }

  // ── Skeleton loaders ──────────────────────────────────────────────────
  // Build detached DOM the caller inserts; caller swaps it out for real
  // content (and adds .ru-fade-in to the real content) once data arrives.
  // Kept as plain DOM builders rather than a render/diff system since every
  // screen in this app already does manual innerHTML/DOM work.
  const skeleton = {
    row(count) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const row = document.createElement('div');
        row.className = 'ru-skel-row';
        row.innerHTML =
          '<div class="ru-skel ru-skel-circle" style="width:32px;height:32px"></div>' +
          '<div style="flex:1"><div class="ru-skel ru-skel-text ru-w-60"></div><div class="ru-skel ru-skel-text ru-w-40"></div></div>' +
          '<div class="ru-skel ru-skel-text" style="width:60px;height:16px"></div>';
        frag.appendChild(row);
      }
      return frag;
    },
    card(count) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const card = document.createElement('div');
        card.className = 'ru-skel-card';
        card.innerHTML =
          '<div class="ru-skel"></div>' +
          '<div class="ru-skel ru-skel-text ru-w-80"></div>' +
          '<div class="ru-skel ru-skel-text ru-w-40"></div>';
        frag.appendChild(card);
      }
      return frag;
    },
    grid(count) {
      const wrap = document.createElement('div');
      wrap.className = 'ru-skel-grid';
      wrap.appendChild(skeleton.card(count));
      return wrap;
    },
    /** HTML-string variants — Manager Portal / Owner Console screens build
     * their whole view via `view.innerHTML = \`...\`` rather than DOM
     * builders, so a fragment-returning helper isn't directly usable there. */
    cardsHtml(count) {
      let html = '<div class="ru-skel-grid">';
      for (let i = 0; i < count; i++) {
        html += '<div class="ru-skel-card"><div class="ru-skel"></div><div class="ru-skel ru-skel-text ru-w-80"></div><div class="ru-skel ru-skel-text ru-w-40"></div></div>';
      }
      return html + '</div>';
    },
    rowsHtml(count) {
      let html = '';
      for (let i = 0; i < count; i++) {
        html +=
          '<div class="ru-skel-row">' +
          '<div class="ru-skel ru-skel-circle" style="width:32px;height:32px"></div>' +
          '<div style="flex:1"><div class="ru-skel ru-skel-text ru-w-60"></div><div class="ru-skel ru-skel-text ru-w-40"></div></div>' +
          '<div class="ru-skel ru-skel-text" style="width:60px;height:16px"></div>' +
          '</div>';
      }
      return html;
    },
    /** HTML-string variant for data tables (`tbody.innerHTML = ...` is how
     * every table screen in this app already renders rows). */
    tableRowsHtml(colspan, count) {
      const widths = ['70%', '45%', '85%', '55%', '35%'];
      let html = '';
      for (let i = 0; i < count; i++) {
        let cells = '';
        for (let c = 0; c < colspan; c++) {
          cells += `<td><div class="ru-skel ru-skel-text" style="width:${widths[(i + c) % widths.length]};margin:0"></div></td>`;
        }
        html += `<tr class="ru-no-hover">${cells}</tr>`;
      }
      return html;
    },
    text(lines) {
      const frag = document.createDocumentFragment();
      const widths = ['ru-w-100', 'ru-w-80', 'ru-w-60'];
      for (let i = 0; i < lines; i++) {
        const t = document.createElement('div');
        t.className = 'ru-skel ru-skel-text ' + widths[Math.min(i, widths.length - 1)];
        frag.appendChild(t);
      }
      return frag;
    },
    /**
     * Convenience: render a skeleton into `container` immediately, call
     * `loadFn()`, then replace the skeleton with whatever `renderFn(data)`
     * produces (crossfaded in via .ru-fade-in). Any screen can keep doing
     * its own thing instead — this just covers the common
     * "loading -> list" shape so it isn't rewritten per screen.
     */
    async during(container, kind, count, loadFn, renderFn) {
      container.innerHTML = '';
      const built = kind === 'card' ? skeleton.grid(count) : kind === 'text' ? skeleton.text(count) : skeleton.row(count);
      container.appendChild(built);
      try {
        const data = await loadFn();
        container.innerHTML = '';
        const out = renderFn(data);
        if (out != null) {
          if (typeof out === 'string') container.innerHTML = out;
          else container.appendChild(out);
        }
        fadeIn(container);
        return data;
      } catch (err) {
        container.innerHTML = '';
        throw err;
      }
    },
  };

  // ── Tooltips ──────────────────────────────────────────────────────────
  // Auto-attaches to any element with a `data-tooltip` attribute — screens
  // don't need to call anything per-control, just add the attribute (and
  // ru-icon-btn / aria-label as appropriate) and call RackdUI.tooltip.init()
  // once after their content renders (safe to call repeatedly; it only
  // binds listeners it hasn't bound yet, tracked via a WeakSet).
  const tooltip = (function () {
    const SHOW_DELAY = 400; // ms — inside the spec's 300-500ms band
    const bound = new WeakSet();
    let bubble = null;
    let showTimer = null;
    let holdTimer = null;
    let current = null;

    function ensureBubble() {
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'ru-tooltip';
        bubble.setAttribute('role', 'tooltip');
        document.body.appendChild(bubble);
      }
      return bubble;
    }

    function place(target) {
      const b = ensureBubble();
      const text = target.getAttribute('data-tooltip');
      if (!text) return;
      b.textContent = text;
      b.style.left = '0px';
      b.style.top = '0px';
      b.classList.add('ru-tooltip-visible');

      const pad = 8;
      const tr = target.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Prefer above the target; flip below if it would clip the top edge.
      let side = 'top';
      let top = tr.top - br.height - pad;
      if (top < pad) { side = 'bottom'; top = tr.bottom + pad; }
      if (side === 'bottom' && top + br.height > vh - pad) {
        // Neither vertical side fits (very short viewport) — pin to whichever clips less.
        top = Math.max(pad, vh - br.height - pad);
      }

      let left = tr.left + tr.width / 2 - br.width / 2;
      left = Math.max(pad, Math.min(left, vw - br.width - pad));

      // Arrow follows the target's horizontal center even after the bubble
      // itself got clamped to stay on-screen.
      const arrowX = Math.max(10, Math.min(tr.left + tr.width / 2 - left, br.width - 10));
      b.style.setProperty('--ru-arrow-x', arrowX + 'px');
      b.setAttribute('data-ru-side', side);
      b.style.left = left + 'px';
      b.style.top = top + 'px';
      current = target;
    }

    function hide() {
      clearTimeout(showTimer);
      clearTimeout(holdTimer);
      showTimer = null;
      holdTimer = null;
      current = null;
      if (bubble) bubble.classList.remove('ru-tooltip-visible');
    }

    function bind(el) {
      if (bound.has(el)) return;
      bound.add(el);
      if (!el.hasAttribute('aria-label') && !el.textContent.trim()) {
        el.setAttribute('aria-label', el.getAttribute('data-tooltip') || '');
      }

      // Mouse / trackpad: show after a delay so a quick pointer pass-over
      // never flashes it; cancel immediately on leave.
      el.addEventListener('mouseenter', () => {
        clearTimeout(showTimer);
        showTimer = setTimeout(() => place(el), SHOW_DELAY);
      });
      el.addEventListener('mouseleave', hide);
      el.addEventListener('mousedown', hide);

      // Keyboard focus: show/hide immediately, no delay — a sighted keyboard
      // user tabbing through controls shouldn't wait for a hover timer that
      // was never meant for them.
      el.addEventListener('focus', () => place(el));
      el.addEventListener('blur', hide);

      // Touch: tap-and-hold (~450ms) shows it; releasing, scrolling, or
      // tapping elsewhere dismisses it. A plain tap still fires the
      // control's own click as normal — this only intercepts a HELD touch.
      let touchMoved = false;
      el.addEventListener('touchstart', (e) => {
        touchMoved = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
          if (!touchMoved) { place(el); if (navigator.vibrate) navigator.vibrate(8); }
        }, 450);
      }, { passive: true });
      el.addEventListener('touchmove', () => { touchMoved = true; clearTimeout(holdTimer); }, { passive: true });
      el.addEventListener('touchend', () => {
        clearTimeout(holdTimer);
        if (current === el) {
          // Tooltip was showing from a hold — swallow the click that would
          // otherwise fire on release so a long-press doesn't ALSO trigger
          // the button underneath.
          const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); el.removeEventListener('click', swallow, true); };
          el.addEventListener('click', swallow, true);
          setTimeout(hide, 1200);
        }
      });
    }

    function init(root) {
      const scope = root || document;
      scope.querySelectorAll('[data-tooltip]').forEach(bind);
    }

    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);

    return { init, hide };
  })();

  // ── Session cache ─────────────────────────────────────────────────────
  // WITHIN-SESSION only — this is not a replacement for or extension of the
  // local SQLite + Supabase sync in src/main/supabase/sync.ts, which stays
  // the offline source of truth. This just avoids re-fetching/re-rendering
  // the same read (product catalog, store settings, employee list) every
  // time a screen is revisited in one running session. Cleared on reload;
  // invalidate() must be called explicitly after any mutation that changes
  // the underlying data — there is no polling or background refresh.
  const cache = (function () {
    const store = new Map(); // key -> { value, expires }

    function get(key, fetcher, ttlMs) {
      const hit = store.get(key);
      if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
      const p = Promise.resolve(fetcher()).then((value) => {
        store.set(key, { value, expires: Date.now() + (ttlMs || 60000) });
        return value;
      });
      return p;
    }
    function invalidate(key) { store.delete(key); }
    function invalidatePrefix(prefix) {
      for (const k of store.keys()) if (k.indexOf(prefix) === 0) store.delete(k);
    }
    function clear() { store.clear(); }

    return { get, invalidate, invalidatePrefix, clear };
  })();

  // ── Optimistic UI ─────────────────────────────────────────────────────
  // applyFn() runs synchronously and immediately (the UI already reflects
  // the expected outcome). commitFn() then does the real IPC/network call in
  // the background; if it rejects or resolves { success:false }, rollbackFn()
  // undoes the optimistic change and a toast reports the failure. The three
  // apps each already have their own toast function under a different name
  // (POS: showToast(msg, type, duration); Manager Portal + Owner Console:
  // toast(msg, isErr)) — reuse whichever exists rather than adding a fourth.
  //
  // NOT for payment confirmation, final order submission, or anything else
  // where a false-positive "done" is unacceptable — callers must not wrap
  // those actions with this helper. See the fleet-wide report for the
  // specific list of what was deliberately excluded.
  function reportError(message) {
    if (typeof showToast === 'function') showToast(message, 'error');
    else if (typeof toast === 'function') toast(message, true);
  }
  async function optimistic(el, applyFn, commitFn, rollbackFn, errorMessage) {
    applyFn();
    if (el) el.classList.add('ru-optimistic-pending');
    try {
      const result = await commitFn();
      if (result && result.success === false) throw new Error(result.error || 'error');
      if (el) el.classList.remove('ru-optimistic-pending');
      return result;
    } catch (err) {
      if (el) {
        el.classList.remove('ru-optimistic-pending');
        el.classList.add('ru-optimistic-rollback');
        setTimeout(() => el.classList.remove('ru-optimistic-rollback'), 500);
      }
      rollbackFn();
      reportError(errorMessage || (err && err.message) || 'Something went wrong — change was undone');
      throw err;
    }
  }

  global.RackdUI = { skeleton, tooltip, cache, optimistic, fadeIn };
})(window);
