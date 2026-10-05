// F4b: host half of the configurator <-> portal protocol.
import { describe, it, expect, vi } from 'vitest';
import { isFrameMessage, createConfiguratorHost, splitFindings, findingWhere } from '../configuratorHost.js';

const ORIGIN = 'http://localhost:5173';

function setup(handlers = {}) {
  const frame = { postMessage: vi.fn() };
  const listeners = [];
  const win = { addEventListener: (t, fn) => listeners.push(fn), removeEventListener: vi.fn() };
  const host = createConfiguratorHost({ getFrameWindow: () => frame, origin: ORIGIN, win, ...handlers });
  const deliver = (data, { origin = ORIGIN, source = frame } = {}) => listeners.forEach((fn) => fn({ data, origin, source }));
  return { frame, host, deliver };
}

describe('isFrameMessage', () => {
  const frame = {};
  it('accepts only the configurator frame, same origin, tagged messages', () => {
    expect(isFrameMessage({ origin: ORIGIN, source: frame, data: { source: 'matrix-cfg', type: 'context' } }, frame, ORIGIN)).toBe(true);
    expect(isFrameMessage({ origin: 'http://evil.test', source: frame, data: { source: 'matrix-cfg', type: 'context' } }, frame, ORIGIN)).toBe(false);
    expect(isFrameMessage({ origin: ORIGIN, source: {}, data: { source: 'matrix-cfg', type: 'context' } }, frame, ORIGIN)).toBe(false);
    expect(isFrameMessage({ origin: ORIGIN, source: frame, data: { type: 'context' } }, frame, ORIGIN)).toBe(false);
    expect(isFrameMessage({ origin: ORIGIN, source: frame, data: 'x' }, frame, ORIGIN)).toBe(false);
  });
});

describe('createConfiguratorHost', () => {
  it('acks a pre-publish immediately and hands it on', () => {
    const onPrePublish = vi.fn();
    const { frame, deliver } = setup({ onPrePublish });
    deliver({ source: 'matrix-cfg', type: 'pre-publish', id: 'pp-1', context: { ref: 'ws_a' }, manifest: { m: 1 }, reason: 'r' });
    expect(frame.postMessage).toHaveBeenCalledWith({ source: 'matrix-host', type: 'pre-publish-ack', id: 'pp-1' }, ORIGIN);
    expect(onPrePublish).toHaveBeenCalledWith({ id: 'pp-1', context: { ref: 'ws_a' }, manifest: { m: 1 }, reason: 'r' });
  });

  it('answers pre-publish and never sends anything token-like', () => {
    const { frame, host } = setup();
    host.answerPrePublish('pp-1', false, 'blocked');
    const msg = frame.postMessage.mock.calls[0][0];
    expect(msg).toEqual({ source: 'matrix-host', type: 'pre-publish-result', id: 'pp-1', ok: false, message: 'blocked' });
  });

  it('routes context and published events, ignores forged ones', () => {
    const onContext = vi.fn(); const onPublished = vi.fn();
    const { deliver } = setup({ onContext, onPublished });
    deliver({ source: 'matrix-cfg', type: 'context', context: { ref: 'a' } });
    deliver({ source: 'matrix-cfg', type: 'published', context: { ref: 'a' }, version: 2, manifest: {} });
    deliver({ source: 'matrix-cfg', type: 'published', context: { ref: 'x' } }, { origin: 'http://evil.test' });
    expect(onContext).toHaveBeenCalledWith({ ref: 'a' });
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(onPublished.mock.calls[0][0]).toMatchObject({ version: 2, context: { ref: 'a' } });
  });

  it('requestManifest resolves with the frame\'s answer', async () => {
    const { frame, host, deliver } = setup();
    const p = host.requestManifest();
    const { id } = frame.postMessage.mock.calls[0][0];
    deliver({ source: 'matrix-cfg', type: 'manifest', id, context: { ref: 'a' }, manifest: { ok: 1 } });
    await expect(p).resolves.toEqual({ context: { ref: 'a' }, manifest: { ok: 1 } });
  });

  it('requestManifest times out cleanly', async () => {
    vi.useFakeTimers();
    const { host } = setup();
    const p = host.requestManifest(50);
    vi.advanceTimersByTime(60);
    await expect(p).rejects.toThrow(/did not answer/);
    vi.useRealTimers();
  });
});

describe('findings helpers', () => {
  it('splits errors from warnings and says where a finding points', () => {
    const f = [{ severity: 'warning', code: 'unparsed_hint', module: 'vendor', stage: 2, field: 'msme' }, { severity: 'error', code: 'gate_unknown_source', module: 'vendor' }];
    expect(splitFindings(f).errors.map((x) => x.code)).toEqual(['gate_unknown_source']);
    expect(splitFindings(f).warnings.map((x) => x.code)).toEqual(['unparsed_hint']);
    expect(findingWhere(f[0])).toBe('vendor · stage 2 · msme');
  });
});
