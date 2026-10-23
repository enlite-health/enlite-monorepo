/**
 * 069-fix-qa-caca-pedido.e2e.test.ts @integration — conserto dos defeitos D1, D3 e D4 da QA caça da spec 069. API HTTP real + Postgres real.
 *
 *  D1 saída agendada: "No vuelve más" numa pessoa que JÁ tem `valid_to` numa alocação do serviço = 409 `WORKER_HAS_SCHEDULED_EXIT`
 *     (o fim agendado antes do pedido NUNCA é sobrescrito), também na pré-visão (`permanent.scheduledExit`). Controle positivo: depois de
 *     desfazer o pedido que agendou a saída, o mesmo pedido grava.
 *  D3 pré-visão de conflito: candidato FORA do pool do serviço (outro país / outro paciente / sem candidatura) = 422 SEM chamar a função
 *     DEFINER `itinerary_substitute_conflict_preview` — provado pelo contador `pg_stat_user_functions` (track_functions=all).
 *  D4 concorrência: duas chamadas HTTP simultâneas no MESMO pedido/pessoa — exatamente uma vence, a outra leva 409; estado final consistente.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `ps069qa-${RUN}-`;
const FN = 'itinerary_substitute_conflict_preview';

describe('069 · QA caça: D1 saída agendada, D3 pool da pré-visão, D4 concorrência — API real @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let patientId = '';
  let addressId = '';
  let serviceId = '';
  let jobId = '';
  let hoje = '';
  const extraServiceIds: string[] = [];
  const extraJobIds: string[] = [];

  const baseUrl = (sid = serviceId): string => `/api/admin/patients/${patientId}/contracted-services/${sid}/substitution-requests`;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  const addDays = async (date: string, days: number): Promise<string> => (await q<{ d: string }>(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [date, days]))[0].d;
  const call = (method: 'post', url: string, data: unknown) => api[method](url, data, { headers: asAdmin.headers });

  async function mkWorker(label: string, opts: { job?: string | null; country?: string } = {}): Promise<string> {
    const job = opts.job === undefined ? jobId : opts.job;
    const workerId = (
      await q<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, $3) RETURNING id`, [`${PREFIX}${label}`, `${PREFIX}${label}@e2e.local`, opts.country ?? 'AR'])
    )[0].id;
    if (job !== null) {
      await pool.query(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'import')`, [workerId, job]);
    }
    return workerId;
  }
  let slotSeq = 0;
  /** Uma faixa de 1 h por chamada, sem nunca sobrepor outra do serviço (`pis_sem_sobreposicao`): dia da semana roda, a hora avança. */
  async function mkSlot(): Promise<string> {
    const n = slotSeq++;
    return (
      await q<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
         VALUES ($1, $2, make_time($3, 0, 0), 60, '[2026-01-01,)', $4, $4) RETURNING id`,
        [serviceId, n % 7, Math.floor(n / 7), PREFIX],
      )
    )[0].id;
  }
  async function allocate(slotId: string, workerId: string): Promise<string> {
    const res = await call('post', `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}/allocations`, { workerId });
    expect(res.status).toBe(201);
    return res.data.data.allocationId as string;
  }
  const validToOf = async (allocationId: string): Promise<string | null> =>
    (await q<{ v: string | null }>(`SELECT to_char(valid_to, 'YYYY-MM-DD') AS v FROM patient_itinerary_assignment WHERE id = $1`, [allocationId]))[0].v;
  const headersOf = async (outgoing: string): Promise<number> =>
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM patient_itinerary_substitution_request WHERE contracted_service_id = $1 AND outgoing_worker_id = $2`, [serviceId, outgoing]))[0].n;
  const permanent = (outgoing: string, from: string, substituteWorkerId: string | null = null) => ({
    type: 'PERMANENT', outgoingWorkerId: outgoing, from, reasonCategory: 'OTHER', substituteWorkerId,
  });

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`ps069qa-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });

    patientId = (await q<{ id: string }>(`INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Fix', 'QaCaca', 'AR', 'ACTIVE') RETURNING id`, [`${PREFIX}p1`]))[0].id;
    addressId = (await q<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`, [patientId]))[0].id;
    serviceId = (
      await q<{ id: string }>(`INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`, [patientId, addressId, PREFIX])
    )[0].id;
    jobId = (await q<{ id: string }>(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`, [`${PREFIX}vaga`, serviceId, patientId]))[0].id;
    hoje = (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS d`))[0].d;

    // contador de chamadas da função DEFINER (D3): vale para TODAS as sessões depois do reload
    await pool.query(`ALTER SYSTEM SET track_functions = 'all'`);
    await pool.query(`SELECT pg_reload_conf()`);
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    await pool.query(`ALTER SYSTEM RESET track_functions`);
    await pool.query(`SELECT pg_reload_conf()`);
    const sids = [serviceId, ...extraServiceIds];
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE contracted_service_id = ANY($1::uuid[])`, [sids]);
    await pool.query(
      `DELETE FROM patient_itinerary_absence ab USING patient_itinerary_assignment a, patient_itinerary_slot s
        WHERE ab.assignment_id = a.id AND a.slot_id = s.id AND s.contracted_service_id = ANY($1::uuid[])`,
      [sids],
    );
    await pool.query(`DELETE FROM patient_itinerary_substitution_request WHERE contracted_service_id = ANY($1::uuid[])`, [sids]);
    await pool.query(`DELETE FROM patient_itinerary_assignment a USING patient_itinerary_slot s WHERE a.slot_id = s.id AND s.contracted_service_id = ANY($1::uuid[])`, [sids]);
    await pool.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id = ANY($1::uuid[])`, [sids]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1::uuid[])`, [[jobId, ...extraJobIds]]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [[jobId, ...extraJobIds]]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  });

  // ── D1 ─────────────────────────────────────────────────────────────────────────────────────────
  it('D1: pessoa com saída AGENDADA (R1: sai em D com Pedro entrando) → R2 "No vuelve más" antes de D = 409 WORKER_HAS_SCHEDULED_EXIT; o fim de R1 NÃO é sobrescrito; pré-visão avisa; desfazer R1 libera (controle)', async () => {
    const juana = await mkWorker('juana');
    const pedro = await mkWorker('pedro');
    const allocationId = await allocate(await mkSlot(), juana);
    const saida = await addDays(hoje, 10);

    const r1 = await call('post', baseUrl(), permanent(juana, saida, pedro));
    expect(r1.status).toBe(201);
    expect(await validToOf(allocationId)).toBe(await addDays(saida, -1)); // Juana ACTIVE com valid_to = D-1

    const antes = await headersOf(juana);
    const previa = await call('post', `${baseUrl()}/preview`, { type: 'PERMANENT', outgoingWorkerId: juana, from: await addDays(hoje, 3), candidateWorkerIds: [] });
    expect(previa.status).toBe(200);
    expect(previa.data.data.permanent.scheduledExit).toBe(saida); // o 1º dia SEM ela

    const r2 = await call('post', baseUrl(), permanent(juana, await addDays(hoje, 3)));
    expect(r2.status).toBe(409);
    expect(r2.data).toMatchObject({ success: false, code: 'WORKER_HAS_SCHEDULED_EXIT', exitDate: saida });
    expect(await validToOf(allocationId)).toBe(await addDays(saida, -1)); // intacto
    expect(await headersOf(juana)).toBe(antes); // nenhum cabeçalho novo (nada escrito)

    // controle positivo: desfeito R1, a saída some e o MESMO R2 grava (fim em R2-1)
    const undo = await call('post', `${baseUrl()}/${r1.data.data.requestId}/undo`, {});
    expect(undo.status).toBe(200);
    expect(await validToOf(allocationId)).toBeNull();
    const ok = await call('post', baseUrl(), permanent(juana, await addDays(hoje, 3)));
    expect(ok.status).toBe(201);
    expect(await validToOf(allocationId)).toBe(await addDays(hoje, 2));
    const semFim = await call('post', `${baseUrl()}/preview`, { type: 'PERMANENT', outgoingWorkerId: await mkWorker('outra'), from: saida, candidateWorkerIds: [] });
    expect(semFim.status).toBe(422); // sem alocação não há pré-visão — o aviso só aparece para quem tem fim agendado
  });

  // ── D3 ─────────────────────────────────────────────────────────────────────────────────────────
  const fnCalls = async (): Promise<number> => {
    await pool.query(`SELECT pg_stat_clear_snapshot()`);
    return Number((await q<{ calls: string }>(`SELECT COALESCE(sum(calls), 0)::text AS calls FROM pg_stat_user_functions WHERE funcname = $1`, [FN]))[0].calls);
  };
  /** As estatísticas de função só sobem ao coletor quando o backend fica ocioso (até ~10 s): espera o contador chegar em `alvo` e dá folga para os demais backends. */
  const fnCallsAteChegarEm = async (alvo: number): Promise<number> => {
    for (let i = 0; i < 40; i++) {
      if ((await fnCalls()) >= alvo) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 1500));
    return fnCalls();
  };

  it('D3: candidato FORA do pool do serviço (outro país, candidato de OUTRO paciente, sem candidatura) → 422 NOT_SELECTED_FOR_SERVICE e a função DEFINER NÃO é chamada; candidato do pool consulta (controle)', async () => {
    const titular = await mkWorker('d3-titular');
    await allocate(await mkSlot(), titular);
    const dentro = await mkWorker('d3-dentro');
    const outroPais = await mkWorker('d3-br', { job: null, country: 'BR' });
    const outro = await (async () => {
      const sid = (await q<{ id: string }>(`INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`, [patientId, addressId, PREFIX]))[0].id;
      const job = (await q<{ id: string }>(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`, [`${PREFIX}vaga-outro`, sid, patientId]))[0].id;
      extraServiceIds.push(sid);
      extraJobIds.push(job);
      return mkWorker('d3-outro-servico', { job });
    })();
    const semCandidatura = await mkWorker('d3-sem-cand', { job: null });
    const from = await addDays(hoje, 14);
    // uma semana inteira (qualquer dia da semana cai na faixa do titular)
    const semana = (ids: string[]) => ({ type: 'DAYS', outgoingWorkerId: titular, from, to: '' as string, candidateWorkerIds: ids });
    const to = await addDays(from, 7);

    const base = await fnCalls();
    for (const intruso of [outroPais, outro, semCandidatura]) {
      const res = await call('post', `${baseUrl()}/preview`, { ...semana([dentro, intruso]), to });
      expect(res.status).toBe(422);
      expect(res.data.code).toBe('NOT_SELECTED_FOR_SERVICE');
    }
    const perm = await call('post', `${baseUrl()}/preview`, { type: 'PERMANENT', outgoingWorkerId: titular, from, candidateWorkerIds: [outroPais] });
    expect(perm.status).toBe(422);
    expect(perm.data.code).toBe('NOT_SELECTED_FOR_SERVICE');

    // controle positivo PRIMEIRO: o candidato do pool consulta a função (1 chamada por turno) e o contador CONTA
    const ok = await call('post', `${baseUrl()}/preview`, { ...semana([dentro]), to });
    expect(ok.status).toBe(200);
    const consultas = ok.data.data.conflicts.length as number;
    expect(consultas).toBeGreaterThan(0);
    // total = SÓ as consultas do candidato do pool: os 4 pedidos recusados (3 intrusos + PERMANENT) não somaram nenhuma chamada
    expect(await fnCallsAteChegarEm(base + consultas)).toBe(base + consultas);
  });

  // ── D4 ─────────────────────────────────────────────────────────────────────────────────────────
  it('D4: dois "No vuelve más" simultâneos da MESMA pessoa → exatamente um 201 e o outro recusado (409/422); um só cabeçalho; o fim agendado é o do vencedor', async () => {
    for (let round = 0; round < 3; round++) {
      const pessoa = await mkWorker(`d4-perm-${round}`);
      const allocationId = await allocate(await mkSlot(), pessoa);
      const d1 = await addDays(hoje, 20 + round);
      const d2 = await addDays(hoje, 40 + round);
      const [a, b] = await Promise.all([call('post', baseUrl(), permanent(pessoa, d1)), call('post', baseUrl(), permanent(pessoa, d2))]);
      // o perdedor lê o estado já commitado do vencedor: 409 (fim agendado dela) ou 422 (já não tem turno na data dele) — NUNCA os dois 201
      const [vencedor, perdedor] = a.status === 201 ? [a, b] : [b, a];
      expect(vencedor.status).toBe(201);
      expect([409, 422]).toContain(perdedor.status);
      expect(['WORKER_HAS_SCHEDULED_EXIT', 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD']).toContain(perdedor.data.code);
      expect(await headersOf(pessoa)).toBe(1);
      const vencedorD = a.status === 201 ? d1 : d2;
      expect(await validToOf(allocationId)).toBe(await addDays(vencedorD, -1));
    }
  });

  /** Um pedido DIAS (2 semanas de uma faixa) sem ninguém cobrindo; devolve o id e as datas. */
  async function pedidoSemSubstituto(round: number): Promise<{ requestId: string; absenceIds: string[] }> {
    const titular = await mkWorker(`d4-dias-${round}`);
    await allocate(await mkSlot(), titular);
    const from = await addDays(hoje, 7);
    const to = await addDays(from, 13);
    const pre = await call('post', `${baseUrl()}/preview`, { type: 'DAYS', outgoingWorkerId: titular, from, to, candidateWorkerIds: [] });
    expect(pre.status).toBe(200);
    const shifts = pre.data.data.shifts as Array<{ date: string; slotId: string }>;
    const criado = await call('post', baseUrl(), {
      type: 'DAYS', outgoingWorkerId: titular, from, to, reasonCategory: 'OTHER',
      shifts: shifts.map((s) => ({ date: s.date, slotId: s.slotId, substituteWorkerId: null })),
    });
    expect(criado.status).toBe(201);
    const requestId = criado.data.data.requestId as string;
    const absenceIds = (await q<{ id: string }>(`SELECT id FROM patient_itinerary_absence WHERE request_id = $1 ORDER BY on_date`, [requestId])).map((r) => r.id);
    expect(absenceIds.length).toBeGreaterThan(1);
    return { requestId, absenceIds };
  }

  it('D4: dois "Elegir quién entra" simultâneos no MESMO pedido com pessoas diferentes → um 200 e um 409; TODOS os turnos ficam com o MESMO substituto (nada misturado)', async () => {
    const pessoas = [await mkWorker('d4-cover-a'), await mkWorker('d4-cover-b')];
    for (let round = 0; round < 3; round++) {
      const { requestId, absenceIds } = await pedidoSemSubstituto(round);
      const [a, b] = await Promise.all(pessoas.map((p) => call('post', `${baseUrl()}/${requestId}/cover`, { substituteWorkerId: p })));
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const perdedor = a.status === 409 ? a : b;
      expect(['NOTHING_TO_COVER', 'ALREADY_COVERED']).toContain(perdedor.data.code);
      const vencedor = pessoas[a.status === 200 ? 0 : 1];
      const subs = await q<{ substitute_worker_id: string | null }>(`SELECT substitute_worker_id FROM patient_itinerary_absence WHERE id = ANY($1::uuid[])`, [absenceIds]);
      expect(new Set(subs.map((s) => s.substitute_worker_id))).toEqual(new Set([vencedor]));
    }
  });

  it('D4: desfazer × cobrir simultâneos → nunca 5xx; ou os dois passam (cobrir, depois desfazer) ou o cobrir leva 409; o pedido termina desfeito sem ausência viva futura', async () => {
    const pessoa = await mkWorker('d4-uc');
    for (let round = 0; round < 3; round++) {
      const { requestId, absenceIds } = await pedidoSemSubstituto(10 + round);
      const [undo, cover] = await Promise.all([call('post', `${baseUrl()}/${requestId}/undo`, {}), call('post', `${baseUrl()}/${requestId}/cover`, { substituteWorkerId: pessoa })]);
      expect(undo.status).toBe(200);
      expect([200, 409]).toContain(cover.status);
      if (cover.status === 409) expect(cover.data.code).toBe('REQUEST_ALREADY_UNDONE');
      const estado = (await q<{ undone: boolean }>(`SELECT undone_at IS NOT NULL AS undone FROM patient_itinerary_substitution_request WHERE id = $1`, [requestId]))[0];
      expect(estado.undone).toBe(true);
      const vivas = await q(`SELECT 1 FROM patient_itinerary_absence WHERE id = ANY($1::uuid[]) AND cancelled_at IS NULL`, [absenceIds]);
      expect(vivas).toHaveLength(0);
    }
  });

  it('D4: dois desfazer simultâneos → um 200 e um 409 REQUEST_ALREADY_UNDONE', async () => {
    const { requestId } = await pedidoSemSubstituto(20);
    const [a, b] = await Promise.all([call('post', `${baseUrl()}/${requestId}/undo`, {}), call('post', `${baseUrl()}/${requestId}/undo`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).data.code).toBe('REQUEST_ALREADY_UNDONE');
  });
});
