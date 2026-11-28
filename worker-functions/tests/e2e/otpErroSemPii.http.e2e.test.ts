/**
 * E6 (B8): erro do Twilio com o telefone na mensagem não vaza para log, `reportError`, stdout/stderr/console nem para a resposta.
 * Ramo (a): OTP próprio (messages.create lança). Ramo (b): plano B, Verify (verifications.create lança). Em cada um,
 * 1 claim/start (ficha importada candidata com o telefone) e 1 phone-verification/start.
 */
import { capturarSaida, fechar, limpar, montarApp, semearFicha, tokenDe, twilioDuble, type AppOtp } from './helpers/otpHttpHarness';

const FONE = '5491100000000';
const MSG_CRUA = 'failed to send to +5491100000000';

describe('E6: erro do Twilio sem PII em log e resposta', () => {
  // `fechar()` só no fim: depois dele o pool singleton do DatabaseConnection não serve a uma 2ª `montarApp`.
  afterEach(async () => { await limpar(); });
  afterAll(async () => { await fechar(); });

  async function rodar(app: AppOtp, tag: string) {
    await semearFicha({ uid: `uid-teste-e6${tag}`, authUid: `candidatoimport_uid-teste-e6${tag}`, email: `cand-e6${tag}@enlite.test`, phone: '+5491100000000' });
    await semearFicha({ uid: `uid-teste-e6${tag}-own` });
    const cap = await capturarSaida();
    const respostas: Array<{ status: number; texto: string }> = [];
    try {
      const c = await app.http.post('/api/auth/claim/start').set('Authorization', tokenDe(`uid-teste-e6${tag}-tok`)).send({ phone: '+5491100000000' });
      respostas.push({ status: c.status, texto: c.text });
      const p = await app.http.post('/api/workers/me/phone-verification/start').set('Authorization', tokenDe(`uid-teste-e6${tag}-own`)).send({ phone: '+5491100000000' });
      respostas.push({ status: p.status, texto: p.text });
    } finally { cap.parar(); }
    console.info('E6', tag, JSON.stringify({ statuses: respostas.map((r) => r.status), linhasCapturadas: cap.linhas.length, twilio: [twilioDuble.messagesCalls, twilioDuble.verifyCalls] }));
    return { cap, respostas };
  }

  function semVazamento({ cap, respostas }: Awaited<ReturnType<typeof rodar>>) {
    expect(cap.linhas.length).toBeGreaterThan(0); // contagem zero seria "não capturei", não sucesso
    const tudo = [...cap.linhas, ...respostas.map((r) => r.texto)].join('\n');
    expect(tudo).not.toContain(FONE);
    expect(tudo).not.toContain('+' + FONE);
    expect(tudo).not.toContain('failed to send to');
    expect(respostas.every((r) => !r.texto.includes(MSG_CRUA))).toBe(true);
  }

  it('(a) OTP próprio: messages.create lança com o telefone na mensagem', async () => {
    twilioDuble.messagesThrows = null;
    const app = await montarApp();
    twilioDuble.messagesThrows = new Error(MSG_CRUA);
    const r = await rodar(app, 'a');
    expect(twilioDuble.messagesCalls).toBeGreaterThanOrEqual(2);
    expect(r.respostas.every((x) => x.status === 503)).toBe(true);
    semVazamento(r);
  });

  it('(b) plano B (Verify): verifications.create lança com o telefone na mensagem', async () => {
    const app = await montarApp({ TWILIO_AUTH_TEMPLATE_CONTENT_SID: undefined });
    twilioDuble.verifyThrows = new Error(MSG_CRUA);
    const r = await rodar(app, 'b');
    expect(twilioDuble.verifyCalls).toBeGreaterThanOrEqual(2);
    semVazamento(r);
    const alerta = r.cap.linhas.filter((l) => l.includes('twilio_verify_start_failed'));
    expect(alerta.length).toBeGreaterThanOrEqual(1);
  });
});
