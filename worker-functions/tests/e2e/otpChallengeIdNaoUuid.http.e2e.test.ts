/**
 * E8 (B7): `challengeId` que não é UUID não chega ao Postgres (22P02 viraria 500): a resposta é 4xx com o `code` do controller.
 */
import { fechar, limpar, montarApp, semearFicha, tokenDe, type AppOtp } from './helpers/otpHttpHarness';

const UID = 'uid-teste-e8';

describe('E8: challengeId que não é UUID dá 4xx, nunca 500', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp(); });
  beforeEach(async () => { await limpar(); await semearFicha({ uid: UID }); });
  afterAll(async () => { await limpar(); await fechar(); });

  it.each(['VEabc', '1; drop'])('confirm com challengeId %j: 4xx, nunca 500', async (challengeId) => {
    const res = await app.http.post('/api/workers/me/phone-verification/confirm')
      .set('Authorization', tokenDe(UID)).send({ phone: '+5491100000000', challengeId, code: '123456' });
    console.info('E8', JSON.stringify({ challengeId, status: res.status, code: res.body.code, error: res.body.error }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(500);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.code).toBe('string');
    expect(res.body.code).not.toBe('INTERNAL');
  });
});
