// Sync engine between localStorage['wsconfig_v5_custom'] and the web server's /cfg API.
// DOM-free: fetch, storage and timers are injected, so the same code runs in the browser
// (storage-bridge.js) and in the Node tests.
//
// Lifecycle
//   hydrate()      once, BEFORE the configurator mounts: pull / push / conflict-resolve
//   noteWrite()    after every v5 write of the storage key (via the setItem interceptor)
//   flush()        debounced PUT /cfg/state (If-Match: last known server ETag), then
//                  POST /cfg/releases for any publish detected between the last synced
//                  blob and the new one
//   flushOnExit()  pagehide: best-effort keepalive PUT, releases persisted for next boot
//
// Persistence of sync metadata: localStorage[META_KEY] = { dirty, base, pendingReleases }
//   dirty  — browser has writes the server has not acknowledged
//   base   — ETag of the server state the browser copy is built on
import {
  STORAGE_KEY, META_KEY, BACKUP_KEY,
  parseBlob, hasState, sameBlob, decideHydration, detectPublishes, createDebouncer
} from './bridge-core.js';

const KEEPALIVE_LIMIT = 60000; // browsers cap keepalive bodies at 64 KiB

export function createSyncEngine(deps) {
  const fetchFn = deps.fetch;
  const storage = deps.storage;
  const api = (deps.api || '/cfg').replace(/\/$/, '');
  const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || ((t) => clearTimeout(t));
  const now = deps.now || (() => Date.now());
  const onStatus = deps.onStatus || (() => {});
  const log = deps.log || console;
  const healthEveryMs = deps.healthEveryMs ?? 15000;
  const healthTimeoutMs = deps.healthTimeoutMs ?? 4000;
  const stateTimeoutMs = deps.stateTimeoutMs ?? 6000;
  const putTimeoutMs = deps.putTimeoutMs ?? 20000;

  const st = {
    mode: 'unknown', status: 'booting', detail: '',
    hydrated: false, suppress: false, paused: false,
    base: null, lastSynced: null,
    writeSeq: 0, inflight: null, rerun: false, posting: null,
    retryMs: 0, retryTimer: null, healthTimer: null,
    lastSavedAt: null, lastError: null, hydration: null
  };
  let meta = readMeta();

  const debouncer = createDebouncer(() => { flush(); }, {
    wait: deps.wait ?? 600, maxWait: deps.maxWait ?? 3000, setTimer, clearTimer, now
  });

  // ---------- helpers ----------
  function readMeta() {
    let m = null;
    try { m = JSON.parse(storage.getItem(META_KEY) || 'null'); } catch { m = null; }
    if (!m || typeof m !== 'object') m = {};
    return { dirty: !!m.dirty, base: m.base || null, pendingReleases: Array.isArray(m.pendingReleases) ? m.pendingReleases : [] };
  }
  function saveMeta() {
    try { storage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { log.warn('[cfg-bridge] could not persist sync metadata', e); }
  }
  function setStatus(status, detail = '') {
    st.status = status;
    st.detail = detail;
    try { onStatus(snapshot()); } catch { /* UI must never break sync */ }
  }
  function snapshot() {
    return {
      status: st.status, detail: st.detail, mode: st.mode, paused: st.paused,
      lastSavedAt: st.lastSavedAt, lastError: st.lastError,
      dirty: meta.dirty, pendingReleases: meta.pendingReleases.length,
      hydration: st.hydration
    };
  }
  async function request(path, init = {}, timeoutMs = 5000) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimer(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(api + path, Object.assign({ cache: 'no-store' }, init, ctrl ? { signal: ctrl.signal } : {}));
      let body = null;
      const text = await res.text();
      if (text) { try { body = JSON.parse(text); } catch { body = null; } }
      return { ok: res.ok, status: res.status, body, etag: res.headers.get('ETag') };
    } finally {
      if (t) clearTimer(t);
    }
  }
  function writeLocal(blob) {
    st.suppress = true;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(blob)); } finally { st.suppress = false; }
  }
  function adopt(blob, etag) {
    st.base = etag;
    st.lastSynced = blob;
    meta.dirty = false;
    meta.base = etag;
    saveMeta();
  }
  function markDirty() {
    if (!meta.dirty) { meta.dirty = true; saveMeta(); }
  }
  function goLocal(detail, status = 'local') {
    st.mode = 'local';
    setStatus(status, detail);
    scheduleHealthCheck();
  }
  function scheduleHealthCheck() {
    if (st.healthTimer || st.stopped) return;
    st.healthTimer = setTimer(() => { st.healthTimer = null; recheck(); }, healthEveryMs);
  }
  function scheduleRetry() {
    if (st.stopped) return;
    st.retryMs = Math.min(30000, st.retryMs ? st.retryMs * 2 : 2000);
    if (st.retryTimer) clearTimer(st.retryTimer);
    st.retryTimer = setTimer(() => { st.retryTimer = null; flush(); }, st.retryMs);
  }
  function queueReleases(list) {
    let changed = false;
    for (const r of list) {
      const key = r.workspace_slug + '@' + r.version;
      if (meta.pendingReleases.some(x => x.workspace_slug + '@' + x.version === key)) continue;
      meta.pendingReleases.push(r);
      changed = true;
    }
    if (changed) saveMeta();
  }

  // ---------- boot ----------
  async function hydrate() {
    let health = null;
    try { health = (await request('/health', {}, healthTimeoutMs)).body; } catch { health = null; }
    if (!health || health.mode !== 'nocobase') {
      st.hydrated = true;
      st.hydration = { action: 'local', reason: health ? 'server is in local mode (NocoBase unavailable)' : 'web server unreachable' };
      goLocal(st.hydration.reason);
      return st.hydration;
    }
    let state;
    try { state = await request('/state', {}, stateTimeoutMs); } catch (e) { state = { ok: false, status: 0, body: { error: String(e && e.message || e) } }; }
    if (!state.ok) {
      st.hydrated = true;
      const why = state.status === 503 ? 'server is in local mode' : 'could not load server state (' + (state.status || 'network') + ')';
      st.hydration = { action: 'local', reason: why };
      goLocal(why, state.status === 503 ? 'local' : 'error');
      return st.hydration;
    }
    const serverBlob = parseBlob(state.body) || {};
    const localRaw = storage.getItem(STORAGE_KEY);
    const d = decideHydration({ mode: 'nocobase', serverBlob, serverEtag: state.etag, localRaw, meta });
    st.mode = 'nocobase';
    st.hydration = d;
    switch (d.action) {
      case 'pull':
        if (hasState(serverBlob)) writeLocal(serverBlob);
        adopt(serverBlob, state.etag);
        break;
      case 'conflict':
        try { storage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: new Date(now()).toISOString(), blob: localRaw })); } catch { /* best effort */ }
        writeLocal(serverBlob);
        adopt(serverBlob, state.etag);
        break;
      case 'push':
        st.base = state.etag;
        st.lastSynced = serverBlob;
        markDirty();
        break;
      default: // 'none'
        adopt(serverBlob, state.etag);
    }
    st.hydrated = true;
    if (d.action === 'push') { setStatus('pending', d.reason); flush(); }
    else setStatus('saved', d.action === 'conflict' ? 'server copy loaded; this browser’s copy was backed up to ' + BACKUP_KEY : '');
    if (meta.pendingReleases.length) postPendingReleases();
    return d;
  }

  // ---------- writes ----------
  function noteWrite() {
    if (st.suppress || !st.hydrated) return;
    st.writeSeq++;
    markDirty();
    if (st.mode === 'nocobase' && !st.paused) {
      if (st.status !== 'saving') setStatus('pending');
      debouncer.trigger();
    } else if (st.mode === 'local') {
      setStatus(st.status === 'error' ? 'error' : 'local', 'changes are kept in this browser');
    }
  }

  function flush() {
    if (st.mode !== 'nocobase' || st.paused || !st.hydrated) return Promise.resolve();
    if (st.inflight) { st.rerun = true; return st.inflight; }
    st.inflight = doFlush()
      .catch((e) => { log.warn('[cfg-bridge] flush failed', e); })
      .finally(() => {
        st.inflight = null;
        if (st.rerun) { st.rerun = false; debouncer.trigger(); }
      });
    return st.inflight;
  }

  async function doFlush() {
    const raw = storage.getItem(STORAGE_KEY);
    const next = parseBlob(raw);
    const seq = st.writeSeq;
    if (!next) return;
    if (st.lastSynced && sameBlob(next, st.lastSynced)) {
      if (st.writeSeq === seq) { meta.dirty = false; saveMeta(); }
      setStatus('saved');
      return;
    }
    setStatus('saving');
    let res;
    try {
      res = await request('/state', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, st.base ? { 'If-Match': st.base } : {}),
        body: raw
      }, putTimeoutMs);
    } catch (e) {
      st.lastError = 'network: ' + (e && e.message || e);
      setStatus('error', st.lastError);
      scheduleRetry();
      return;
    }
    if (res.status === 409) {
      st.paused = true;
      st.lastError = 'conflict';
      setStatus('conflict', 'the server copy changed elsewhere — reload to load it (this browser’s copy will be backed up)');
      return;
    }
    if (res.status === 503) { goLocal('NocoBase became unavailable; changes are kept in this browser'); return; }
    if (!res.ok) {
      st.lastError = 'HTTP ' + res.status + (res.body && res.body.error ? ': ' + res.body.error : '');
      setStatus('error', st.lastError);
      scheduleRetry();
      return;
    }
    st.base = res.etag || (res.body && res.body.etag) || st.base;
    const releases = detectPublishes(st.lastSynced, next);
    st.lastSynced = next;
    st.retryMs = 0;
    st.lastError = null;
    st.lastSavedAt = now();
    meta.base = st.base;
    if (st.writeSeq === seq) meta.dirty = false;
    saveMeta();
    if (releases.length) queueReleases(releases);
    if (meta.pendingReleases.length) await postPendingReleases();
    setStatus(st.writeSeq === seq ? 'saved' : 'pending');
  }

  function postPendingReleases() {
    if (st.posting) return st.posting;
    st.posting = (async () => {
      while (meta.pendingReleases.length) {
        const r = meta.pendingReleases[0];
        let res;
        try {
          res = await request('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }, putTimeoutMs);
        } catch { break; }
        if (res.ok || res.status === 400) {
          if (res.status === 400) log.warn('[cfg-bridge] release rejected by server', res.body);
          meta.pendingReleases.shift();
          saveMeta();
        } else break;
      }
    })().finally(() => { st.posting = null; });
    return st.posting;
  }

  // ---------- recovery ----------
  async function recheck() {
    let health = null;
    try { health = (await request('/health', {}, healthTimeoutMs)).body; } catch { health = null; }
    if (!health || health.mode !== 'nocobase') { scheduleHealthCheck(); return; }
    let state;
    try { state = await request('/state', {}, stateTimeoutMs); } catch { scheduleHealthCheck(); return; }
    if (!state.ok) { scheduleHealthCheck(); return; }
    const serverBlob = parseBlob(state.body) || {};
    const local = parseBlob(storage.getItem(STORAGE_KEY));
    st.mode = 'nocobase';
    // The configurator is running: its in-memory state would overwrite anything we pulled
    // into localStorage, so after boot we can only push, never pull.
    if (sameBlob(local || {}, serverBlob) || (!hasState(local) && !hasState(serverBlob))) {
      adopt(serverBlob, state.etag);
      setStatus('saved', 'reconnected to NocoBase');
      if (meta.pendingReleases.length) postPendingReleases();
      return;
    }
    if (!hasState(serverBlob) || (meta.base && meta.base === state.etag)) {
      st.base = state.etag;
      st.lastSynced = serverBlob;
      markDirty();
      setStatus('pending', 'reconnected to NocoBase; uploading changes made while offline');
      flush();
      return;
    }
    st.paused = true;
    if (meta.dirty) setStatus('conflict', 'NocoBase has different data and this browser has unsynced edits — reload to load the server copy (this browser’s copy will be backed up)');
    else setStatus('stale', 'NocoBase has newer data — reload to load it');
  }

  // ---------- exit ----------
  function flushOnExit() {
    if (st.mode !== 'nocobase' || st.paused || !st.hydrated) return;
    const raw = storage.getItem(STORAGE_KEY);
    const next = parseBlob(raw);
    if (!next || (st.lastSynced && sameBlob(next, st.lastSynced))) return;
    debouncer.cancel();
    // Persist publishes now; they are posted on the next boot if this request doesn't land.
    queueReleases(detectPublishes(st.lastSynced, next));
    if (raw.length > KEEPALIVE_LIMIT) return; // too big for keepalive: next boot pushes (dirty + base)
    try {
      fetchFn(api + '/state', {
        method: 'PUT', keepalive: true,
        headers: Object.assign({ 'Content-Type': 'application/json' }, st.base ? { 'If-Match': st.base } : {}),
        body: raw
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  return {
    hydrate, noteWrite, flush, flushOnExit, recheck,
    flushNow() { if (debouncer.pending) debouncer.flushNow(); return st.inflight || Promise.resolve(); },
    retryNow() { if (st.retryTimer) { clearTimer(st.retryTimer); st.retryTimer = null; } st.retryMs = 0; return flush(); },
    status: snapshot,
    /** stop all timers (tests, or tearing the bridge down) */
    stop() {
      st.stopped = true;
      debouncer.cancel();
      if (st.healthTimer) clearTimer(st.healthTimer);
      if (st.retryTimer) clearTimer(st.retryTimer);
      st.healthTimer = st.retryTimer = null;
    },
    /** test/debug: resolves when no save or release post is in flight */
    async idle() { while (st.inflight || st.posting) { await st.inflight; await st.posting; } }
  };
}
