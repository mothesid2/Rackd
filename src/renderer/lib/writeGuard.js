
(function () {
  const state = { canWrite: true, reason: '' };

  
  window.addEventListener('rackd:license', (e) => {
    const s = (e && e.detail) || {};
    state.canWrite = !s.readOnly;
    state.reason = (s.banner && s.banner.message) || s.reason || '';
  });

  function cleanMessage(err) {
    let m = err && err.message ? String(err.message) : '';
    
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
