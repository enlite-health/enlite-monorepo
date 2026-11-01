import { Request, Response, NextFunction } from 'express';

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

import { requireAssistantsService } from '../requireAssistantsService';
import {
  ASSISTANTS_AUDIENCE,
  GoogleServiceIdentityVerifier,
  MockServiceIdentityVerifier,
  ServiceIdentityVerifier,
  createServiceIdentityVerifier,
  readServiceAllowlist,
} from '../../../infrastructure/ServiceIdentityVerifier';

const SA = 'assistants-service-sa@test-project.iam.gserviceaccount.com';
const SA_OTHER = 'other-sa@project-x.iam.gserviceaccount.com';

function call(mw: ReturnType<typeof requireAssistantsService>, headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return mw(req, res, next).then(() => ({ res, next }));
}
const fake = (payload: object): ServiceIdentityVerifier => ({
  verify: jest.fn().mockResolvedValue(payload),
});

describe('requireAssistantsService', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
    delete process.env.USE_MOCK_AUTH;
    mockVerifyIdToken.mockReset();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('no X-Enlite-Service header -> 401 SERVICE_NOT_AUTHENTICATED', async () => {
    const { res, next } = await call(requireAssistantsService(fake({ email: SA, email_verified: true })));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'SERVICE_NOT_AUTHENTICATED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('X-Internal-Secret and X-Serverless-Authorization do not replace the own header -> 401', async () => {
    const { res, next } = await call(requireAssistantsService(fake({ email: SA, email_verified: true })), {
      'x-internal-secret': 'x',
      'x-serverless-authorization': 'Bearer t',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('token with another audience -> 401 (the real verifier asks for the right audience and rejects)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Wrong recipient'));
    const mw = requireAssistantsService(new GoogleServiceIdentityVerifier());
    const { res, next } = await call(mw, { 'x-enlite-service': 'Bearer tok' });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'tok', audience: ASSISTANTS_AUDIENCE });
    expect(ASSISTANTS_AUDIENCE).toBe('https://api.enlite.health/assistentes');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('no argument (as in the contract) and no USE_MOCK_AUTH uses the Google verifier with the right audience', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: SA, email_verified: true }) });
    const { res, next } = await call(requireAssistantsService(), { 'x-enlite-service': 'Bearer tok' });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'tok', audience: ASSISTANTS_AUDIENCE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('email_verified=false -> 401', async () => {
    const { res, next } = await call(requireAssistantsService(fake({ email: SA, email_verified: false })), {
      'x-enlite-service': 'Bearer tok',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('e-mail outside the allowlist (SA of another project) -> 401', async () => {
    const { res, next } = await call(requireAssistantsService(fake({ email: SA_OTHER, email_verified: true })), {
      'x-enlite-service': 'Bearer tok',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('e-mail of the service SA -> next()', async () => {
    const { res, next } = await call(requireAssistantsService(fake({ email: SA, email_verified: true })), {
      'x-enlite-service': 'Bearer tok',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('wiring: outside USE_MOCK_AUTH=true the test verifier is NOT injectable', () => {
    const testOne = fake({ email: SA, email_verified: true });
    expect(createServiceIdentityVerifier(testOne, {})).toBeInstanceOf(GoogleServiceIdentityVerifier);
    expect(createServiceIdentityVerifier(testOne, { USE_MOCK_AUTH: 'false' })).toBeInstanceOf(
      GoogleServiceIdentityVerifier,
    );
    expect(createServiceIdentityVerifier(testOne, { USE_MOCK_AUTH: 'true' })).toBe(testOne);
  });

  describe('embedded test verifier (under USE_MOCK_AUTH=true)', () => {
    const mockToken = (d: object) => `mock_${Buffer.from(JSON.stringify(d)).toString('base64')}`;
    const good = { email: SA, email_verified: true, aud: ASSISTANTS_AUDIENCE };
    const via = async (token: string) => {
      process.env.USE_MOCK_AUTH = 'true';
      return call(requireAssistantsService(), { 'x-enlite-service': `Bearer ${token}` });
    };

    it('without USE_MOCK_AUTH=true the mock is NEVER chosen (no env, nor false/True/1)', () => {
      for (const env of [{}, { USE_MOCK_AUTH: 'false' }, { USE_MOCK_AUTH: 'True' }, { USE_MOCK_AUTH: '1' }]) {
        expect(createServiceIdentityVerifier(undefined, env)).toBeInstanceOf(GoogleServiceIdentityVerifier);
        expect(createServiceIdentityVerifier(undefined, env)).not.toBeInstanceOf(MockServiceIdentityVerifier);
      }
      expect(createServiceIdentityVerifier(undefined, { USE_MOCK_AUTH: 'true' })).toBeInstanceOf(
        MockServiceIdentityVerifier,
      );
    });

    it('without USE_MOCK_AUTH the mock_ token is rejected with 401 (only Google would count)', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('Invalid token'));
      const { res, next } = await call(requireAssistantsService(), { 'x-enlite-service': `Bearer ${mockToken(good)}` });
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('under the mock: good token (audience, email_verified, allowlist) -> next()', async () => {
      const { res, next } = await via(mockToken(good));
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it.each([
      ['another audience', { ...good, aud: 'https://another.audience' }],
      ['email_verified=false', { ...good, email_verified: false }],
      ['e-mail outside the allowlist', { ...good, email: SA_OTHER }],
    ])('under the mock: %s -> 401', async (_name, payload) => {
      const { res, next } = await via(mockToken(payload));
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('under the mock: token without the mock_ prefix or invalid base64 -> 401', async () => {
      for (const t of ['abc', 'mock_%%%not-json']) {
        const { res, next } = await via(t);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
      }
    });
  });

  it('allowlist comes from GCP_PROJECT_ID (no new env; no project -> empty and denies)', async () => {
    expect(readServiceAllowlist({ GCP_PROJECT_ID: 'test-project' })).toEqual([SA]);
    expect(readServiceAllowlist({})).toEqual([]);
    delete process.env.GCP_PROJECT_ID;
    const { res, next } = await call(requireAssistantsService(fake({ email: SA, email_verified: true })), {
      'x-enlite-service': 'Bearer tok',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
