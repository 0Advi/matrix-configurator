// Batch J — uploads use the longer (120s) timeout, not the 20s default (#127).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const postMock = vi.fn(() => Promise.resolve({ data: {} }));

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post: postMock,
      get: vi.fn(() => Promise.resolve({ data: {} })),
      patch: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    }),
  },
}));

beforeEach(() => postMock.mockClear());

describe('upload timeouts (#127)', () => {
  it('uploadLoi posts with a 120s timeout', async () => {
    const { uploadLoi } = await import('../adapters/httpAdapter.js');
    await uploadLoi('site1', new Blob(['x'], { type: 'application/pdf' }));
    const cfg = postMock.mock.calls.at(-1)[2];
    expect(cfg.timeout).toBe(120000);
  });

  it('uploadPhoto posts with a 120s timeout', async () => {
    const { uploadPhoto } = await import('../adapters/httpAdapter.js');
    await uploadPhoto('site1', new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    const cfg = postMock.mock.calls.at(-1)[2];
    expect(cfg.timeout).toBe(120000);
  });

  // (quality-audit upload removed — it is now a calendar date, no file upload.)
});
