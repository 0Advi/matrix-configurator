// F4b: the frame half of the configurator <-> portal protocol (public/configurator/host-bridge.js),
// exercised against a stand-in for v5's logic class (same method names v5 uses: ws(), manifest(),
// toast(), publishVals().onConfirmPublish, componentDidMount/Update).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installHostHooks, contextOf } from '../../../../../public/configurator/host-bridge.js';

function makeLogic() {
  class Logic {
    constructor() {
      this.state = { ws: 'ws_acme', liveV: 0, draftV: 1, publishReason: '', history: [], modules: [{ key: 'bd' }] };
      this.toasts = [];
      this.published = 0;
    }
    ws() { return { id: this.state.ws, name: 'Acme Retail', slug: 'acme', custom: true }; }
    manifest() { return { workspace: { id: this.state.ws, live_version: 'v' + this.state.liveV }, modules: this.state.modules }; }
    toast(m) { this.toasts.push(m); }
    publishVals() {
      const s = this.state;
      return {
        onConfirmPublish: () => {
          this.published += 1;
          this.state = { ...s, liveV: s.draftV, draftV: s.draftV + 1, history: [{ version: 'v' + s.draftV, reason: s.publishReason, meta: '11 Sep 2026 · platform:ops@matrix.io' }].concat(s.history) };
          this.componentDidUpdate({});
        },
      };
    }
    componentDidMount() {}
    componentDidUpdate() {}
  }
  return Logic;
}

function fakeWindow() {
  const listeners = [];
  const parent = { postMessage: vi.fn() };
  const win = {
    parent,
    location: { origin: 'http://localhost:5173' },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    deliver: (data, { origin = 'http://localhost:5173', source = parent } = {}) => listeners.forEach((fn) => fn({ origin, source, data })),
  };
  return win;
}

const sent = (win, type) => win.parent.postMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === type);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('installHostHooks', () => {
  it('posts the context on mount and when the workspace or versions change', () => {
    const Logic = makeLogic(); const win = fakeWindow();
    expect(installHostHooks(Logic, { window: win })).toBe(true);
    const l = new Logic();
    l.componentDidMount();
    expect(sent(win, 'context')[0].context).toEqual({ ref: 'ws_acme', name: 'Acme Retail', slug: 'acme', custom: true, liveV: 0, draftV: 1 });
    l.componentDidUpdate({});                     // nothing changed → no new context
    expect(sent(win, 'context')).toHaveLength(1);
    expect(win.parent.postMessage.mock.calls[0][1]).toBe('http://localhost:5173'); // same-origin target only
  });

  it('gates the publish: pre-publish → ack → ok → v5 publishes → "published" carries v5\'s manifest', () => {
    const Logic = makeLogic(); const win = fakeWindow();
    installHostHooks(Logic, { window: win });
    const l = new Logic(); l.componentDidMount();
    l.state = { ...l.state, publishReason: 'first release' };
    l.publishVals().onConfirmPublish();
    const [pre] = sent(win, 'pre-publish');
    expect(pre).toMatchObject({ reason: 'first release', context: { ref: 'ws_acme', draftV: 1 } });
    expect(pre.manifest.workspace.id).toBe('ws_acme');
    expect(l.published).toBe(0);                  // waiting for the host
    win.deliver({ source: 'matrix-host', type: 'pre-publish-ack', id: pre.id });
    vi.advanceTimersByTime(10000);                // acked → no stand-alone fallback
    expect(l.published).toBe(0);
    win.deliver({ source: 'matrix-host', type: 'pre-publish-result', id: pre.id, ok: true });
    expect(l.published).toBe(1);
    const [pub] = sent(win, 'published');
    expect(pub).toMatchObject({ version: 1, reason: 'first release', context: { ref: 'ws_acme', liveV: 1 } });
    expect(pub.manifest.workspace.live_version).toBe('v1');
  });

  it('a refused gate keeps v5 from publishing and toasts the reason', () => {
    const Logic = makeLogic(); const win = fakeWindow();
    installHostHooks(Logic, { window: win });
    const l = new Logic(); l.componentDidMount();
    l.state = { ...l.state, publishReason: 'x' };
    l.publishVals().onConfirmPublish();
    const [pre] = sent(win, 'pre-publish');
    win.deliver({ source: 'matrix-host', type: 'pre-publish-ack', id: pre.id });
    win.deliver({ source: 'matrix-host', type: 'pre-publish-result', id: pre.id, ok: false, message: 'Publish blocked: 2 errors' });
    expect(l.published).toBe(0);
    expect(l.toasts).toContain('Publish blocked: 2 errors');
    expect(sent(win, 'published')).toHaveLength(0);
  });

  it('publishes stand-alone when no host answers', () => {
    const Logic = makeLogic(); const win = fakeWindow();
    installHostHooks(Logic, { window: win, ackMs: 100 });
    const l = new Logic(); l.componentDidMount();
    l.state = { ...l.state, publishReason: 'x' };
    l.publishVals().onConfirmPublish();
    vi.advanceTimersByTime(150);
    expect(l.published).toBe(1);
  });

  it('ignores messages from anything but the parent window / own origin', () => {
    const Logic = makeLogic(); const win = fakeWindow();
    installHostHooks(Logic, { window: win });
    const l = new Logic(); l.componentDidMount();
    l.state = { ...l.state, publishReason: 'x' };
    l.publishVals().onConfirmPublish();
    const [pre] = sent(win, 'pre-publish');
    const forged = { source: 'matrix-host', type: 'pre-publish-result', id: pre.id, ok: true };
    win.deliver({ source: 'matrix-host', type: 'pre-publish-ack', id: pre.id }, { origin: 'http://evil.test' });
    win.deliver(forged, { origin: 'http://evil.test' });
    win.deliver(forged, { source: { postMessage() {} } });  // same origin, another window
    expect(l.published).toBe(0);
    vi.advanceTimersByTime(3000);                 // the forged ack did not count → stand-alone fallback
    expect(l.published).toBe(1);
  });

  it('answers request-manifest with the current draft manifest', () => {
    const Logic = makeLogic(); const win = fakeWindow();
    installHostHooks(Logic, { window: win });
    const l = new Logic(); l.componentDidMount();
    win.deliver({ source: 'matrix-host', type: 'request-manifest', id: 'rm-1' });
    const [m] = sent(win, 'manifest');
    expect(m).toMatchObject({ id: 'rm-1', context: { ref: 'ws_acme' }, manifest: { workspace: { id: 'ws_acme' } } });
  });

  it('does nothing to publishing when not embedded', () => {
    const Logic = makeLogic();
    const win = fakeWindow(); win.parent = win;   // top-level page
    expect(installHostHooks(Logic, { window: win })).toBe(false);
    const l = new Logic(); l.state = { ...l.state, publishReason: 'x' };
    l.publishVals().onConfirmPublish();
    expect(l.published).toBe(1);
  });

  it('contextOf tolerates a logic without ws()', () => {
    expect(contextOf({ state: { ws: 'bluetokai', liveV: 7, draftV: 8 } })).toMatchObject({ ref: 'bluetokai', liveV: 7, draftV: 8 });
  });
});
