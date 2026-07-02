/* Rackd write guard — component-level lockdown enforcement.
 * Usage in a screen:  if (!(await RackdGuard.assert('sale'))) return;
 * assert() calls the main-process license:assert-writable guard; if blocked it
 * shows a toast explaining why instead of failing silently. */
(function () {
  const state = { canWrite: true, reason: '' };

  // Kept in sync by licenseUi via the 'rackd:license' event.
  window.addEventListener('rackd:license', (e) => {
    const s = (e && e.detail) || {};
    state.canWrite = !s.readOnly;
    state.reason = (s.banner && s.banner.message) || s.reason || '';
  });

  function cleanMessage(err) {
    let m = err && err.message ? String(err.message) : '';
    // Electron wraps invoke errors as "... Error: <real message>"
    if (m.indexOf('Error: ') !== -1) m = m.split('Error: ').pop();
    return m || 'Action unavailable — license inactive.';
  }

  async function assert(action) {
    try {
      await window.api.licenseAssertWritable(action);
      return true;
    } catch (err) {
      const msg = cleanMessage(err);
      if (typeof showToast === 'function') showToast(msg, 'error', 4000);
      else alert(msg);
      return false;
    }
  }

  window.RackdGuard = {
    get canWrite() { return state.canWrite; },
    get reason() { return state.reason; },
    assert,
  };
})();
