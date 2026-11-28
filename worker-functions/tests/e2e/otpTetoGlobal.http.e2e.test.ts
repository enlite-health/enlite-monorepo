/**
 * E4 (G2): teto global diário de envios de OTP. Com `OTP_GLOBAL_DAILY_MAX=2`, o 3º start do dia recebe 503
 * OTP_CHANNEL_UNAVAILABLE e o log do alerta (`otp_global_ceiling_reached`) sai, sem o telefone.
 */
import { capturarSaida, fechar, limpar, montarApp, pool, semearFicha, tokenDe, twilioDuble, type AppOtp } from './helpers/otpHttpHarness';

describe('E4: teto global diário do OTP', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp({ OTP_GLOBAL_DAILY_MAX: '2' }); });
  beforeEach(async () => {
    await limpar();
    for (const n of [1, 2, 3]) await semearFicha({ uid: `uid-teste-e4-${n}` });
  });
  afterAll(async () => { await limpar(); await fechar(); });

  it('2 starts = 200; o 3º = 503 OTP_CHANNEL_UNAVAILABLE; log do teto sem telefone; 2 envios contados no dia de Buenos Aires', async () => {
    const cap = await capturarSaida();
    const statuses: number[] = [];
    let terceiro: any = null;
    try {
      for (const n of [1, 2, 3]) {
        const res = await app.http.post('/api/workers/me/phone-verification/start')
          .set('Authorization', tokenDe(`uid-teste-e4-${n}`)).send({ phone: '+5491100000000' });
        statuses.push(res.status);
        terceiro = res.body;
      }
    } finally { cap.parar(); }
    const alerta = cap.linhas.filter((l) => l.includes('otp_global_ceiling_reached'));
    const { rows } = await pool().query(
      `SELECT count(*)::int AS n FROM otp_send_events WHERE NOT suppressed
         AND (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`,
    );
    console.info('E4', JSON.stringify({ statuses, code: terceiro.code, linhasAlerta: alerta.length, naoSuprimidosHoje: rows[0].n, twilio: twilioDuble.messagesCalls, linhasCapturadas: cap.linhas.length }));
    expect(statuses).toEqual([200, 200, 503]);
    expect(terceiro.code).toBe('OTP_CHANNEL_UNAVAILABLE');
    expect(alerta.length).toBeGreaterThanOrEqual(1);
    const log = JSON.parse(alerta[0]);
    expect(log.msg ?? log.message).toBe('otp_global_ceiling_reached');
    expect(log.sent).toBe(2);
    expect(log.dailyMax).toBe(2);
    expect(alerta[0]).not.toContain('5491100000000');
    expect(rows[0].n).toBe(2);
  });
});
