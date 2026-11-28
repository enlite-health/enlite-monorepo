/**
 * E3 (G1): só AR (+54) e BR (+55) enviam; a recusa do país não grava linha no ledger (`otp_send_events`).
 */
import { fechar, limpar, montarApp, pool, semearFicha, tokenDe, twilioDuble, type AppOtp } from './helpers/otpHttpHarness';

describe('E3: país do destino do OTP (phone-verification/start)', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp(); });
  beforeEach(async () => {
    await limpar();
    for (const n of [1, 2, 3]) await semearFicha({ uid: `uid-teste-e3-${n}` });
  });
  afterAll(async () => { await limpar(); await fechar(); });

  const start = (n: number, phone: string) =>
    app.http.post('/api/workers/me/phone-verification/start').set('Authorization', tokenDe(`uid-teste-e3-${n}`)).send({ phone });
  const eventos = async () => (await pool().query('SELECT count(*)::int AS n FROM otp_send_events')).rows[0].n as number;

  it('+1 recusado (400 PHONE_COUNTRY_NOT_SUPPORTED, ledger 0); +54 e +55 enviam (ledger 1 e 2)', async () => {
    const us = await start(1, '+12025550123');
    const nUs = await eventos();
    const ar = await start(2, '+5491100000000');
    const nAr = await eventos();
    const br = await start(3, '+5511900000000');
    const nBr = await eventos();
    console.info('E3', JSON.stringify({ us: us.status, usCode: us.body.code, nUs, ar: ar.status, nAr, br: br.status, nBr, twilio: twilioDuble.messagesCalls }));
    expect(us.status).toBe(400);
    expect(us.body.code).toBe('PHONE_COUNTRY_NOT_SUPPORTED');
    expect(nUs).toBe(0);
    expect(ar.status).toBe(200);
    expect(nAr).toBe(1);
    expect(br.status).toBe(200);
    expect(nBr).toBe(2);
    expect(twilioDuble.messagesCalls).toBe(2);
  });
});
