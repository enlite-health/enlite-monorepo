/**
 * 058b-tirar-agendado.e2e.test.ts @integration — 058b/B2 (T244): `POST .../itinerary/allocations/:id/end` de quem tem
 * AGENDAMENTO (substituto em ausência futura de outro titular, ou entrada futura). Passa SEMPRE pela API HTTP real
 * (`staffAuth`); a semente e as ausências são SQL como dono. A API roda como dono no stack E2E (bypassa RLS): prova o FLUXO.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedB2, hojeAr, somaDias, proximoDia, limparB2, type SeedB2 } from './helpers/seedItinerarioB2';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `058b-tirar-${RUN}-`;

describe('POST …/allocations/:id/end com agendamento — API real (058 P5c) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  let hoje = '';
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`058b-tirar-admin-${RUN}`, 'admin');
    hoje = await hojeAr(pool);
  });

  afterAll(async () => {
    await limparB2(pool, TASK_PREFIX);
  });

  const nextTag = (): string => {
    seq += 1;
    return `${TASK_PREFIX}${seq}`;
  };
  const endUrl = (s: SeedB2, allocationId: string): string =>
    `/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/allocations/${allocationId}/end`;

  async function applicationOf(allocationId: string): Promise<string> {
    const r = await pool.query<{ application_id: string }>(`SELECT application_id FROM patient_itinerary_assignment WHERE id = $1`, [allocationId]);
    return r.rows[0].application_id;
  }

  /** C = titular na segunda; A = titular na quarta; C é SUBSTITUTO nas 2 próximas quartas de A (ausências por SQL como dono). */
  async function cenarioSubstituto(tag: string) {
    const s = await seedB2(pool, tag, { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, titularesQua: 1, desdeDias: -7 });
    const d1 = await proximoDia(pool, s.hoje, 3);
    const d2 = await somaDias(pool, d1, 7);
    const appC = await applicationOf(s.segAllocations[0]);
    for (const d of [d1, d2]) {
      await pool.query(
        `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
         VALUES ($1, $2::date, $3, $4, 'e2e', 'e2e')`,
        [s.quaAllocations[0], d, s.segWorkers[0], appC],
      );
    }
    return { s, d1, d2 };
  }

  async function snapshot(s: SeedB2) {
    const r = await pool.query(
      `SELECT (SELECT coalesce(json_agg(x ORDER BY x), '[]'::json) FROM (
                 SELECT a.status || ':' || a.worker_id::text || ':' || a.valid_from::text || ':' || coalesce(a.valid_to::text, 'NULL') AS x
                   FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id
                  WHERE sl.contracted_service_id = $1) t) AS alocacoes,
              (SELECT count(*)::int FROM patient_itinerary_change_log WHERE contracted_service_id = $1) AS registros,
              (SELECT count(*)::int FROM contracted_service_rejections WHERE service_id = $1) AS marcas,
              (SELECT count(*)::int FROM patient_itinerary_absence ab
                 WHERE ab.substitute_worker_id IS NOT NULL AND ab.cancelled_at IS NULL
                   AND ab.assignment_id IN (SELECT a.id FROM patient_itinerary_assignment a JOIN patient_itinerary_slot sl ON sl.id = a.slot_id WHERE sl.contracted_service_id = $1)) AS com_substituto`,
      [s.serviceId],
    );
    return r.rows[0];
  }

  it('LEAVE_SERVICE com agendamento e SEM cancelScheduled → 409 WORKER_HAS_SCHEDULED_ATTENDANCES com as 2 datas; snapshot antes = depois', async () => {
    const { s, d1, d2 } = await cenarioSubstituto(nextTag());
    const before = await snapshot(s);
    // Controle (contagem zero = falha): as 2 ausências com substituto existem ANTES do POST.
    expect(before).toMatchObject({ com_substituto: 2, registros: 0, marcas: 0 });

    const res = await api.post(endUrl(s, s.segAllocations[0]), { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE' }, { headers: asAdmin.headers });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('WORKER_HAS_SCHEDULED_ATTENDANCES');
    expect(res.data.details.substitutionDates).toEqual([d1, d2]);
    expect(res.data.details.futureEntryFrom).toBeNull();
    expect(await snapshot(s)).toEqual(before);
  });

  it('com cancelScheduled: as 2 ausências seguem abertas com substituto NULL; 2 SUBSTITUTE_CANCELLED + 1 REMOVE; C encerrado; marca de rejeição; A continua titular', async () => {
    const { s } = await cenarioSubstituto(nextTag());
    const res = await api.post(
      endUrl(s, s.segAllocations[0]),
      { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE', cancelScheduled: true },
      { headers: asAdmin.headers },
    );
    expect(res.status).toBe(200);

    const abs = await pool.query(
      `SELECT id, substitute_worker_id, cancelled_at FROM patient_itinerary_absence WHERE assignment_id = $1 ORDER BY on_date`,
      [s.quaAllocations[0]],
    );
    expect(abs.rows).toHaveLength(2);
    for (const a of abs.rows) {
      expect(a.substitute_worker_id).toBeNull();
      expect(a.cancelled_at).toBeNull();
    }
    const kinds = await pool.query(
      `SELECT kind, count(*)::int AS n FROM patient_itinerary_change_log WHERE contracted_service_id = $1 GROUP BY kind ORDER BY kind`,
      [s.serviceId],
    );
    expect(kinds.rows).toEqual([{ kind: 'REMOVE', n: 1 }, { kind: 'SUBSTITUTE_CANCELLED', n: 2 }]);
    const canc = await pool.query(
      `SELECT absence_id, destination, reason_code FROM patient_itinerary_change_log
        WHERE contracted_service_id = $1 AND kind = 'SUBSTITUTE_CANCELLED' ORDER BY absence_id`,
      [s.serviceId],
    );
    expect(canc.rows).toEqual(
      abs.rows.map((a) => ({ absence_id: a.id, destination: null, reason_code: 'OTHER' })).sort((x, y) => (x.absence_id < y.absence_id ? -1 : 1)),
    );
    const c = await pool.query(`SELECT status FROM patient_itinerary_assignment WHERE id = $1`, [s.segAllocations[0]]);
    expect(c.rows[0].status).toBe('ENDED');
    const marks = await pool.query(
      `SELECT worker_id, reject_reason_category FROM contracted_service_rejections WHERE service_id = $1 AND reverted_at IS NULL`,
      [s.serviceId],
    );
    expect(marks.rows).toEqual([{ worker_id: s.segWorkers[0], reject_reason_category: 'OTHER' }]);
    const a = await pool.query(`SELECT status FROM patient_itinerary_assignment WHERE id = $1`, [s.quaAllocations[0]]);
    expect(a.rows[0].status).toBe('ACTIVE');
  });

  /** Alocação ACTIVE do prestador C (da segunda) numa faixa extra, mesma candidatura. */
  async function alocarCNa(s: SeedB2, slotId: string, validFrom: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4::date, 'ACTIVE', 'e2e', 'e2e') RETURNING id`,
      [slotId, s.segWorkers[0], await applicationOf(s.segAllocations[0]), validFrom],
    );
    return r.rows[0].id;
  }

  /** A linha de `patient_itinerary_change_log` que o replace real grava (kind REPLACE: titular → substituto, ligados por assignment_id/new_assignment_id). */
  async function ligarReplace(s: SeedB2, outgoingWorkerId: string, assignmentId: string, newAssignmentId: string, effectiveDate: string): Promise<void> {
    await pool.query(
      `INSERT INTO patient_itinerary_change_log
         (contracted_service_id, kind, outgoing_worker_id, incoming_worker_id, assignment_id, new_assignment_id, effective_date, reason_code, destination, created_by)
       SELECT $1, 'REPLACE', $2, a.worker_id, $3, a.id, $5::date, 'OTHER', 'RESERVE', 'e2e'
         FROM patient_itinerary_assignment a WHERE a.id = $4`,
      [s.serviceId, outgoingWorkerId, assignmentId, newAssignmentId, effectiveDate],
    );
  }

  it('entrada futura: cancelada ANTES de soltar o fim do titular — entrada CANCELLED, A com valid_to NULL, 1 ENTRY_CANCELLED, C encerrado e rejeitado', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, titularesQua: 1, desdeDias: -7 });
    const d = await somaDias(pool, hoje, 7);
    await pool.query(`UPDATE patient_itinerary_assignment SET valid_to = $1::date WHERE id = $2`, [await somaDias(pool, hoje, 6), s.quaAllocations[0]]);
    const entradaId = await alocarCNa(s, s.slotQuaId as string, d);
    // O titular da entrada é achado pela LIGAÇÃO do REPLACE (nunca pela data): a fixture grava a linha que o replace real grava (ReplaceWithReasonUseCase).
    await ligarReplace(s, s.quaWorkers[0], s.quaAllocations[0], entradaId, d);

    const sem = await api.post(endUrl(s, s.segAllocations[0]), { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE' }, { headers: asAdmin.headers });
    expect(sem.status).toBe(409);
    expect(sem.data.details.futureEntryFrom).toBe(d);
    expect(sem.data.details.substitutionDates).toEqual([]);

    const com = await api.post(endUrl(s, s.segAllocations[0]), { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE', cancelScheduled: true }, { headers: asAdmin.headers });
    expect(com.status).toBe(200);

    const entrada = await pool.query(`SELECT status FROM patient_itinerary_assignment WHERE id = $1`, [entradaId]);
    expect(entrada.rows[0].status).toBe('CANCELLED');
    const a = await pool.query(`SELECT status, valid_to IS NULL AS sem_fim FROM patient_itinerary_assignment WHERE id = $1`, [s.quaAllocations[0]]);
    expect(a.rows[0]).toEqual({ status: 'ACTIVE', sem_fim: true });
    const kinds = await pool.query(
      `SELECT kind, count(*)::int AS n FROM patient_itinerary_change_log WHERE contracted_service_id = $1 GROUP BY kind ORDER BY kind`,
      [s.serviceId],
    );
    // O REPLACE é o da fixture (a ligação do titular); o tirar grava só ENTRY_CANCELLED + REMOVE e não cria REPLACE novo.
    expect(kinds.rows).toEqual([{ kind: 'ENTRY_CANCELLED', n: 1 }, { kind: 'REMOVE', n: 1 }, { kind: 'REPLACE', n: 1 }]);
    const ec = await pool.query(
      `SELECT assignment_id, to_char(effective_date,'YYYY-MM-DD') AS d, destination FROM patient_itinerary_change_log
        WHERE contracted_service_id = $1 AND kind = 'ENTRY_CANCELLED'`,
      [s.serviceId],
    );
    expect(ec.rows).toEqual([{ assignment_id: entradaId, d, destination: null }]);
    const c = await pool.query(`SELECT status FROM patient_itinerary_assignment WHERE id = $1`, [s.segAllocations[0]]);
    expect(c.rows[0].status).toBe('ENDED');
    const marks = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contracted_service_rejections WHERE service_id = $1 AND worker_id = $2 AND reverted_at IS NULL`,
      [s.serviceId, s.segWorkers[0]],
    );
    expect(marks.rows[0].n).toBe(1);
  });

  it('titular vigente com outra alocação vigente (segunda E quarta) e LEAVE_SERVICE: continua 422 SERVICE_TEAM_WORKER_ALLOCATED, snapshot igual', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    await alocarCNa(s, s.slotQuaId as string, await somaDias(pool, hoje, -7));
    const before = await snapshot(s);
    const res = await api.post(endUrl(s, s.segAllocations[0]), { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE' }, { headers: asAdmin.headers });
    expect(res.status).toBe(422);
    expect(res.data.code).toBe('SERVICE_TEAM_WORKER_ALLOCATED');
    expect(await snapshot(s)).toEqual(before);
  });

  it('sem agendamento (RESERVE, 1 alocação): 200 direto, 1 REMOVE, nenhum cancelamento', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: -7 });
    const res = await api.post(endUrl(s, s.segAllocations[0]), { reasonCategory: 'OTHER', destination: 'RESERVE' }, { headers: asAdmin.headers });
    expect(res.status).toBe(200);
    const kinds = await pool.query(
      `SELECT kind, count(*)::int AS n FROM patient_itinerary_change_log WHERE contracted_service_id = $1 GROUP BY kind ORDER BY kind`,
      [s.serviceId],
    );
    expect(kinds.rows).toEqual([{ kind: 'REMOVE', n: 1 }]);
  });

  // ── (9) 🔴 e D1 (D530 item 7): o titular reaberto/restaurado vem da LIGAÇÃO do REPLACE, passando pelo replace REAL ──────────────────
  const replaceUrl = (s: SeedB2, allocationId: string): string =>
    `/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}/itinerary/allocations/${allocationId}/replace`;

  async function replace(s: SeedB2, titularAllocId: string, novoWorkerId: string, fromDate: string): Promise<void> {
    const res = await api.post(
      replaceUrl(s, titularAllocId),
      { newWorkerId: novoWorkerId, fromDate, reasonCategory: 'OTHER', destination: 'RESERVE' },
      { headers: asAdmin.headers },
    );
    expect(res.status).toBe(200);
  }

  async function alocacao(id: string) {
    const r = await pool.query<{ status: string; vf: string; vt: string | null }>(
      `SELECT status, to_char(valid_from,'YYYY-MM-DD') AS vf, to_char(valid_to,'YYYY-MM-DD') AS vt FROM patient_itinerary_assignment WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  /** A alocação (não cancelada) do prestador na faixa — a que o replace real criou. */
  async function alocacaoDe(slotId: string, workerId: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM patient_itinerary_assignment WHERE slot_id = $1 AND worker_id = $2 AND status <> 'CANCELLED'`,
      [slotId, workerId],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0].id;
  }

  /** W passa a ter também uma alocação VIGENTE na faixa da segunda (é ela que a rota `end` encerra); a entrada futura dele já veio do replace real. */
  async function alocarVigente(workerId: string, slotId: string): Promise<string> {
    const app = await pool.query<{ id: string }>(`SELECT id FROM worker_job_applications WHERE worker_id = $1`, [workerId]);
    const r = await pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4::date, 'ACTIVE', 'e2e', 'e2e') RETURNING id`,
      [slotId, workerId, app.rows[0].id, await somaDias(pool, hoje, -7)],
    );
    return r.rows[0].id;
  }

  const tirarTudo = (s: SeedB2, allocationId: string) =>
    api.post(endUrl(s, allocationId), { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE', cancelScheduled: true }, { headers: asAdmin.headers });

  it('(9) N=2: T1 e T2 terminam no mesmo dia; T2→S2 ANTES de T1→W; tirar W reabre T1 (a ligação), não T2', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 2, titularesSeg: 0, titularesQua: 2, selecionados: 2, desdeDias: -7 });
    const [t1, t2] = s.quaAllocations;
    const [w, s2] = s.selecionados;
    const d = await somaDias(pool, hoje, 7);
    const dMenos1 = await somaDias(pool, d, -1);
    await replace(s, t2, s2, d); // a ordem que fazia o subselect por data errar
    await replace(s, t1, w, d);
    const wSeg = await alocarVigente(w, s.slotSegId);
    const wQua = await alocacaoDe(s.slotQuaId as string, w);
    // Controle (contagem zero = falha): os dois titulares terminam na véspera ANTES de tirar W.
    expect(await alocacao(t1)).toEqual({ status: 'ACTIVE', vf: await somaDias(pool, hoje, -7), vt: dMenos1 });
    expect(await alocacao(t2)).toEqual({ status: 'ACTIVE', vf: await somaDias(pool, hoje, -7), vt: dMenos1 });

    expect((await tirarTudo(s, wSeg)).status).toBe(200);

    expect(await alocacao(t1)).toMatchObject({ status: 'ACTIVE', vt: null });
    expect(await alocacao(t2)).toMatchObject({ status: 'ACTIVE', vt: dMenos1 });
    expect(await alocacao(await alocacaoDe(s.slotQuaId as string, s2))).toMatchObject({ status: 'ACTIVE', vf: d, vt: null });
    expect((await alocacao(wQua)).status).toBe('CANCELLED');
  });

  it('controle negativo: o titular ligado já está ENDED por outro caminho → tirar W não reabre nada', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'TWO', providersNeeded: 1, titularesSeg: 0, titularesQua: 1, selecionados: 1, desdeDias: -7 });
    const [t] = s.quaAllocations;
    const [w] = s.selecionados;
    const d = await somaDias(pool, hoje, 7);
    await replace(s, t, w, d);
    await pool.query(`UPDATE patient_itinerary_assignment SET status = 'ENDED' WHERE id = $1`, [t]); // encerrado por fora do replace/tirar
    const antes = await alocacao(t);
    expect(antes).toMatchObject({ status: 'ENDED', vt: await somaDias(pool, d, -1) });
    const wSeg = await alocarVigente(w, s.slotSegId);

    expect((await tirarTudo(s, wSeg)).status).toBe(200);

    expect(await alocacao(t)).toEqual(antes);
  });
});
