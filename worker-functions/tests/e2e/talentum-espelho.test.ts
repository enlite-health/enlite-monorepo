/**
 * talentum-espelho.test.ts — o card ESPELHA o Talentum (a fonte da verdade). E2E de API contra o backend real + banco real.
 *
 *   [M2]      2 eventos do MESMO prescreening: o 1º resolvido por TÍTULO, o 2º por id → `job_posting_id` = a vaga DONA
 *             (o COALESCE antigo travava a vaga do título para sempre) e fica registrada a divergência REPOINTED.
 *   [ALARME]  evento cujo worker não se resolve nem se cria → 200 ao Talentum (status HTTP inalterado) e UMA linha em
 *             `talentum_webhook_divergences` (kind WORKER_NULL), na mesma transação do card.
 *
 * Cada pessoa usa telefone e e-mail ÚNICOS (o webhook agora funde pelo telefone normalizado: repetir telefone entre
 * pessoas diferentes as funde no mesmo worker).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ENDPOINT = '/api/webhooks/talentum/prescreening';

const M2 = {
  psc: 'espelho-m2-psc', prof: 'espelho-m2-prof', email: 'espelho.m2@test.local', phone: '+5491177710001',
  titleJob: 'CASO 9101 Espelho M2', ownerJob: 'Vaga DONA Espelho M2',
};
const AL = {
  psc: 'espelho-alarme-psc', prof: 'espelho-alarme-prof', phone: '+5491177710002',
  // e-mail válido para o Zod, mas maior que o VARCHAR(255) de workers.email: o auto-create falha → worker null
  email: `${'x'.repeat(250)}@e2e.test`,
};
const PSCS = [M2.psc, AL.psc];

describe('Talentum webhook — o card espelha o Talentum', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;
  let titleJobId: string;
  let ownerJobId: string;

  async function clean() {
    await pool.query(`DELETE FROM talentum_webhook_divergences WHERE talentum_prescreening_id = ANY($1::text[])`, [PSCS]);
    await pool.query(
      `DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[]))`, [PSCS]);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`, [PSCS]);
    await pool.query(
      `DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title = ANY($1::text[]))`,
      [[M2.titleJob, M2.ownerJob]]);
    await pool.query(
      `DELETE FROM encuadres WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title = ANY($1::text[]))`,
      [[M2.titleJob, M2.ownerJob]]);
    await pool.query(`DELETE FROM job_postings WHERE title = ANY($1::text[])`, [[M2.titleJob, M2.ownerJob]]);
    await pool.query(`DELETE FROM workers WHERE auth_uid = ANY($1::text[])`, [[`talentum_${M2.prof}`, `talentum_${AL.prof}`]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = createApiClient();
    await waitForBackend(api);
    await clean();
    const mkJ = async (title: string) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, description, status) VALUES ($1, 'test', 'SEARCHING') RETURNING id`, [title])).rows[0].id;
    titleJobId = await mkJ(M2.titleJob);
    ownerJobId = await mkJ(M2.ownerJob);
  });

  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it('[M2] 1º evento resolvido por título, 2º por id → job_posting_id = a vaga DONA', async () => {
    const event = (subtype: 'INITIATED' | 'IN_PROGRESS') => envelope({
      subtype,
      prescreening: { id: M2.psc, name: M2.titleJob },
      profile: { id: M2.prof, email: M2.email, phoneNumber: M2.phone, firstName: 'Ana', lastName: 'Espelho' },
    });

    const first = await api.post(ENDPOINT, event('INITIATED'));
    expect(first.status).toBe(200);
    expect(first.data.jobPostingId).toBe(titleJobId); // só o título resolve ainda

    // O prescreening passa a ter DONA (vaga com o `_id` gravado, como o publish/sync/backfill fazem)
    await pool.query(`UPDATE job_postings SET talentum_prescreening_id = $1 WHERE id = $2`, [M2.psc, ownerJobId]);

    const second = await api.post(ENDPOINT, event('IN_PROGRESS'));
    expect(second.status).toBe(200);
    expect(second.data.jobPostingId).toBe(ownerJobId);

    const { rows } = await pool.query<{ job_posting_id: string }>(
      `SELECT job_posting_id FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`, [M2.psc]);
    expect(rows).toHaveLength(1);
    expect(rows[0].job_posting_id).toBe(ownerJobId);

    // a troca fica registrada (vaga gravada antes → a dona)
    const { rows: div } = await pool.query<{ job_posting_id: string; expected_job_posting_id: string }>(
      `SELECT job_posting_id, expected_job_posting_id FROM talentum_webhook_divergences
        WHERE talentum_prescreening_id = $1 AND kind = 'JOB_POSTING_REPOINTED_TO_OWNER'`, [M2.psc]);
    expect(div).toHaveLength(1);
    expect(div[0].job_posting_id).toBe(titleJobId);
    expect(div[0].expected_job_posting_id).toBe(ownerJobId);
  });

  it('[ALARME] worker não resolvível → 200 inalterado e UMA linha WORKER_NULL em talentum_webhook_divergences', async () => {
    const res = await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: AL.psc, name: 'CASO INEXISTENTE ESPELHO 99999' },
      profile: { id: AL.prof, email: AL.email, phoneNumber: AL.phone, firstName: 'Bia', lastName: 'Alarme' },
    }));

    expect(res.status).toBe(200); // o status HTTP ao Talentum não muda
    expect(res.data.workerId).toBeNull();

    const { rows } = await pool.query<{ kind: string; worker_id: string | null; prescreening_id: string }>(
      `SELECT kind, worker_id, prescreening_id FROM talentum_webhook_divergences
        WHERE talentum_prescreening_id = $1 AND kind = 'WORKER_NULL'`, [AL.psc]);
    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBeNull();
    // mesma transação do card: a divergência aponta para a linha do prescreening gravada
    const { rows: card } = await pool.query(`SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`, [AL.psc]);
    expect(card).toHaveLength(1);
    expect(rows[0].prescreening_id).toBe(card[0].id);
  });
});
