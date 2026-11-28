/**
 * E5 (G2, FR-95): ficha `is_test` com token `@enlite.test` é suprimida (o Twilio não é chamado) e NÃO gasta o teto global.
 * Com `OTP_GLOBAL_DAILY_MAX=1`, depois do suprimido um start de ficha comum ainda dá 200 (se o suprimido contasse, seria 503).
 * O suprimido é gravado (`suppressed = true`, o vínculo precisa da linha); a prova é a contagem de NÃO suprimidos.
 */
import { fechar, limpar, montarApp, pool, semearFicha, tokenDe, twilioDuble, type AppOtp } from './helpers/otpHttpHarness';

const HOJE_BA = `(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;

describe('E5: OTP suprimido (ficha is_test + token @enlite.test) não conta no teto', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp({ OTP_GLOBAL_DAILY_MAX: '1', E2E_OTP_CODE: '123456' }); });
  beforeEach(async () => {
    await limpar();
    await semearFicha({ uid: 'uid-teste-e5', isTest: true });
    await semearFicha({ uid: 'uid-teste-e5b', isTest: false });
  });
  afterAll(async () => { await limpar(); await fechar(); });

  const contar = async (where: string) => (await pool().query(`SELECT count(*)::int AS n FROM otp_send_events WHERE ${where}`)).rows[0].n as number;

  it('suprimido = 200 sem chamar o Twilio e 0 contados; o start de ficha comum seguinte = 200 e 1 contado', async () => {
    const r1 = await app.http.post('/api/workers/me/phone-verification/start')
      .set('Authorization', tokenDe('uid-teste-e5', 'uid-teste-e5@enlite.test')).send({ phone: '+5491100000000' });
    const chamadasDepoisDoPrimeiro = twilioDuble.messagesCalls;
    const naoSuprimidosDepoisDoPrimeiro = await contar(`NOT suppressed AND ${HOJE_BA}`);
    const suprimidos = await contar('suppressed');

    const r2 = await app.http.post('/api/workers/me/phone-verification/start')
      .set('Authorization', tokenDe('uid-teste-e5b', 'uid-teste-e5b@enlite.test')).send({ phone: '+5491100000001' });
    const naoSuprimidosDepoisDoSegundo = await contar(`NOT suppressed AND ${HOJE_BA}`);

    console.info('E5', JSON.stringify({ r1: r1.status, twilioAposPrimeiro: chamadasDepoisDoPrimeiro, naoSuprimidosAposPrimeiro: naoSuprimidosDepoisDoPrimeiro, suprimidos, r2: r2.status, naoSuprimidosAposSegundo: naoSuprimidosDepoisDoSegundo, twilioFinal: twilioDuble.messagesCalls }));
    expect(r1.status).toBe(200);
    expect(chamadasDepoisDoPrimeiro).toBe(0);
    expect(naoSuprimidosDepoisDoPrimeiro).toBe(0);
    expect(suprimidos).toBe(1);
    expect(r2.status).toBe(200);
    expect(naoSuprimidosDepoisDoSegundo).toBe(1);
    expect(twilioDuble.messagesCalls).toBe(1);
  });
});
