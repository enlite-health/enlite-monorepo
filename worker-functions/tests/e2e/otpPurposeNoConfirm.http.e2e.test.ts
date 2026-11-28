/**
 * E9 (B9): desafio `phone_verify` não confirma o claim e continua `pending`.
 *  (1) caminho natural: o confirm do claim com o id de um desafio phone_verify é recusado (4xx) e o desafio segue `pending`.
 *  (2) defesa em profundidade (a que morre com a sabotagem do `purpose` no UPDATE do `check`): o ledger "errou" e diz `claim` para
 *      um desafio que no banco é `phone_verify`, numa ficha reclamável; só o `purpose` do UPDATE impede o consumo.
 */
import { fechar, limpar, montarApp, pool, semearFicha, tokenDe, twilioDuble, type AppOtp } from './helpers/otpHttpHarness';

const statusDe = async (id: string) =>
  (await pool().query<{ status: string }>(`SELECT status FROM otp_challenges WHERE id = $1`, [id])).rows[0].status;

describe('E9: phone_verify não confirma o claim', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp(); });
  beforeEach(async () => { await limpar(); });
  afterAll(async () => { await limpar(); await fechar(); });

  it('(1) confirm do claim com o id de um desafio phone_verify: recusado, status pending', async () => {
    const uid = 'uid-teste-e9';
    await semearFicha({ uid });
    const start = await app.http.post('/api/workers/me/phone-verification/start').set('Authorization', tokenDe(uid)).send({ phone: '+5491100000000' });
    expect(start.status).toBe(200);
    const challengeId: string = start.body.data.challengeId ?? start.body.data.verificationSid;
    expect(challengeId).toBeDefined();
    const res = await app.http.post('/api/auth/claim/confirm').set('Authorization', tokenDe(uid))
      .send({ verificationSid: challengeId, otp: twilioDuble.lastCode, lgpdOptIn: true });
    const status = await statusDe(challengeId);
    console.info('E9(1)', JSON.stringify({ confirmStatus: res.status, code: res.body.error, statusNoBanco: status }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(status).toBe('pending');
  });

  it('(2) ledger dizendo claim para desafio phone_verify de ficha reclamável: recusado e o desafio segue pending', async () => {
    const uid = 'uid-teste-e9b';
    const ficha = await semearFicha({ uid, phone: '+5491100000000' });
    const start = await app.http.post('/api/workers/me/phone-verification/start').set('Authorization', tokenDe(uid)).send({ phone: '+5491100000000' });
    expect(start.status).toBe(200);
    const challengeId: string = start.body.data.challengeId ?? start.body.data.verificationSid;
    // A ficha vira "importada" (reclamável) e o ledger passa a dizer `claim`: a deriva que a defesa do `check` existe para barrar.
    await pool().query(`UPDATE workers SET auth_uid = $2, phone = '+5491100000000' WHERE id = $1`, [ficha, `candidatoimport_${uid}`]);
    await pool().query(`UPDATE otp_send_events SET purpose = 'claim' WHERE challenge_id = $1`, [challengeId]);
    const res = await app.http.post('/api/auth/claim/confirm').set('Authorization', tokenDe(uid))
      .send({ verificationSid: challengeId, otp: twilioDuble.lastCode, lgpdOptIn: true });
    const status = await statusDe(challengeId);
    console.info('E9(2)', JSON.stringify({ confirmStatus: res.status, code: res.body.error, statusNoBanco: status }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(status).toBe('pending');
  });
});
