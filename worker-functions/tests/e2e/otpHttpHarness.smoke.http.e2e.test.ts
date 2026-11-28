/** Smoke do harness HTTP do OTP: a app sobe com as rotas reais; sem token = 401, com token chega ao controller. */
import { fechar, limpar, montarApp, tokenDe, type AppOtp } from './helpers/otpHttpHarness';

describe('otpHttpHarness (smoke)', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp(); });
  beforeEach(async () => { await limpar(); });
  afterAll(async () => { await limpar(); await fechar(); });

  it('sem Authorization: 401 em POST /api/auth/claim/start', async () => {
    const res = await app.http.post('/api/auth/claim/start').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authorization header required'); // vem do mockAuthMiddleware real, não do controller
  });

  it('com token: chega ao controller (400 Missing required field: phone)', async () => {
    const res = await app.http.post('/api/auth/claim/start').set('Authorization', tokenDe('uid-teste-smoke')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required field: phone');
  });
});
