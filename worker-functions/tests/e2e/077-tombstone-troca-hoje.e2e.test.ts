/**
 * 077-tombstone-troca-hoje.e2e.test.ts @integration — spec 077 C-33 + D669: troca de prestadora com efeito HOJE
 * (`POST .../allocations/:id/replace` com `fromDate` = hoje) → a que sai recebe tombstone `ALLOCATION_ENDED` com o MESMO
 * `occurrence_id` do item de hoje; a que entra vê o item. Fim agendado SEM sucessora (saída sem substituta, D670) também gera
 * `ALLOCATION_ENDED`.
 * A troca passa pela API HTTP real (`staffAuth`); a semente é SQL como dono (`seedB2` + uma faixa no dia da semana de HOJE,
 * porque a chave da faixa é imutável depois de criada); o Reader roda em processo contra o MESMO banco, como dono (bypassa a
 * RLS: prova o SQL de `readEndedToday`, não a RLS).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedB2, hojeAr, somaDias, limparB2, type SeedB2 } from './helpers/seedItinerarioB2';
import { occurrenceIdOf, readWorkerWindow, type ItineraryEnvelope } from '../../src/modules/case/infrastructure/WorkerItineraryReader';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `077-troca-${RUN}-`;
const REASON = 'DESISTENCIA_DO_PRESTADOR';

/** Onde o `occurrence_id` aparece: quantas vezes em `items` e com que motivos em `tombstones`. */
const onde = (env: ItineraryEnvelope, id: string) => ({
  items: env.items.filter((i) => i.occurrence_id === id).length,
  tombstones: env.tombstones.filter((t) => t.occurrence_id === id).map((t) => t.reason),
});

describe('tombstone da troca com efeito hoje (077 C-33, D669) @integration', () => {
  const api = createApiClient();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  let asAdmin: { headers: { Authorization: string } };
  let hoje = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`077-troca-admin-${RUN}`, 'admin');
    hoje = await hojeAr(pool);
  });

  afterAll(async () => {
    // `limparB2` já fecha o pool no `finally` (helpers/seedItinerarioB2.ts): chamar o end de novo derruba a suíte.
    await limparB2(pool, TASK_PREFIX);
  });

  /** Serviço com 2 Selecionados e SEM titular na faixa da semente; a faixa do teste é a de hoje (`faixaDeHoje`). */
  async function cenario(): Promise<SeedB2> {
    seq += 1;
    return seedB2(pool, `${TASK_PREFIX}${seq}`, { schedule: 'ONE', providersNeeded: 1, titularesSeg: 0, selecionados: 2 });
  }

  /** Faixa 14:00 (60 min) no dia da semana de HOJE + titular `selecionados[0]` desde hoje + `desdeDias`. */
  async function faixaDeHoje(s: SeedB2, desdeDias: number): Promise<{ slotId: string; allocationId: string }> {
    const desde = await somaDias(pool, hoje, desdeDias);
    const slot = await pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, extract(dow FROM $2::date)::int, '14:00', 60, '[2026-01-01,)', $3, $3) RETURNING id`,
      [s.serviceId, hoje, TASK_PREFIX],
    );
    const alloc = await pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
       SELECT $1, a.worker_id, a.id, $3::date, 'ACTIVE', $4, $4 FROM worker_job_applications a
        WHERE a.worker_id = $2 AND a.job_posting_id = $5
       RETURNING id`,
      [slot.rows[0].id, s.selecionados[0], desde, TASK_PREFIX, s.vacancyId],
    );
    return { slotId: slot.rows[0].id, allocationId: alloc.rows[0].id };
  }

  /** O Reader do pull do app, no MESMO banco, com `today` = hoje civil de Buenos Aires. */
  async function janela(workerId: string): Promise<ItineraryEnvelope> {
    const client = await pool.connect();
    try {
      return await readWorkerWindow(client, { workerId, today: hoje });
    } finally {
      client.release();
    }
  }

  const trocar = (s: SeedB2, allocationId: string, newWorkerId: string) =>
    api.post(
      `/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/allocations/${allocationId}/replace`,
      { newWorkerId, fromDate: hoje, reasonCategory: REASON, destination: 'RESERVE' },
      { headers: asAdmin.headers },
    );

  async function situacao(id: string): Promise<{ status: string; vf: string; vt: string | null }> {
    const r = await pool.query<{ status: string; vf: string; vt: string | null }>(
      `SELECT status, to_char(valid_from,'YYYY-MM-DD') AS vf, to_char(valid_to,'YYYY-MM-DD') AS vt
         FROM patient_itinerary_assignment WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  it('T-F2a-71 titular desde antes: troca com efeito hoje → ela fica ACTIVE até ontem e recebe ALLOCATION_ENDED com o id do item de hoje; a nova vê o item', async () => {
    const s = await cenario();
    const { slotId, allocationId } = await faixaDeHoje(s, -7);
    const [sai, entra] = s.selecionados;
    const idSai = occurrenceIdOf(slotId, hoje, sai);
    expect(onde(await janela(sai), idSai)).toEqual({ items: 1, tombstones: [] });
    expect((await trocar(s, allocationId, entra)).status).toBe(200);
    expect(await situacao(allocationId)).toMatchObject({ status: 'ACTIVE', vt: await somaDias(pool, hoje, -1) });
    expect(onde(await janela(sai), idSai)).toEqual({ items: 0, tombstones: ['ALLOCATION_ENDED'] });
    expect(onde(await janela(entra), occurrenceIdOf(slotId, hoje, entra))).toEqual({ items: 1, tombstones: [] });
  });

  it('T-F2a-71 titular que começou hoje: troca com efeito hoje → ela fica CANCELLED e recebe ALLOCATION_ENDED', async () => {
    const s = await cenario();
    const { slotId, allocationId } = await faixaDeHoje(s, 0);
    const [sai, entra] = s.selecionados;
    expect((await trocar(s, allocationId, entra)).status).toBe(200);
    expect(await situacao(allocationId)).toMatchObject({ status: 'CANCELLED', vf: hoje });
    expect(onde(await janela(sai), occurrenceIdOf(slotId, hoje, sai))).toEqual({ items: 0, tombstones: ['ALLOCATION_ENDED'] });
  });

  it('T-F2a-71 fim agendado para ontem SEM sucessora (saída sem substituta) → também ALLOCATION_ENDED (D670)', async () => {
    const s = await cenario();
    const { slotId, allocationId } = await faixaDeHoje(s, -7);
    await pool.query(`UPDATE patient_itinerary_assignment SET valid_to = $2::date - 1 WHERE id = $1`, [allocationId, hoje]);
    const [sai] = s.selecionados;
    expect(onde(await janela(sai), occurrenceIdOf(slotId, hoje, sai))).toEqual({ items: 0, tombstones: ['ALLOCATION_ENDED'] });
  });
});
