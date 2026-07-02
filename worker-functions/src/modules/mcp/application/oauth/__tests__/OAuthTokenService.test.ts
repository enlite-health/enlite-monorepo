import { OAuthTokenService, OAUTH_TOKEN_TTL_SECONDS } from '../OAuthTokenService';

const KEY = 'a'.repeat(64);
const ISSUER = 'https://mcp.example.com';

function makeService(key = KEY, issuer = ISSUER): OAuthTokenService {
  return new OAuthTokenService(key, issuer);
}

describe('OAuthTokenService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejeita signing key curta', () => {
    expect(() => makeService('short')).toThrow(/at least 32 chars/);
  });

  it('client: roundtrip sign/verify preserva redirectUris e clientName', () => {
    const svc = makeService();
    const clientId = svc.signClient({
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      clientName: 'Claude',
    });
    expect(svc.verifyClient(clientId)).toEqual({
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      clientName: 'Claude',
    });
  });

  it('consent request: roundtrip com state opcional', () => {
    const svc = makeService();
    const token = svc.signConsentRequest({
      clientId: 'client-1',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'challenge-abc',
      scope: 'worker:read',
      state: 'xyz',
    });
    expect(svc.verifyConsentRequest(token)).toMatchObject({
      clientId: 'client-1',
      codeChallenge: 'challenge-abc',
      state: 'xyz',
    });
  });

  it('code: roundtrip inclui jti único por emissão', () => {
    const svc = makeService();
    const base = {
      clientId: 'client-1',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'challenge-abc',
      scope: 'worker:read',
      email: 'ana@enlite.health',
      role: 'recruiter',
    };
    const a = svc.verifyCode(svc.signCode(base));
    const b = svc.verifyCode(svc.signCode(base));
    expect(a?.email).toBe('ana@enlite.health');
    expect(a?.jti).toBeTruthy();
    expect(a?.jti).not.toBe(b?.jti);
  });

  it('access/refresh: roundtrip e exp presente no access', () => {
    const svc = makeService();
    const payload = {
      clientId: 'client-1',
      scope: 'worker:read',
      email: 'ana@enlite.health',
      role: 'admin',
    };
    const access = svc.verifyAccess(svc.signAccess(payload));
    expect(access).toMatchObject(payload);
    expect(access?.exp).toBeGreaterThan(Date.now() / 1000);
    expect(svc.verifyRefresh(svc.signRefresh(payload))).toMatchObject(payload);
  });

  it('um tipo de token nunca é aceito como outro (claim use)', () => {
    const svc = makeService();
    const access = svc.signAccess({
      clientId: 'c',
      scope: 'worker:read',
      email: 'a@enlite.health',
      role: 'admin',
    });
    expect(svc.verifyRefresh(access)).toBeNull();
    expect(svc.verifyCode(access)).toBeNull();
    expect(svc.verifyClient(access)).toBeNull();
    expect(svc.verifyConsentRequest(access)).toBeNull();
  });

  it('token expirado é rejeitado (code TTL 60s)', () => {
    jest.useFakeTimers({ now: new Date('2026-07-02T12:00:00Z') });
    const svc = makeService();
    const code = svc.signCode({
      clientId: 'c',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'ch',
      scope: 'worker:read',
      email: 'a@enlite.health',
      role: 'admin',
    });
    expect(svc.verifyCode(code)).not.toBeNull();
    jest.setSystemTime(new Date(Date.now() + (OAUTH_TOKEN_TTL_SECONDS.code + 5) * 1000));
    expect(svc.verifyCode(code)).toBeNull();
  });

  it('chave diferente ou issuer diferente → null', () => {
    const svc = makeService();
    const other = makeService('b'.repeat(64));
    const otherIssuer = makeService(KEY, 'https://other.example.com');
    const clientId = svc.signClient({ redirectUris: ['https://claude.ai/cb'] });
    expect(other.verifyClient(clientId)).toBeNull();
    expect(otherIssuer.verifyClient(clientId)).toBeNull();
  });

  it('lixo/JWT malformado → null, sem throw', () => {
    const svc = makeService();
    expect(svc.verifyAccess('not-a-jwt')).toBeNull();
    expect(svc.verifyAccess('eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.bad')).toBeNull();
  });
});
