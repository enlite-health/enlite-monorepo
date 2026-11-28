/**
 * E7 (B4): o claim confirma pelo desafio do MESMO uid, nunca por id de ficha vindo do corpo.
 * Duas fichas importadas: A (telefone digitado) e B (outra pessoa). `uid-teste-e7` faz o start com o telefone de A; a resposta
 * não tem `candidateWorkerId`. O confirm leva, de má-fé, o id de B no corpo: a reivindicação cai em A e B fica idêntica.
 * Banco: só colunas sem PII (`id, auth_uid, status, updated_at`).
 */
import { fechar, limpar, montarApp, pool, tokenDe, twilioDuble, type AppOtp } from './helpers/otpHttpHarness';

const UID = 'uid-teste-e7';

async function semearImportada(sufixo: string, phone: string): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR') RETURNING id`,
    [`candidatoimport_uid-teste-e7-${sufixo}`, `e7-${sufixo}@enlite.test`, phone],
  );
  return rows[0].id;
}
const linha = async (id: string) =>
  (await pool().query(`SELECT id, auth_uid, status, updated_at::text AS updated_at FROM workers WHERE id = $1`, [id])).rows[0];

describe('E7: claim confirma pelo desafio do uid, não por id do corpo', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp(); });
  beforeEach(async () => { await limpar(); });
  afterAll(async () => { await limpar(); await fechar(); });

  it('start sem candidateWorkerId; confirm com o id de B no corpo reivindica A; B idêntica antes/depois', async () => {
    const a = await semearImportada('a', '+5491100000000');
    const b = await semearImportada('b', '+5491100000001');

    const start = await app.http.post('/api/auth/claim/start').set('Authorization', tokenDe(UID)).send({ phone: '+5491100000000' });
    expect(start.status).toBe(200);
    expect(start.body.data).not.toHaveProperty('candidateWorkerId');
    expect(JSON.stringify(start.body)).not.toContain(a);
    expect(typeof start.body.data.verificationSid).toBe('string');
    expect(twilioDuble.lastCode).toMatch(/^\d{6}$/);

    const bAntes = await linha(b);
    const confirm = await app.http.post('/api/auth/claim/confirm').set('Authorization', tokenDe(UID))
      .send({ verificationSid: start.body.data.verificationSid, otp: twilioDuble.lastCode, lgpdOptIn: true, candidateWorkerId: b });
    const bDepois = await linha(b);
    const aDepois = await linha(a);
    console.info('E7', JSON.stringify({ startKeys: Object.keys(start.body.data), confirmStatus: confirm.status, auth_uid_A: aDepois.auth_uid, B_antes: bAntes, B_depois: bDepois }));

    expect(confirm.status).toBe(200);
    expect(aDepois.auth_uid).toBe(UID);
    expect(bDepois.auth_uid).not.toBe(UID);
    expect(bDepois).toEqual(bAntes);
  });
});
