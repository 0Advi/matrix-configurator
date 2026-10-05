// Storage bridge: connects the v5 configurator's localStorage persistence to the web
// server (and through it, NocoBase). Must run BEFORE the configurator mounts, because the
// v5 constructor reads localStorage['wsconfig_v5_custom'] synchronously.
//
//   const bridge = await startBridge();   // hydrates localStorage, installs the interceptor
//   ...then boot the dc runtime (boot.js)
//
// Never throws and never blocks longer than the request timeouts: if the server or NocoBase
// is down the app runs exactly like the original artifact (localStorage only).
import { STORAGE_KEY, statusText } from './bridge-core.js';
import { createSyncEngine } from './sync-engine.js';

function safeLocalStorage() {
  try {
    const s = window.localStorage;
    const probe = '__cfg_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

// Wrap Storage.prototype.setItem (assigning localStorage.setItem would create a stored item
// called "setItem"): v5 writes are passed through untouched, then reported to the engine.
function installInterceptor(storage, onWrite) {
  const proto = Object.getPrototypeOf(storage);
  if (proto.__cfgBridgeWrapped) return;
  const original = proto.setItem;
  const wrapped = function setItem(key, value) {
    const r = original.call(this, key, value);
    if (this === storage && String(key) === STORAGE_KEY) {
      try { onWrite(); } catch (e) { console.warn('[cfg-bridge] write hook failed', e); }
    }
    return r;
  };
  Object.defineProperty(proto, 'setItem', { value: wrapped, configurable: true, writable: true, enumerable: true });
  Object.defineProperty(proto, '__cfgBridgeWrapped', { value: true, configurable: true });
}

// ---------- status pill ----------
const COLORS = { saved: '#4FC3A1', saving: '#6E9BFF', pending: '#6E9BFF', booting: '#6E7382', local: '#E8B65A', error: '#FF6B6B', conflict: '#FF6B6B', stale: '#E8B65A' };

function createPill() {
  const el = document.createElement('button');
  el.type = 'button';
  el.id = 'cfg-sync-pill';
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('data-nopan', '1');
  el.style.cssText = [
    'position:fixed', 'left:12px', 'bottom:40px', 'z-index:2147483000',
    'display:inline-flex', 'align-items:center', 'gap:7px', 'height:22px', 'padding:0 9px 0 8px',
    'border-radius:11px', 'border:1px solid rgba(255,255,255,.14)', 'background:rgba(19,20,27,.94)',
    'color:#A2A6B4', "font:500 10.5px/1 'IBM Plex Mono',ui-monospace,monospace", 'letter-spacing:.01em',
    'box-shadow:0 1px 2px rgba(0,0,0,.6),0 8px 22px rgba(0,0,0,.35)', 'cursor:default', 'opacity:.82',
    'transition:opacity .15s ease', 'user-select:none', 'white-space:nowrap'
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:#6E7382';
  const label = document.createElement('span');
  label.textContent = statusText('booting');
  el.append(dot, label);
  document.body.appendChild(el);

  // Steady states (saved / local only) collapse to a dot after a few seconds so the pill
  // never covers the configurator for long; hover or keyboard focus expands it again.
  let hovered = false;
  let collapseTimer = null;
  let steady = false;
  const setCollapsed = (on) => {
    label.style.display = on ? 'none' : '';
    el.style.padding = on ? '0' : '0 9px 0 8px';
    el.style.width = on ? '22px' : '';
    el.style.justifyContent = on ? 'center' : '';
  };
  const scheduleCollapse = () => {
    clearTimeout(collapseTimer);
    if (steady && !hovered) collapseTimer = setTimeout(() => setCollapsed(true), 4000);
  };
  const expand = () => { hovered = true; el.style.opacity = '1'; clearTimeout(collapseTimer); setCollapsed(false); };
  const relax = () => { hovered = false; el.style.opacity = '.82'; scheduleCollapse(); };
  el.addEventListener('mouseenter', expand);
  el.addEventListener('focus', expand);
  el.addEventListener('mouseleave', relax);
  el.addEventListener('blur', relax);

  let action = null;
  let lastStatus = null;
  el.addEventListener('click', () => { if (action) action(); });

  return {
    update(s, engine) {
      dot.style.background = COLORS[s.status] || '#6E7382';
      label.textContent = statusText(s.status);
      el.setAttribute('aria-label', 'Sync status: ' + statusText(s.status));
      if (s.status !== lastStatus) {
        lastStatus = s.status;
        steady = s.status === 'saved' || s.status === 'local';
        if (!hovered) setCollapsed(false);
        scheduleCollapse();
      }
      const lines = [];
      lines.push('Persistence: ' + (s.mode === 'nocobase' ? 'NocoBase (via localhost web server)' : 'this browser only (localStorage)'));
      if (s.detail) lines.push(s.detail);
      if (s.lastSavedAt) lines.push('Last saved ' + new Date(s.lastSavedAt).toLocaleTimeString());
      if (s.pendingReleases) lines.push(s.pendingReleases + ' release(s) waiting to be recorded');
      if (s.lastError && s.status === 'error') lines.push('Error: ' + s.lastError + ' — click to retry');
      if (s.status === 'conflict' || s.status === 'stale') lines.push('Click to reload');
      el.title = lines.join('\n');
      if (s.status === 'conflict' || s.status === 'stale') { action = () => location.reload(); el.style.cursor = 'pointer'; }
      else if (s.status === 'error' && engine) { action = () => engine.retryNow(); el.style.cursor = 'pointer'; }
      else { action = null; el.style.cursor = 'default'; }
    }
  };
}

export async function startBridge() {
  const storage = safeLocalStorage();
  const pill = createPill();
  if (!storage) {
    pill.update({ status: 'error', mode: 'local', detail: 'localStorage is unavailable in this browser — nothing will persist', lastError: 'localStorage unavailable' });
    return null;
  }
  let engine = null;
  engine = createSyncEngine({
    fetch: (...a) => window.fetch(...a),
    storage,
    onStatus: (s) => pill.update(s, engine)
  });
  installInterceptor(storage, () => engine.noteWrite());
  window.addEventListener('pagehide', () => engine.flushOnExit());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') engine.flushNow(); });
  try {
    const d = await engine.hydrate();
    console.info('[cfg-bridge] hydration:', d.action, '—', d.reason);
  } catch (e) {
    console.warn('[cfg-bridge] hydration failed; continuing with browser storage', e);
  }
  window.__cfgBridge = engine; // debugging handle: __cfgBridge.status(), __cfgBridge.flushNow()
  return engine;
}
