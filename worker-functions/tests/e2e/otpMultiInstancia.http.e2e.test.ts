/**
 * E2 (B2): o limite por uid vale ENTRE instâncias, contado no banco, e o uid nunca vai em claro à chave.
 * Duas apps (routers próprios, mesmo banco) alternam N+1 starts do mesmo uid: a N+1 leva 429 RATE_LIMITED.
 */
import { fechar, limpar, montarApp, pool, semearFicha, tokenDe, type AppOtp } from './helpers/otpHttpHarness';
import { PHONE_VERIFICATION_START_UID_MAX } from '../../src/modules/auth/interfaces/routes/phoneVerificationRoutes';

const UID = 'uid-teste-e2';

describe('E2: limite por uid compartilhado entre instâncias (pv-start-uid)', () => {
  let a: AppOtp;
  let b: AppOtp;
  beforeAll(async () => { a = await montarApp(); b = await montarApp(); });
  beforeEach(async () => { await limpar(); await semearFicha({ uid: UID }); });
  afterAll(async () => { await limpar(); await fechar(); });

  it('N starts = 200 alternando instâncias; a N+1 = 429 RATE_LIMITED; o contador está no banco sem o uid', async () => {
    const instancias = [a, b];
    const statuses: number[] = [];
    let ultimo: { body: any } | null = null;
    for (let i = 0; i <= PHONE_VERIFICATION_START_UID_MAX; i++) {
      const res = await instancias[i % 2].http.post('/api/workers/me/phone-verification/start')
        .set('Authorization', tokenDe(UID)).send({ phone: '+5491100000000' });
      statuses.push(res.status);
      ultimo = { body: res.body };
    }
    console.info('E2 statuses', JSON.stringify(statuses));
    expect(statuses.slice(0, PHONE_VERIFICATION_START_UID_MAX).every((s) => s === 200)).toBe(true);
    expect(statuses[PHONE_VERIFICATION_START_UID_MAX]).toBe(429);
    expect(ultimo!.body.code).toBe('RATE_LIMITED');

    const porPrefixo = await pool().query(`SELECT count(*)::int AS n FROM rate_limit_counters WHERE key LIKE 'pv-start-uid:%'`);
    const comUid = await pool().query(`SELECT count(*)::int AS n FROM rate_limit_counters WHERE key LIKE '%uid-teste-e2%'`);
    console.info('E2 banco: prefixo', porPrefixo.rows[0].n, 'com uid em claro', comUid.rows[0].n);
    expect(porPrefixo.rows[0].n).toBe(1);
    expect(comUid.rows[0].n).toBe(0);
  });
});
