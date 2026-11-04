/**
 * vacancy-count-reader-085.e2e.test.ts — change 085 (T111), banco REAL, sem mock.
 *
 * Prova que o `VacancyCountReader` conta IGUAL ao dono de cada campo:
 *  (a) status=['SEARCHING',...] (o atalho `viva` expandido) == COUNT por `LIVE_JOB_POSTING_SQL` no mesmo recorte;
 *  (b) has_applicant=true == SQL direto com o critério de `vacancyListHelpers.ts:101`; worker DISABLED e estágio
 *      fora de POSTULATED_STAGES não contam;
 *  (c) vaga is_test e vaga is_draft (e deletada) não contam;
 *  (d) vaga sem endereço cai no rótulo sem zona;
 *  (e) vaga de outro país (BR) não conta com escopo AR.
 * Massa SINTÉTICA. Esperado exato por DELTA sobre o baseline medido antes de semear (o banco do e2e é compartilhado).
 */
import { Pool } from 'pg';
import { VacancyCountReader, type VacancyCountRequest } from '../../src/modules/agentes/infrastructure/VacancyCountReader';
import { OPEN_JOB_STATUSES, LIVE_JOB_POSTING_SQL } from '../../src/modules/matching/domain/openJobStatuses';
import { POSTULATED_STAGES, toSqlInList } from '../../src/modules/matching/domain/applicationFunnelStages';
import { resolveZoneKey, UNRESOLVED_ZONE_LABEL } from '../../src/shared/utils/zoneKey';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PFX = 'vcr-085-';
const W = {
  ativo: 'a1110000-0000-4000-a000-000000000001',
  baixa: 'a1110000-0000-4000-a000-000000000002',
};
const COUNTRIES = ['AR'] as never[];
const LIVE = [...OPEN_JOB_STATUSES] as string[];
const CORDOBA = resolveZoneKey('Córdoba', null).label;
const SALTA = resolveZoneKey('Salta', null).label;

interface V {
  key: string;
  status?: string;
  draft?: boolean;
  test?: boolean;
  deleted?: boolean;
  country?: string;
  addr?: [string, string] | null;
  apps?: Array<{ worker: string; stage: string }>;
}
// Massa: viva+postulante=v1; viva sem postulante efetivo (só DISABLED=v3, só INVITED=v4); ON_HOLD=v2; ruído v5-v8.
const SEEDS: V[] = [
  { key: 'v1', addr: ['Córdoba', 'Córdoba'], apps: [{ worker: W.ativo, stage: 'IN_PROGRESS' }] },
  { key: 'v2', status: 'ON_HOLD', addr: ['Salta', 'Salta'], apps: [{ worker: W.ativo, stage: 'COMPLETED' }] },
  { key: 'v3', addr: null, apps: [{ worker: W.baixa, stage: 'IN_PROGRESS' }] },
  { key: 'v4', addr: ['Córdoba', 'Córdoba'], apps: [{ worker: W.ativo, stage: 'INVITED' }] },
  { key: 'v5', test: true, addr: ['Córdoba', 'Córdoba'], apps: [{ worker: W.ativo, stage: 'IN_PROGRESS' }] },
  { key: 'v6', draft: true, addr: ['Córdoba', 'Córdoba'], apps: [{ worker: W.ativo, stage: 'IN_PROGRESS' }] },
  { key: 'v7', country: 'BR', addr: ['Córdoba', 'Córdoba'], apps: [{ worker: W.ativo, stage: 'IN_PROGRESS' }] },
  { key: 'v8', deleted: true, addr: ['Córdoba', 'Córdoba'], apps: [{ worker: W.ativo, stage: 'IN_PROGRESS' }] },
];

describe('VacancyCountReader × donos (banco real)', () => {
  let pool: Pool;
  let reader: VacancyCountReader;

  const req = (filters: VacancyCountRequest['filters'] = [], group_by: string | null = null): VacancyCountRequest => ({
    filters,
    group_by,
  });
  const f = (field: string, values: string[]) => ({ field, values });
  const total = async (r: VacancyCountRequest) => (await reader.count(r, COUNTRIES)).total;
  const groupOf = async (r: VacancyCountRequest, key: string) =>
    (await reader.count(r, COUNTRIES)).groups?.find((g) => g.key === key)?.value ?? 0;

  /** Oráculos: SQL direto do dono, mesmo recorte (não eliminada, não rascunho, não teste, AR). */
  const oracle = async (sql: string, extra = ''): Promise<number> =>
    (
      await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM job_postings jp
          WHERE ${sql} AND jp.is_test = false AND jp.country = ANY($1::bpchar[]) ${extra}`,
        [COUNTRIES],
      )
    ).rows[0].n;
  const POSTULANTE_DONO = `EXISTS (SELECT 1 FROM worker_job_applications wja JOIN workers wx ON wx.id = wja.worker_id
      WHERE wja.job_posting_id = jp.id AND wja.application_funnel_stage IN (${toSqlInList(POSTULATED_STAGES)})
        AND wx.status IS DISTINCT FROM 'DISABLED')`;

  const base = {} as Record<string, number>;
  const measure = async (): Promise<Record<string, number>> => ({
    all: await total(req()),
    viva: await total(req([f('status', LIVE)])),
    onHold: await total(req([f('status', ['ON_HOLD'])])),
    postul: await total(req([f('has_applicant', ['true'])])),
    semPostul: await total(req([f('has_applicant', ['false'])])),
    cordoba: await total(req([f('zone', [CORDOBA])])),
    semZona: await groupOf(req([], 'zone'), UNRESOLVED_ZONE_LABEL),
  });

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${PFX}%`]);
    await pool.query(`DELETE FROM patient_addresses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [`${PFX}%`]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PFX}%`]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [Object.values(W)]);
  }

  async function seedVacancy(v: V): Promise<void> {
    const country = v.country ?? 'AR';
    let addrId: string | null = null;
    if (v.addr) {
      const pid = (
        await pool.query<{ id: string }>(
          `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Sintetico', $2, $3, 'ACTIVE') RETURNING id`,
          [`${PFX}${v.key}`, `Vcr${v.key}`, country],
        )
      ).rows[0].id;
      addrId = (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_addresses (patient_id, country, state, city) VALUES ($1, $2, $3, $4) RETURNING id`,
          [pid, country, v.addr[0], v.addr[1]],
        )
      ).rows[0].id;
    }
    const jp = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, country, status, is_draft, is_test, deleted_at, patient_address_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [`${PFX}${v.key}`, country, v.status ?? 'SEARCHING', v.draft ?? false, v.test ?? false, v.deleted ? new Date() : null, addrId],
      )
    ).rows[0].id;
    for (const a of v.apps ?? []) {
      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage) VALUES ($1, $2, $3)`,
        [a.worker, jp, a.stage],
      );
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    reader = new VacancyCountReader(pool);
    await cleanup();
    Object.assign(base, await measure());
    for (const [id, status, n] of [[W.ativo, 'REGISTERED', '1'], [W.baixa, 'REGISTERED', '2']] as const) {
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
         VALUES ($1, $2, $3, $4, $5, 'AR', 'America/Argentina/Buenos_Aires')`,
        [id, `uid-111-${n}`, `vcr-111-${n}@e2e.test`, `+549000000011${n}`, status],
      );
    }
    for (const v of SEEDS) await seedVacancy(v);
    // o trigger de candidatura exige REGISTERED: a baixa vem DEPOIS de a candidatura existir (cenário real)
    await pool.query(`UPDATE workers SET status = 'DISABLED' WHERE id = $1`, [W.baixa]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('(a) status com o atalho viva == LIVE_JOB_POSTING_SQL no mesmo recorte (delta exato: v1, v3, v4)', async () => {
    const now = await measure();
    expect(now.viva).toBe(await oracle(LIVE_JOB_POSTING_SQL));
    expect(now.viva - base.viva).toBe(3);
    expect(now.onHold - base.onHold).toBe(1); // v2
  });

  it('(b) has_applicant=true == critério de vacancyListHelpers.ts:101; DISABLED e INVITED não contam', async () => {
    const now = await measure();
    expect(now.postul).toBe(await oracle('jp.deleted_at IS NULL AND jp.is_draft = false', `AND ${POSTULANTE_DONO}`));
    expect(now.postul - base.postul).toBe(2); // v1 (IN_PROGRESS) + v2 (COMPLETED); v3 só DISABLED, v4 só INVITED
    expect(now.semPostul - base.semPostul).toBe(2); // v3 + v4
  });

  it('(c) is_test, is_draft e deletada não contam; total do recorte = v1..v4', async () => {
    const now = await measure();
    expect(now.all - base.all).toBe(4);
    const direto = await oracle('jp.deleted_at IS NULL AND jp.is_draft = false');
    expect(now.all).toBe(direto);
  });

  it('(d) vaga sem endereço cai no rótulo sem zona; zona Córdoba conta v1+v4', async () => {
    const now = await measure();
    expect(now.semZona - base.semZona).toBe(1); // v3
    expect(now.cordoba - base.cordoba).toBe(2); // v1 + v4 (v5-v8 fora do recorte)
    expect(await groupOf(req([f('zone', [SALTA])], 'zone'), SALTA)).toBeGreaterThanOrEqual(1);
  });

  it('(e) vaga BR não conta com escopo AR e conta com escopo BR', async () => {
    const now = await measure(); // já incluída no delta de (c): v7 fora
    expect(now.all - base.all).toBe(4);
    const br = (await reader.count(req(), ['BR'] as never[])).total;
    const brOracle = (
      await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM job_postings jp
          WHERE jp.deleted_at IS NULL AND jp.is_draft = false AND jp.is_test = false AND jp.country = 'BR'`,
      )
    ).rows[0].n;
    expect(br).toBe(brOracle);
    expect(br).toBeGreaterThanOrEqual(1);
  });

  it('group_by status e has_applicant particionam o total', async () => {
    const byStatus = await reader.count(req([], 'status'), COUNTRIES);
    expect(byStatus.groups!.reduce((s, g) => s + g.value, 0)).toBe(byStatus.total);
    const byApp = await reader.count(req([], 'has_applicant'), COUNTRIES);
    expect(byApp.groups!.reduce((s, g) => s + g.value, 0)).toBe(byApp.total);
  });
});
