import { Request, Response, NextFunction } from 'express';

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('@shared/logging', () => ({ logger: mockLogger }));

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

import { appChannel, profileEditChannelOf, APP_SERVICE_TOKEN_HEADER } from '../appChannel';
import { ServiceIdentityVerifier } from '@modules/agentes/infrastructure/ServiceIdentityVerifier';

const BFF_SA = 'mobile-bff-sa@test-project.iam.gserviceaccount.com';
const ASSISTANTS_SA = 'assistants-service-sa@test-project.iam.gserviceaccount.com';

function call(mw: ReturnType<typeof appChannel>, headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = { locals: {}, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return mw(req, res, next).then(() => ({ res, next }));
}
const fake = (payload: object): ServiceIdentityVerifier => ({ verify: jest.fn().mockResolvedValue(payload) });

describe('appChannel', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
    delete process.env.USE_MOCK_AUTH;
    mockVerifyIdToken.mockReset();
    mockLogger.warn.mockReset();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('T-F2b-02 sem header: segue sem marca e sem verificar', async () => {
    const v = fake({ email: BFF_SA, email_verified: true });
    const { res, next } = await call(appChannel(v));
    expect(v.verify).not.toHaveBeenCalled();
    expect(profileEditChannelOf(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('T-F2b-02 token de outra SA: segue sem marca', async () => {
    const { res, next } = await call(appChannel(fake({ email: ASSISTANTS_SA, email_verified: true })), {
      [APP_SERVICE_TOKEN_HEADER]: 'tok',
    });
    expect(profileEditChannelOf(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('T-F2b-02 email_verified falso: segue sem marca', async () => {
    const { res, next } = await call(appChannel(fake({ email: BFF_SA, email_verified: false })), {
      [APP_SERVICE_TOKEN_HEADER]: 'tok',
    });
    expect(profileEditChannelOf(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('T-F2b-02 verificador recusa: segue sem marca, sem 401, e o log não traz o token', async () => {
    const v: ServiceIdentityVerifier = { verify: jest.fn().mockRejectedValue(new Error('Wrong recipient tok-SECRET-9')) };
    const { res, next } = await call(appChannel(v), { [APP_SERVICE_TOKEN_HEADER]: 'tok-SECRET-9' });
    expect(profileEditChannelOf(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('tok-SECRET-9');
  });

  it('T-F2b-02 token válido da mobile-bff-sa marca app', async () => {
    const { res, next } = await call(appChannel(fake({ email: BFF_SA, email_verified: true })), {
      [APP_SERVICE_TOKEN_HEADER]: 'tok',
    });
    expect(profileEditChannelOf(res)).toBe('app');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('T-F2b-02 sem GCP_PROJECT_ID a allowlist é vazia e não marca', async () => {
    delete process.env.GCP_PROJECT_ID;
    const { res, next } = await call(appChannel(fake({ email: BFF_SA, email_verified: true })), {
      [APP_SERVICE_TOKEN_HEADER]: 'tok',
    });
    expect(profileEditChannelOf(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('T-F2b-02 sem verificador injetado usa o Google com a audiência do BFF', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: BFF_SA, email_verified: true }) });
    const { res, next } = await call(appChannel(), { [APP_SERVICE_TOKEN_HEADER]: 'tok' });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'tok', audience: 'https://api.enlite.health/mobile-bff' });
    expect(profileEditChannelOf(res)).toBe('app');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
