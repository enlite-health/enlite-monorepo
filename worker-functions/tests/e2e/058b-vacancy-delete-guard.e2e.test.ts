/**
 * 058b-vacancy-delete-guard.e2e.test.ts @integration — 058b/B2 (T247): guarda do `DELETE /api/admin/vacancies/:id`
 * (vaga com alocação vigente, entrada futura ou saída agendada no itinerário → 409). Passa pela API HTTP real
 * (`staffAuth`). ATENÇÃO: o stack E2E roda a API como DONO do banco (bypassa RLS) — estes casos provam o FLUXO
 * (409/200), não a RLS; a prova da guarda sob RLS é o B2-E2E-28. `deleteVacancy` dispara `tryPurgeShortLinks` em
 * `setImmediate`: o stack não pode ter chave do Short.io (conferido pelo orquestrador antes de rodar).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedB2, hojeAr, somaDias, limparB2, type SeedB2 } from './helpers/seedItinerarioB2';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `058b-vdel-${RUN}-`;

describe('DELETE /api/admin/vacancies/:id — guarda do itinerário (058 P6) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  let hoje = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`058b-vdel-admin-${RUN}`, 'admin');
    hoje = await hojeAr(pool);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 1000)); // `tryPurgeShortLinks` roda em setImmediate
    await limparB2(pool, TASK_PREFIX);
  });

  const nextTag = (): string => {
    seq += 1;
    return `${TASK_PREFIX}${seq}`;
  };

  async function vaga(s: SeedB2) {
    const r = await pool.query<{ apagada: boolean; status: string }>(
      `SELECT deleted_at IS NOT NULL AS apagada, status FROM job_postings WHERE id = $1`,
      [s.vacancyId],
    );
    return r.rows[0];
  }

  /** Alocações do serviço que a guarda conta como vigentes: ACTIVE e (valid_to IS NULL OU valid_to >= hoje). */
  async function vigentes(s: SeedB2): Promise<number> {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
        WHERE sl.contracted_service_id = $1 AND a.status = 'ACTIVE' AND (a.valid_to IS NULL OR a.valid_to >= $2::date)`,
      [s.serviceId, hoje],
    );
    return r.rows[0].n;
  }

  const apagar = (s: SeedB2) => api.delete(`/api/admin/vacancies/${s.vacancyId}`, { headers: asAdmin.headers });

  it('vigente (titular desde hoje): DELETE → 409 VACANCY_HAS_ACTIVE_ALLOCATIONS { count: 1 } e deleted_at continua NULL', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1 });
    expect(await vigentes(s)).toBe(1); // controle: contagem zero seria falha de medição
    const res = await apagar(s);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('VACANCY_HAS_ACTIVE_ALLOCATIONS');
    expect(res.data.details).toEqual({ count: 1 });
    expect((await vaga(s)).apagada).toBe(false);
  });

  it('só entrada futura (valid_from = hoje+7, nenhuma vigente hoje): DELETE → 409 — entrada futura conta (D449.1)', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: 7 });
    const hojeVigente = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
        WHERE sl.contracted_service_id = $1 AND a.status = 'ACTIVE' AND a.valid_from <= $2::date`,
      [s.serviceId, hoje],
    );
    expect(hojeVigente.rows[0].n).toBe(0); // nenhuma começou ainda
    expect(await vigentes(s)).toBe(1);
    const res = await apagar(s);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('VACANCY_HAS_ACTIVE_ALLOCATIONS');
    expect((await vaga(s)).apagada).toBe(false);
  });

  it('saída agendada (valid_to = hoje+7, ACTIVE): DELETE → 409 — saída agendada conta', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    await pool.query(`UPDATE patient_itinerary_assignment SET valid_to = $1::date WHERE id = $2`, [await somaDias(pool, hoje, 7), s.segAllocations[0]]);
    expect(await vigentes(s)).toBe(1);
    const res = await apagar(s);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('VACANCY_HAS_ACTIVE_ALLOCATIONS');
    expect((await vaga(s)).apagada).toBe(false);
  });

  it('só encerrada ontem (status ENDED, valid_to = ontem): DELETE → 200 e deleted_at preenchido', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    await pool.query(`UPDATE patient_itinerary_assignment SET status = 'ENDED', valid_to = $1::date WHERE id = $2`, [await somaDias(pool, hoje, -1), s.segAllocations[0]]);
    expect(await vigentes(s)).toBe(0);
    expect((await vaga(s)).apagada).toBe(false);
    const res = await apagar(s);
    expect(res.status).toBe(200);
    expect((await vaga(s)).apagada).toBe(true);
  });

  it('serviço 100% coberto: a vaga continua viva (nenhum fechamento automático; D448.4) e o DELETE segue recusado', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1 });
    const antes = await vaga(s);
    expect(antes.apagada).toBe(false);
    expect(antes.status).not.toMatch(/^closed$/i);
    const res = await apagar(s);
    expect(res.status).toBe(409);
    expect(await vaga(s)).toEqual(antes);
  });
});
