import express from 'express';
import request from 'supertest';
import type * as admin from 'firebase-admin';
import { OAuthTokenService } from '../../../application/oauth/OAuthTokenService';
import { createConsentRoutes, type StaffLookup } from '../consentRoutes';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function makeApp(opts: {
  staff?: { email: string; role: string } | null;
  decodedToken?: Partial<admin.auth.DecodedIdToken> | Error;
}) {
  const tokens = new OAuthTokenService('a'.repeat(64), 'https://mcp.example.com');
  const staffLookup: StaffLookup = {
    findByEmail: jest.fn().mockResolvedValue(opts.staff ?? null),
  };
  const auditor = { emit: jest.fn() };
  const verifyIdToken = jest.fn().mockImplementation(() => {
    if (opts.decodedToken instanceof Error) return Promise.reject(opts.decodedToken);
    return Promise.resolve(opts.decodedToken as admin.auth.DecodedIdToken);
  });

  const app = express();
  app.use(express.json());
  app.use('/oauth', createConsentRoutes({ tokens, staffLookup, auditor, verifyIdToken }));

  const requestContext = tokens.signConsentRequest({
    clientId: 'client-1',
    redirectUri: CALLBACK,
    codeChallenge: 'challenge-abc',
    scope: 'worker:read',
    state: 'st-123',
  });

  return { app, tokens, auditor, staffLookup, requestContext };
}

describe('POST /oauth/consent', () => {
  it('staff ativo → redirectUrl com code + state; code carrega identidade', async () => {
    const { app, tokens, requestContext, auditor } = makeApp({
      staff: { email: 'ana@enlite.health', role: 'recruiter' },
      decodedToken: { email: 'ana@enlite.health', email_verified: true, uid: 'uid-1' },
    });

    const res = await request(app)
      .post('/oauth/consent')
      .send({ idToken: 'firebase-id-token', requestContext });

    expect(res.status).toBe(200);
    const redirectUrl = new URL(res.body.redirectUrl as string);
    expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(CALLBACK);
    expect(redirectUrl.searchParams.get('state')).toBe('st-123');

    const code = redirectUrl.searchParams.get('code');
    expect(tokens.verifyCode(code as string)).toMatchObject({
      clientId: 'client-1',
      codeChallenge: 'challenge-abc',
      email: 'ana@enlite.health',
      role: 'recruiter',
    });
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        capability: 'oauth.consent',
        principal: 'claude-ai:ana@enlite.health',
      }),
    );
  });

  it('conta Google que não é staff ativo → 403 + audit error', async () => {
    const { app, requestContext, auditor } = makeApp({
      staff: null,
      decodedToken: { email: 'intruso@gmail.com', email_verified: true, uid: 'uid-2' },
    });

    const res = await request(app)
      .post('/oauth/consent')
      .send({ idToken: 'firebase-id-token', requestContext });

    expect(res.status).toBe(403);
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', errorCode: 'CONSENT_DENIED' }),
    );
  });

  it('idToken inválido no Firebase → 401', async () => {
    const { app, requestContext } = makeApp({
      staff: { email: 'ana@enlite.health', role: 'admin' },
      decodedToken: new Error('token expired'),
    });

    const res = await request(app)
      .post('/oauth/consent')
      .send({ idToken: 'bad', requestContext });

    expect(res.status).toBe(401);
  });

  it('email não verificado → 403', async () => {
    const { app, requestContext, staffLookup } = makeApp({
      staff: { email: 'ana@enlite.health', role: 'admin' },
      decodedToken: { email: 'ana@enlite.health', email_verified: false, uid: 'uid-3' },
    });

    const res = await request(app)
      .post('/oauth/consent')
      .send({ idToken: 't', requestContext });

    expect(res.status).toBe(403);
    expect(staffLookup.findByEmail).not.toHaveBeenCalled();
  });

  it('requestContext expirado/forjado → 400', async () => {
    const { app } = makeApp({
      staff: { email: 'ana@enlite.health', role: 'admin' },
      decodedToken: { email: 'ana@enlite.health', email_verified: true, uid: 'uid-4' },
    });

    const res = await request(app)
      .post('/oauth/consent')
      .send({ idToken: 't', requestContext: 'garbage' });

    expect(res.status).toBe(400);
  });

  it('body sem campos obrigatórios → 400', async () => {
    const { app } = makeApp({ staff: null, decodedToken: {} });
    const res = await request(app).post('/oauth/consent').send({});
    expect(res.status).toBe(400);
  });
});
