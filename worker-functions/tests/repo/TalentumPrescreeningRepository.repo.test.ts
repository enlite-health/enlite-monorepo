/**
 * TalentumPrescreeningRepository — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), com as migrations aplicadas
 * (565 = `talentum_webhook_divergences`). Prova o que o espelho Talentum → card exige (M2):
 *
 *  - a vaga DONA do `talentum_prescreening_id` (resolvida por id, `jobPostingResolvedById: true`) SOBRESCREVE a vaga
 *    gravada antes por título — o `COALESCE` antigo travava a vaga errada para sempre;
 *  - a resolução só por título (ou null) NUNCA sobrescreve uma vaga já gravada (a proteção original continua);
 *  - `previousJobPostingId` devolve a vaga gravada antes do evento (base do alarme de divergência);
 *  - M8: `findByEmailNormalized` acha o worker com e-mail em outra caixa/espaço, trata 2 candidatos como ambíguo e ignora merged; o `findByEmail` do LOGIN segue exato;
 *  - a divergência grava só ids/tipo, e o CHECK de `kind` barra tipo fora da lista.
 *
 * Como rodar: ver `tests/repo/AxonicoLancamentoRepository.repo.test.ts` (Postgres isolado + migrations + jest.config.repo.js).
 */
import { Pool } from 'pg';
import { WorkerRepository } from '../../src/modules/worker/infrastructure/WorkerRepository';
import { TalentumPrescreeningRepository } from '../../src/modules/matching/infrastructure/TalentumPrescreeningRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e';

const PRESC_PREFIX = 'repo-test-espelho-';
const WORKER_UID = 'talentum-espelho-repo-test-uid';

describe('TalentumPrescreeningRepository (banco real) — espelho do Talentum', () => {
  let pool: Pool;
  let repo: TalentumPrescreeningRepository;
  let jpTitle: string;
  let jpOwner: string;
  let workerId: string;

  const dto = (n: string, over: Record<string, unknown> = {}) => ({
    talentumPrescreeningId: `${PRESC_PREFIX}${n}`,
    talentumProfileId: `${PRESC_PREFIX}prof-${n}`,
    workerId,
    jobPostingId: jpTitle as string | null,
    jobCaseName: 'CASO TESTE',
    status: 'IN_PROGRESS' as const,
    ...over,
  });

  const storedJob = async (n: string) =>
    (await pool.query('SELECT job_posting_id FROM talentum_prescreenings WHERE talentum_prescreening_id = $1', [`${PRESC_PREFIX}${n}`]))
      .rows[0]?.job_posting_id;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    repo = new TalentumPrescreeningRepository();
    const w = await pool.query(
      `INSERT INTO workers (auth_uid, email, status) VALUES ($1, 'talentum-espelho-repo@test.invalid', 'INCOMPLETE_REGISTER')
       ON CONFLICT (auth_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [WORKER_UID],
    );
    workerId = w.rows[0].id;
    jpTitle = (await pool.query(`INSERT INTO job_postings (title, description, status) VALUES ('Espelho TITULO', 'x', 'SEARCHING') RETURNING id`)).rows[0].id;
    jpOwner = (await pool.query(`INSERT INTO job_postings (title, description, status) VALUES ('Espelho DONA', 'x', 'SEARCHING') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM talentum_webhook_divergences WHERE talentum_prescreening_id LIKE $1`, [`${PRESC_PREFIX}%`]);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE $1`, [`${PRESC_PREFIX}%`]);
    await pool.query('DELETE FROM job_postings WHERE id = ANY($1)', [[jpTitle, jpOwner]]);
    await pool.query('DELETE FROM workers WHERE auth_uid = $1', [WORKER_UID]);
    await pool.end();
  });

  it('M2: o 2º evento resolvido por id leva o card para a DONA, não fica na vaga do título', async () => {
    const first = await repo.upsertPrescreening(dto('m2a', { jobPostingId: jpTitle, jobPostingResolvedById: false }));
    expect(first.previousJobPostingId).toBeNull();
    expect(await storedJob('m2a')).toBe(jpTitle);

    const second = await repo.upsertPrescreening(dto('m2a', { jobPostingId: jpOwner, jobPostingResolvedById: true, status: 'COMPLETED' }));
    expect(second.previousJobPostingId).toBe(jpTitle);
    expect(second.prescreening.jobPostingId).toBe(jpOwner);
    expect(await storedJob('m2a')).toBe(jpOwner);
  });

  it('título nunca sobrescreve a vaga gravada (resolução por título ou null mantém o COALESCE)', async () => {
    await repo.upsertPrescreening(dto('m2b', { jobPostingId: jpOwner, jobPostingResolvedById: true }));
    await repo.upsertPrescreening(dto('m2b', { jobPostingId: jpTitle, jobPostingResolvedById: false }));
    expect(await storedJob('m2b')).toBe(jpOwner);
    await repo.upsertPrescreening(dto('m2b', { jobPostingId: null, jobPostingResolvedById: false }));
    expect(await storedJob('m2b')).toBe(jpOwner);
  });

  it('divergência: grava só ids/tipo e o CHECK barra kind fora da lista', async () => {
    const { prescreening } = await repo.upsertPrescreening(dto('div', { workerId: null, jobPostingId: null }));
    await repo.insertDivergence({
      kind: 'WORKER_NULL',
      talentumPrescreeningId: `${PRESC_PREFIX}div`,
      talentumProfileId: `${PRESC_PREFIX}prof-div`,
      prescreeningId: prescreening.id,
      workerId: null,
      jobPostingId: null,
      expectedJobPostingId: null,
      environment: 'production',
    });
    const rows = (await pool.query('SELECT kind, prescreening_id, resolved_at FROM talentum_webhook_divergences WHERE talentum_prescreening_id = $1', [`${PRESC_PREFIX}div`])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('WORKER_NULL');
    expect(rows[0].prescreening_id).toBe(prescreening.id);
    expect(rows[0].resolved_at).toBeNull();

    await expect(
      pool.query(`INSERT INTO talentum_webhook_divergences (kind, talentum_prescreening_id, talentum_profile_id) VALUES ('QUALQUER', 'x', 'y')`),
    ).rejects.toThrow(/check/i);
  });
  it('M8: findByEmailNormalized acha com caixa/espaço; findByEmail (login) continua EXATO; ambíguo e merged', async () => {
    const workers = Object.create(WorkerRepository.prototype) as WorkerRepository;
    Object.assign(workers, { pool, encryptionService: { decrypt: async () => '' } });

    const norm = await workers.findByEmailNormalized('  Talentum-Espelho-REPO@Test.Invalid ');
    expect(norm.getValue()?.id).toBe(workerId);
    expect((await workers.findByEmailNormalized('ninguem@test.invalid')).getValue()).toBeNull();

    // O login NÃO normaliza: caixa/espaço diferentes não casam (como antes do M8)
    expect((await workers.findByEmail('  Talentum-Espelho-REPO@Test.Invalid ')).getValue()).toBeNull();
    expect((await workers.findByEmail('talentum-espelho-repo@test.invalid')).getValue()?.id).toBe(workerId);

    // 2º worker vivo com o mesmo e-mail em outra caixa → ambíguo (nunca escolhe)
    const dup = (await pool.query(`INSERT INTO workers (auth_uid, email, status) VALUES ('talentum-espelho-repo-dup', 'TALENTUM-ESPELHO-REPO@test.invalid', 'INCOMPLETE_REGISTER') RETURNING id`)).rows[0].id;
    try {
      const amb = await workers.findByEmailNormalized('talentum-espelho-repo@test.invalid');
      expect(amb.getValue()).toBeNull();
      expect(amb.ambiguousCount).toBe(2);
      // merged_into_id desempata: o duplicado fundido sai do conjunto
      await pool.query('UPDATE workers SET merged_into_id = $1 WHERE id = $2', [workerId, dup]);
      expect((await workers.findByEmailNormalized('talentum-espelho-repo@test.invalid')).getValue()?.id).toBe(workerId);
    } finally {
      await pool.query('DELETE FROM workers WHERE id = $1', [dup]);
    }
  });
});
