import type { Request, Response } from 'express';

const mockVerify = jest.fn();
jest.mock('google-auth-library', () => ({ OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerify })) }));

import { readPersonTreeAllowlist, requirePersonTreeService } from '../requirePersonTreeService';

const SA = 'svc@p.iam.gserviceaccount.com';

async function run(headers: Record<string, string>) {
  const next = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response & { status: jest.Mock };
  await requirePersonTreeService({ headers } as Request, res, next);
  return { next, res };
}

describe('requirePersonTreeService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    mockVerify.mockReset();
    process.env.PERSON_TREE_ALLOWED_SAS = SA;
    process.env.INTERNAL_TOKEN_SECRET = 's3';
  });
  afterAll(() => void (process.env = env));

  it('lê a allowlist: separa por vírgula, apara, ignora vazios', () => {
    expect(readPersonTreeAllowlist({ PERSON_TREE_ALLOWED_SAS: ' a@x , ,b@x' })).toEqual(['a@x', 'b@x']);
    expect(readPersonTreeAllowlist({})).toEqual([]);
  });

  it('OIDC com SA na allowlist passa', async () => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ email: SA, email_verified: true }) });
    expect((await run({ authorization: 'Bearer t' })).next).toHaveBeenCalled();
  });

  it('SA fora da allowlist, e-mail não verificado ou allowlist vazia → 403', async () => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ email: 'outra@x', email_verified: true }) });
    expect((await run({ authorization: 'Bearer t' })).res.status).toHaveBeenCalledWith(403);
    mockVerify.mockResolvedValue({ getPayload: () => ({ email: SA, email_verified: false }) });
    expect((await run({ authorization: 'Bearer t' })).res.status).toHaveBeenCalledWith(403);
    mockVerify.mockResolvedValue({ getPayload: () => ({ email: SA, email_verified: true }) });
    process.env.PERSON_TREE_ALLOWED_SAS = '';
    expect((await run({ authorization: 'Bearer t' })).res.status).toHaveBeenCalledWith(403);
  });

  it('segredo interno passa; sem credencial → 403', async () => {
    expect((await run({ 'x-internal-secret': 's3' })).next).toHaveBeenCalled();
    expect((await run({})).res.status).toHaveBeenCalledWith(403);
  });
});
