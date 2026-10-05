// Host bridge (F4b, in-app copy only — the standalone web/public has no such file).
//
// When this configurator runs inside the Matrix app's platform-admin portal (same origin,
// an <iframe> of /configurator/index.html under /#/admin → Workspaces), the portal is the one
// that talks to the app backend: it holds the platform-admin token, provisions the tenant and
// stores the release. This file only exchanges same-origin postMessages with that parent page.
// It never sees the token and never calls the app API.
//
// Protocol (every message carries `source`; both sides check origin + source window):
//   frame -> host  {source:'matrix-cfg',  type:'context',     context}
//   frame -> host  {source:'matrix-cfg',  type:'pre-publish', id, context, manifest, reason}
//   host  -> frame {source:'matrix-host', type:'pre-publish-ack',    id}
//   host  -> frame {source:'matrix-host', type:'pre-publish-result', id, ok, message}
//   frame -> host  {source:'matrix-cfg',  type:'published',   context, version, reason, publisher, manifest}
//   host  -> frame {source:'matrix-host', type:'request-manifest', id}
//   frame -> host  {source:'matrix-cfg',  type:'manifest',    id, context, manifest}
//   host  -> frame {source:'matrix-host', type:'toast', message}
//
// `context` = {ref, name, slug, custom, liveV, draftV} of the workspace open in the canvas; `ref`
// is v5's workspace id ('bluetokai', 'ws_third_wave', …) and becomes the app's configurator_ref.
// `manifest` is always v5's own manifest() — never rebuilt here.
//
// Publish gate: v5's "Publish vN" button (publishVals().onConfirmPublish) is wrapped. With a
// listening host, the draft manifest is sent first ('pre-publish'); the host validates it with
// the app and provisions the workspace if needed, and only an ok answer lets v5 publish. Without
// a host (no ack within ACK_MS — e.g. opened stand-alone), v5 publishes exactly as before.
// After v5 has published (liveV went up on the same workspace), 'published' carries the
// published manifest so the host can store it as an app release.

export const FRAME = 'matrix-cfg';
export const HOST = 'matrix-host';
const ACK_MS = 2500;

export function contextOf(logic) {
  const s = logic.state || {};
  let w = null;
  try { w = typeof logic.ws === 'function' ? logic.ws() : null; } catch { w = null; }
  return {
    ref: (w && w.id) || s.ws || null,
    name: (w && w.name) || null,
    slug: (w && w.slug) || null,
    custom: !!(w && w.custom),
    liveV: Number(s.liveV) || 0,
    draftV: Number(s.draftV) || 0,
  };
}

export function installHostHooks(Logic, opts = {}) {
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const proto = Logic && Logic.prototype;
  if (!win || !proto || proto.__cfgHostHooks) return false;
  const parent = win.parent;
  const embedded = !!parent && parent !== win;
  const origin = win.location && win.location.origin;
  const ackMs = opts.ackMs ?? ACK_MS;

  let current = null;                 // the mounted logic instance
  const seen = new WeakMap();         // instance -> {ws, liveV, draftV}
  const waiting = new Map();          // pre-publish id -> {ack, resolve, timer}
  let seq = 0;

  const post = (msg) => {
    if (!embedded) return;
    try { parent.postMessage(Object.assign({ source: FRAME }, msg), origin); } catch (e) { console.warn('[cfg-host] postMessage failed', e); }
  };
  const safeManifest = (logic) => {
    try { return logic.manifest(); } catch (e) { console.warn('[cfg-host] manifest() failed', e); return null; }
  };
  const toast = (logic, m) => { try { if (logic && typeof logic.toast === 'function') logic.toast(m); } catch { /* cosmetic */ } };

  function observe(logic) {
    current = logic;
    const s = logic.state || {};
    const prev = seen.get(logic);
    const now = { ws: s.ws, liveV: Number(s.liveV) || 0, draftV: Number(s.draftV) || 0 };
    seen.set(logic, now);
    if (prev && prev.ws === now.ws && now.liveV > prev.liveV && !s.replay) {
      const h = Array.isArray(s.history) ? s.history[0] : null;
      post({
        type: 'published',
        context: contextOf(logic),
        version: now.liveV,
        reason: (h && h.reason) || '',
        publisher: (h && h.meta) || '',
        manifest: safeManifest(logic),
      });
    }
    if (!prev || prev.ws !== now.ws || prev.liveV !== now.liveV || prev.draftV !== now.draftV) {
      post({ type: 'context', context: contextOf(logic) });
    }
  }

  const didMount = proto.componentDidMount;
  Object.defineProperty(proto, 'componentDidMount', {
    configurable: true, writable: true,
    value: function componentDidMount(...args) {
      const r = typeof didMount === 'function' ? didMount.apply(this, args) : undefined;
      try { observe(this); } catch (e) { console.warn('[cfg-host] observe failed', e); }
      return r;
    },
  });
  const didUpdate = proto.componentDidUpdate;
  Object.defineProperty(proto, 'componentDidUpdate', {
    configurable: true, writable: true,
    value: function componentDidUpdate(...args) {
      const r = typeof didUpdate === 'function' ? didUpdate.apply(this, args) : undefined;
      try { observe(this); } catch (e) { console.warn('[cfg-host] observe failed', e); }
      return r;
    },
  });

  // ---- publish gate ----
  function gatePublish(logic) {
    const s = logic.state || {};
    const freshConfirm = () => {
      const vals = origPublishVals.call(logic);
      return vals && typeof vals.onConfirmPublish === 'function' ? vals.onConfirmPublish() : undefined;
    };
    // v5 shows its own "enter a reason" refusal; nothing to ask the host yet.
    if (!String(s.publishReason || '').trim()) return freshConfirm();
    if (logic.__cfgGatePending) { toast(logic, 'Still checking this publish with the Matrix app…'); return undefined; }
    const id = 'pp-' + Date.now().toString(36) + '-' + (++seq);
    const manifest = safeManifest(logic);
    if (!manifest) return freshConfirm();
    logic.__cfgGatePending = true;
    const done = (fn) => { logic.__cfgGatePending = false; waiting.delete(id); fn(); };
    const entry = { ack: false, resolve: null, timer: null };
    waiting.set(id, entry);
    entry.timer = setTimeout(() => {
      if (!entry.ack) done(() => { console.info('[cfg-host] no host answered; publishing stand-alone'); freshConfirm(); });
    }, ackMs);
    entry.resolve = (res) => {
      clearTimeout(entry.timer);
      done(() => {
        if (res && res.ok) freshConfirm();
        else toast(logic, (res && res.message) || 'Publish stopped by the Matrix app — see the panel on the right.');
      });
    };
    post({ type: 'pre-publish', id, context: contextOf(logic), manifest, reason: String(s.publishReason || '') });
    toast(logic, 'Checking this publish with the Matrix app…');
    return undefined;
  }

  const origPublishVals = proto.publishVals;
  if (embedded && typeof origPublishVals === 'function') {
    Object.defineProperty(proto, 'publishVals', {
      configurable: true, writable: true,
      value: function publishVals(...args) {
        const vals = origPublishVals.apply(this, args);
        if (vals && typeof vals.onConfirmPublish === 'function') {
          const logic = this;
          vals.onConfirmPublish = () => gatePublish(logic);
        }
        return vals;
      },
    });
  }

  // ---- host -> frame ----
  if (embedded) {
    win.addEventListener('message', (ev) => {
      if (ev.origin !== origin || ev.source !== parent) return;
      const m = ev.data;
      if (!m || m.source !== HOST) return;
      if (m.type === 'pre-publish-ack') {
        const e = waiting.get(m.id);
        if (e) e.ack = true;
      } else if (m.type === 'pre-publish-result') {
        const e = waiting.get(m.id);
        if (e && e.resolve) e.resolve(m);
      } else if (m.type === 'request-manifest') {
        if (!current) return;
        post({ type: 'manifest', id: m.id, context: contextOf(current), manifest: safeManifest(current) });
      } else if (m.type === 'request-context') {
        if (current) post({ type: 'context', context: contextOf(current) });
      } else if (m.type === 'toast' && m.message) {
        toast(current, String(m.message));
      }
    });
  }

  Object.defineProperty(proto, '__cfgHostHooks', { value: true });
  return embedded;
}
