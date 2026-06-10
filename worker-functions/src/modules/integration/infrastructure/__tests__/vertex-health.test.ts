/**
 * vertex-health.test.ts
 *
 * Unit coverage for pingVertex: builds a minimal Vertex request via ADC and
 * resolves on 2xx / rejects when Vertex rejects the credential (the failure
 * the post-deploy smoke gate must catch).
 */

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn().mockResolvedValue('test-access-token'),
    getProjectId: jest.fn().mockResolvedValue('test-project'),
  })),
}));

import { pingVertex } from '../vertex-health';

describe('pingVertex', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    process.env = { ...originalEnv, GEMINI_MODEL: 'gemini-test' };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('hits the Vertex endpoint via ADC and resolves with the model on 2xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
      text: async () => '',
    });

    const result = await pingVertex();

    expect(result.model).toBe('gemini-test');
    expect(typeof result.ms).toBe('number');
    const url = mockFetch.mock.calls[0][0] as string;
    const init = mockFetch.mock.calls[0][1];
    expect(url).toContain('aiplatform.googleapis.com');
    expect(url).toContain('models/gemini-test');
    expect(url).not.toContain('key=');
    expect(init.headers.Authorization).toBe('Bearer test-access-token');
  });

  it('rejects when Vertex denies the credential (403)', async () => {
    // 403 is non-transient → generateContentVertex throws immediately.
    jest.spyOn(console, 'error').mockImplementation();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'PERMISSION_DENIED',
    });

    await expect(pingVertex()).rejects.toThrow('Gemini API error 403');
  });
});
