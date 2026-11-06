/**
 * talentum-webhook-regressao.test.ts — suíte de REGRESSÃO do webhook Talentum, pela BORDA: POST real em
 * /api/webhooks/talentum/prescreening, API e Postgres reais (sem mock de SQL). Cada `it` nomeia o incidente de prd que
 * ele impede de voltar sem ninguém perceber (catálogo C1-C19: docs/funcionalidades/recrutamento-e-workers/estado-webhook-talentum.md).
 *
 * Só eventos INITIATED: não chegam ao Pub/Sub 'talentum-prescreening-qualified' (só QUALIFIED publica) e o StageMessageHandler
 * só manda mensagem para origem 'kanban'. Qualquer terceiro que o fluxo tentasse alcançar cai no bloqueio de rede da stack de teste.
 * Dados 100% sintéticos (e-mails @test.local, telefones fictícios), prefixo `rg-`.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ENDPOINT = '/api/webhooks/talentum/prescreening';
const P = 'rg-';

describe('Talentum webhook — regressão dos incidentes de prd (HTTP real)', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;

  const send = (o: { psc: string; prof: string; email: string; phone: string; title: string }) =>
    api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: o.psc, name: o.title },
      profile: { id: o.prof, email: o.email, phoneNumber: o.phone, firstName: 'Teste', lastName: 'Regressao' },
    }));

  const mkWorker = async (key: string, email: string, phone: string | null, mergedInto: string | null = null) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, merged_into_id) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', $4) RETURNING id`,
      [`${P}auth-${key}`, email, phone, mergedInto])).rows[0].id;

  const mkJob = async (title: string, opts: { draft?: boolean; deBaja?: boolean } = {}) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, status, is_draft, baja_reason)
       VALUES ($1, 'test', $2, $3, $4) RETURNING id`,
      [title, opts.deBaja ? 'DE_BAJA' : 'SEARCHING', opts.draft ?? false, opts.deBaja ? 'MANUAL' : null])).rows[0].id;

  const workersCreatedByWebhook = async (prof: string) =>
    (await pool.query(`SELECT id FROM workers WHERE auth_uid = $1`, [`talentum_${prof}`])).rows;
  const prescreeningRow = async (psc: string) =>
    (await pool.query<{ worker_id: string | null; job_posting_id: string | null; held_for_baja: boolean }>(
      `SELECT worker_id, job_posting_id, held_for_baja FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`, [psc])).rows;
  const divergences = async (psc: string, kind: string) =>
    (await pool.query(`SELECT id FROM talentum_webhook_divergences WHERE talentum_prescreening_id = $1 AND kind = $2`, [psc, kind])).rows;
  const wjas = async (workerId: string) =>
    (await pool.query(`SELECT job_posting_id FROM worker_job_applications WHERE worker_id = $1`, [workerId])).rows;

  async function clean() {
    const w = `(SELECT id FROM workers WHERE auth_uid LIKE '${P}auth-%' OR auth_uid LIKE 'talentum_${P}%')`;
    const j = `(SELECT id FROM job_postings WHERE title LIKE '%RG-REG%')`;
    await pool.query(`DELETE FROM talentum_webhook_divergences WHERE talentum_prescreening_id LIKE '${P}psc-%'`);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id IN ${w} OR job_posting_id IN ${j}`);
    await pool.query(`DELETE FROM encuadres WHERE worker_id IN ${w} OR job_posting_id IN ${j}`);
    await pool.query(
      `DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE '${P}psc-%')`);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE '${P}psc-%'`);
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' IN (SELECT id::text FROM workers WHERE auth_uid LIKE '${P}auth-%' OR auth_uid LIKE 'talentum_${P}%')`);
    await pool.query(`UPDATE workers SET merged_into_id = NULL WHERE auth_uid LIKE '${P}auth-%'`);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE '${P}auth-%' OR auth_uid LIKE 'talentum_${P}%'`);
    await pool.query(`DELETE FROM job_postings WHERE title LIKE '%RG-REG%'`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = createApiClient();
    await waitForBackend(api);
    await clean();
  });
  afterEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it('S1 (C4/C17, 04-05/11 e D111): e-mail do evento existe só num worker FUNDIDO → cai no canônico, sem worker novo e sem WORKER_NULL', async () => {
    const canonical = await mkWorker('s1-canon', 'rg.s1.canonico@test.local', '+5491166610001');
    // maiúscula no e-mail gravado: o INSERT do auto-create NÃO colide (índice único é case-sensitive), então só a busca acha o fundido
    await mkWorker('s1-merged', 'RG.S1.Fundido@Test.Local', '+5491166610002', canonical);
    const jobId = await mkJob('CASO 9301 RG-REG S1');

    const res = await send({ psc: `${P}psc-s1`, prof: `${P}prof-s1`, email: 'rg.s1.fundido@test.local', phone: '+5491166619999', title: 'CASO 9301 RG-REG S1' });

    expect(res.status).toBe(200);
    expect(res.data.workerId).toBe(canonical);
    expect(await workersCreatedByWebhook(`${P}prof-s1`)).toHaveLength(0);
    expect(await divergences(`${P}psc-s1`, 'WORKER_NULL')).toHaveLength(0);
    expect(await prescreeningRow(`${P}psc-s1`)).toEqual([{ worker_id: canonical, job_posting_id: jobId, held_for_baja: false }]);
    expect((await wjas(canonical)).map((r) => r.job_posting_id)).toEqual([jobId]);
  });

  it('S2 (C11/C17, 04/11 29 sem worker): telefone SEM o 9 (formato do Talentum) existe só no FUNDIDO (com o 9) → cai no canônico', async () => {
    const canonical = await mkWorker('s2-canon', 'rg.s2.canonico@test.local', '+5491166620001');
    await mkWorker('s2-merged', 'rg.s2.fundido@test.local', '+5491166620002', canonical);
    const jobId = await mkJob('CASO 9302 RG-REG S2');

    // 54 11 6662 0002 = o mesmo móvel do fundido (+549 11 6662 0002), sem o 9; e-mail que ninguém tem
    const res = await send({ psc: `${P}psc-s2`, prof: `${P}prof-s2`, email: 'rg.s2.ninguem@test.local', phone: '+541166620002', title: 'CASO 9302 RG-REG S2' });

    expect(res.status).toBe(200);
    expect(res.data.workerId).toBe(canonical);
    expect(await workersCreatedByWebhook(`${P}prof-s2`)).toHaveLength(0);
    expect(await divergences(`${P}psc-s2`, 'WORKER_NULL')).toHaveLength(0);
    expect((await prescreeningRow(`${P}psc-s2`))[0]).toMatchObject({ worker_id: canonical, job_posting_id: jobId });
  });

  it('S5 (C10, 02/11 D615): mesmo paciente com vaga rascunho e vaga oficial → o candidato vai para a OFICIAL', async () => {
    // rascunho criado ANTES: "título ILIKE ... LIMIT 1" sem preferir a oficial escolheria esta
    const draftId = await mkJob('CASO 9305 RG-REG S5 rascunho', { draft: true });
    const officialId = await mkJob('CASO 9305 RG-REG S5', { draft: false });
    await mkWorker('s5', 'rg.s5@test.local', '+5491166650001');

    const res = await send({ psc: `${P}psc-s5`, prof: `${P}prof-s5`, email: 'rg.s5@test.local', phone: '+5491166650001', title: 'CASO 9305 RG-REG S5' });

    expect(res.status).toBe(200);
    expect(res.data.jobPostingId).toBe(officialId);
    expect(res.data.jobPostingId).not.toBe(draftId);
    expect((await prescreeningRow(`${P}psc-s5`))[0].job_posting_id).toBe(officialId);
    expect((await wjas(res.data.workerId)).map((r) => r.job_posting_id)).toEqual([officialId]);
  });

  it('S6 (C15, 04/11 #811): vaga DE_BAJA não recebe candidato → resposta guardada e marcada, sem WJA e sem encuadre', async () => {
    const jobId = await mkJob('CASO 9306 RG-REG S6', { deBaja: true });
    const workerId = await mkWorker('s6', 'rg.s6@test.local', '+5491166660001');

    const res = await send({ psc: `${P}psc-s6`, prof: `${P}prof-s6`, email: 'rg.s6@test.local', phone: '+5491166660001', title: 'CASO 9306 RG-REG S6' });

    expect(res.status).toBe(200);
    expect(await prescreeningRow(`${P}psc-s6`)).toEqual([{ worker_id: workerId, job_posting_id: jobId, held_for_baja: true }]);
    expect(await wjas(workerId)).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM encuadres WHERE worker_id = $1`, [workerId])).rows).toHaveLength(0);
  });

  it('S7 (C14, 04/11): worker gravado com maiúscula e espaço no e-mail é achado pelo e-mail do evento (sem duplicar)', async () => {
    const workerId = await mkWorker('s7', ' RG.S7@Test.Local ', '+5491166670001');
    await mkJob('CASO 9307 RG-REG S7');

    // telefone que ninguém tem: só o e-mail normalizado pode achar o worker
    const res = await send({ psc: `${P}psc-s7`, prof: `${P}prof-s7`, email: 'rg.s7@test.local', phone: '+5491166679999', title: 'CASO 9307 RG-REG S7' });

    expect(res.status).toBe(200);
    expect(res.data.workerId).toBe(workerId);
    expect(await workersCreatedByWebhook(`${P}prof-s7`)).toHaveLength(0);
  });

  it('S8 (F16): 2 eventos INITIATED do mesmo prestador inexistente em paralelo → UM worker só, mesmo id nas duas respostas', async () => {
    await mkJob('CASO 9308 RG-REG S8');
    const ev = { psc: `${P}psc-s8`, prof: `${P}prof-s8`, email: 'rg.s8@test.local', phone: '+5491166680001', title: 'CASO 9308 RG-REG S8' };

    const [a, b] = await Promise.all([send(ev), send(ev)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    // conta por auth_uid E por e-mail: uma segunda criação nunca passa despercebida
    const created = (await pool.query(
      `SELECT id FROM workers WHERE auth_uid LIKE $1 OR LOWER(email) = 'rg.s8@test.local'`, [`talentum_${P}prof-s8%`])).rows;
    expect(created).toHaveLength(1);
    expect(a.data.workerId).toBe(created[0].id);
    expect(b.data.workerId).toBe(created[0].id);
    expect(await prescreeningRow(`${P}psc-s8`)).toHaveLength(1);
  });
});
