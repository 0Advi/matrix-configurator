// Host side of the configurator <-> portal postMessage protocol.
// The frame side is public/configurator/host-bridge.js; the message list is documented there.
//
// Security model: the configurator is a same-origin iframe. Messages are accepted only when
// they come from THAT iframe's window and from this page's origin, and they never carry the
// platform-admin token — the portal makes every API call itself.

export const FRAME = 'matrix-cfg';
export const HOST = 'matrix-host';

export function isFrameMessage(ev, frameWindow, origin) {
  if (!ev || !frameWindow) return false;
  if (ev.origin !== origin) return false;
  if (ev.source !== frameWindow) return false;
  const m = ev.data;
  return !!m && typeof m === 'object' && m.source === FRAME && typeof m.type === 'string';
}

/**
 * @param {object} p
 * @param {() => Window|null} p.getFrameWindow  the iframe's contentWindow (may change on reload)
 * @param {string} p.origin                     window.location.origin
 * @param {Window} [p.win]                       where to listen (default window)
 * @param {(ctx: object) => void} [p.onContext]
 * @param {(req: {id, context, manifest, reason}) => void} [p.onPrePublish]
 * @param {(evt: {context, version, reason, publisher, manifest}) => void} [p.onPublished]
 */
export function createConfiguratorHost({ getFrameWindow, origin, win = window, onContext, onPrePublish, onPublished }) {
  const pending = new Map(); // request-manifest id -> {resolve, reject, timer}
  let n = 0;

  const send = (msg) => {
    const fw = getFrameWindow();
    if (!fw) return false;
    fw.postMessage({ source: HOST, ...msg }, origin);
    return true;
  };

  const listener = (ev) => {
    if (!isFrameMessage(ev, getFrameWindow(), origin)) return;
    const m = ev.data;
    switch (m.type) {
      case 'context':
        onContext?.(m.context || null);
        break;
      case 'pre-publish':
        // Ack at once so the frame keeps waiting while the portal works (validation,
        // provisioning dialog); the frame publishes stand-alone only if nobody acks.
        send({ type: 'pre-publish-ack', id: m.id });
        onPrePublish?.({ id: m.id, context: m.context || null, manifest: m.manifest || null, reason: m.reason || '' });
        break;
      case 'published':
        onPublished?.({ context: m.context || null, version: m.version, reason: m.reason || '', publisher: m.publisher || '', manifest: m.manifest || null });
        break;
      case 'manifest': {
        const p = pending.get(m.id);
        if (p) { clearTimeout(p.timer); pending.delete(m.id); p.resolve({ context: m.context || null, manifest: m.manifest || null }); }
        break;
      }
      default:
        break;
    }
  };
  win.addEventListener('message', listener);

  return {
    /** Answer a pre-publish request: ok lets v5 publish; otherwise `message` is toasted in the canvas. */
    answerPrePublish(id, ok, message) { send({ type: 'pre-publish-result', id, ok: !!ok, message: message || '' }); },
    /** The current draft manifest + context of the workspace open in the canvas. */
    requestManifest(timeoutMs = 4000) {
      return new Promise((resolve, reject) => {
        const id = `rm-${Date.now().toString(36)}-${++n}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The configurator did not answer — is it still loading?')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        if (!send({ type: 'request-manifest', id })) { clearTimeout(timer); pending.delete(id); reject(new Error('The configurator is not loaded.')); }
      });
    },
    requestContext() { send({ type: 'request-context' }); },
    toast(message) { send({ type: 'toast', message }); },
    dispose() {
      win.removeEventListener('message', listener);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
      pending.clear();
    },
  };
}

/** Group backend findings for display: errors first, then warnings. */
export function splitFindings(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return {
    errors: list.filter((f) => f?.severity === 'error'),
    warnings: list.filter((f) => f?.severity !== 'error'),
  };
}

/** "pex · stage 2 · gst_number" — where a finding points, for the findings panel. */
export function findingWhere(f) {
  return [f?.module, f?.stage != null ? `stage ${f.stage}` : null, f?.field, f?.path].filter(Boolean).join(' · ');
}
