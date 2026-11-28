/**
 * E10 (B11): a validade gravada do código é de 10 minutos (`expires_at - created_at`), medida no banco depois de 1 start válido.
 */
import { fechar, limpar, montarApp, pool, semearFicha, tokenDe, type AppOtp } from './helpers/otpHttpHarness';

describe('E10: validade gravada = 10 minutos', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp(); });
  beforeEach(async () => { await limpar(); await semearFicha({ uid: 'uid-teste-e10' }); });
  afterAll(async () => { await limpar(); await fechar(); });

  it('1 start válido grava 1 desafio com expires_at - created_at = 10 minutos', async () => {
    const res = await app.http.post('/api/workers/me/phone-verification/start').set('Authorization', tokenDe('uid-teste-e10')).send({ phone: '+5491100000000' });
    expect(res.status).toBe(200);
    const { rows } = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM otp_challenges WHERE expires_at - created_at = interval '10 minutes'`);
    const total = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM otp_challenges`);
    console.info('E10', JSON.stringify({ comDezMinutos: rows[0].n, total: total.rows[0].n }));
    expect(total.rows[0].n).toBe(1);
    expect(rows[0].n).toBe(1);
  });
});
