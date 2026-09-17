

(function (global) {
  'use strict';

  
  
  
  
  
  function fadeIn(el) {
    if (!el) return;
    el.classList.remove('ru-fade-in');
    void el.offsetWidth;
    el.classList.add('ru-fade-in');
  }

  
  
  
  
  
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

  
  
  
  
  
  
  const tooltip = (function () {
    const SHOW_DELAY = 400; 
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

      
      let side = 'top';
      let top = tr.top - br.height - pad;
      if (top < pad) { side = 'bottom'; top = tr.bottom + pad; }
      if (side === 'bottom' && top + br.height > vh - pad) {
        
        top = Math.max(pad, vh - br.height - pad);
      }

      let left = tr.left + tr.width / 2 - br.width / 2;
      left = Math.max(pad, Math.min(left, vw - br.width - pad));

      
      
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

      
      
      el.addEventListener('mouseenter', () => {
        clearTimeout(showTimer);
        showTimer = setTimeout(() => place(el), SHOW_DELAY);
      });
      el.addEventListener('mouseleave', hide);
      el.addEventListener('mousedown', hide);

      
      
      
      el.addEventListener('focus', () => place(el));
      el.addEventListener('blur', hide);

      
      
      
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
          
          
          
          const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); el.removeEventListener('click', swallow, true); };
          el.addEventListener('click', swallow, true);
          setTimeout(hide, 1200);
        }
      });
    }

    function init(root) {
      const scope = root || document;
      if (scope.matches && scope.matches('[data-tooltip]')) bind(scope);
      scope.querySelectorAll('[data-tooltip]').forEach(bind);
    }

    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);

    
    
    
    
    
    
    
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            init(node);
          }
        }
      });
      const start = () => observer.observe(document.body, { childList: true, subtree: true });
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
    }
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', () => init());

    return { init, hide };
  })();

  
  
  
  
  
  
  
  
  const cache = (function () {
    const store = new Map(); 

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
