/**
 * 069-schema.e2e.test.ts @integration — spec 069, F1 (migration 548).
 *
 * Prova, contra Postgres real, as travas do banco do pedido de substituição: cada uma INSERE a violação e FALHA com o código/nome certo
 * (T105); a pré-visão do conflito do substituto como `app_runtime` (T106); e a paridade pré-visão × gatilho da ausência (T107).
 * Cada trava tem um CONTROLE POSITIVO ao lado (o mesmo comando, sem a violação, passa): erro que sai por outro motivo não prova a trava.
 */
import { Pool, type PoolClient } from 'pg';
import { seedSubstitutionRequest } from './helpers/seedSubstitutionRequest';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `s069-${RUN}-`;
const SEGUNDA = 1;
const TERCA = 2;
const ACTOR = `${PREFIX}actor`;

interface PgErr {
  code?: string;
  constraint?: string;
  message: string;
  detail?: string;
}

async function pgErr(p: Promise<unknown>): Promise<PgErr> {
  try {
    await p;
  } catch (e) {
    return e as PgErr;
  }
  throw new Error('esperava erro do Postgres, mas a operação foi aceita');
}

describe('069 · pedido de substituição, travas e pré-visão do conflito — migration 548 @integration', () => {
  let pool: Pool;
  let seq = 0;
  const jobIds: string[] = [];
  const patientIds: string[] = [];
  let addrA = '';
  let addrB = '';
  let patientId = '';
  let reasonOther = 'OTHER';
  let reasonAlt = '';
  let nextMonday = '';

  // ── semente ────────────────────────────────────────────────────────────────────────────────────
  async function one<T = { id: string }>(sql: string, params: unknown[]): Promise<T> {
    return (await pool.query(sql, params)).rows[0] as T;
  }

  async function mkWorker(label: string): Promise<string> {
    const l = `${label}${++seq}`;
    return (
      await one<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`, [
        `${PREFIX}${l}`,
        `${PREFIX}${l}@e2e.local`,
      ])
    ).id;
  }

  interface Svc {
    serviceId: string;
    jobId: string;
  }
  async function mkService(addressId: string): Promise<Svc> {
    const serviceId = (
      await one<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientId, addressId, PREFIX],
      )
    ).id;
    const jobId = (
      await one<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${PREFIX}job${++seq}`, serviceId, patientId],
      )
    ).id;
    jobIds.push(jobId);
    return { serviceId, jobId };
  }

  async function mkSlot(svc: Svc, weekday: number, start: string, minutes: number): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '[2026-01-01,)', $5, $5) RETURNING id`,
        [svc.serviceId, weekday, start, minutes, PREFIX],
      )
    ).id;
  }

  async function mkWja(workerId: string, jobId: string): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobId],
      )
    ).id;
  }

  /** Alocação ACTIVE de `workerId` na faixa (cria a candidatura da vaga do serviço). */
  async function allocate(svc: Svc, slotId: string, workerId: string): Promise<string> {
    const wja = await mkWja(workerId, svc.jobId);
    return (
      await one<{ id: string }>(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', NULL, 'ACTIVE', $4, $4) RETURNING id`,
        [slotId, workerId, wja, PREFIX],
      )
    ).id;
  }

  function insertAbsence(
    assignmentId: string,
    onDate: string,
    requestId: string | null,
    sub: { workerId: string; wjaId: string } | null = null,
  ) {
    return pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_absence
         (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by, request_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
      [assignmentId, onDate, sub?.workerId ?? null, sub?.wjaId ?? null, PREFIX, requestId],
    );
  }

  function insertLog(o: {
    serviceId: string;
    kind: string;
    outgoing: string;
    reason?: string;
    requestId?: string | null;
    absenceId?: string | null;
    destination?: string | null;
  }) {
    return pool.query(
      `INSERT INTO patient_itinerary_change_log
         (contracted_service_id, kind, outgoing_worker_id, absence_id, effective_date, reason_code, destination, created_by, request_id)
       VALUES ($1, $2, $3, $4, '2026-10-05', $5, $6, $7, $8) RETURNING id`,
      [o.serviceId, o.kind, o.outgoing, o.absenceId ?? null, o.reason ?? reasonOther, o.destination ?? null, PREFIX, o.requestId ?? null],
    );
  }

  async function weekdayDate(dow: number, offsetWeeks = 0): Promise<string> {
    const r = await pool.query<{ d: string }>(
      `SELECT to_char(g::date + $2::int * 7, 'YYYY-MM-DD') AS d
         FROM (SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS t) x, generate_series(x.t + 1, x.t + 7, interval '1 day') g
        WHERE extract(dow FROM g) = $1`,
      [dow, offsetWeeks],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0].d;
  }

  async function asAppRuntime<T>(uid: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_runtime');
      await c.query(`SELECT set_config('app.user_country', 'AR', true)`);
      if (uid) await c.query(`SELECT set_config('app.user_uid', $1, true)`, [uid]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    nextMonday = await weekdayDate(SEGUNDA);
    const reasons = await pool.query<{ code: string }>(`SELECT code FROM service_exit_reasons WHERE active ORDER BY (code = 'OTHER') DESC, code`);
    expect(reasons.rows.length).toBeGreaterThanOrEqual(2);
    reasonOther = reasons.rows[0].code;
    reasonAlt = reasons.rows[1].code;
    patientId = (
      await one<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Pedido', 'Esquema', 'AR', 'ACTIVE') RETURNING id`,
        [`${PREFIX}p`],
      )
    ).id;
    patientIds.push(patientId);
    addrA = (await one<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`, [patientId])).id;
    addrB = (await one<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`, [patientId])).id;
  });

  afterAll(async () => {
    // despacho → notificações → eventos → log → ausências → pedidos → alocações → WJA → vagas → pacientes (serviços/faixas em cascata) → workers
    await pool.query(`DELETE FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM notification_events WHERE actor_uid = $1`, [ACTOR]);
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE created_by = $1`, [PREFIX]);
    await pool.query(`DELETE FROM patient_itinerary_absence WHERE created_by = $1`, [PREFIX]);
    await pool.query(`DELETE FROM patient_itinerary_substitution_request WHERE created_by = $1`, [PREFIX]);
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE created_by = $1`, [PREFIX]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1::uuid[])`, [jobIds]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [jobIds]);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [patientIds]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PREFIX}%`]);
    const left = await pool.query(
      `SELECT (SELECT count(*) FROM patient_itinerary_substitution_request WHERE created_by = $1)::int AS req,
              (SELECT count(*) FROM workers WHERE auth_uid LIKE $2)::int AS wrk`,
      [PREFIX, `${PREFIX}%`],
    );
    expect(left.rows[0]).toEqual({ req: 0, wrk: 0 });
    await pool.end();
  });

  // ── cenário-base de um pedido: serviço + faixa de segunda + titular alocado ─────────────────────
  async function base() {
    const svc = await mkService(addrA);
    const slotId = await mkSlot(svc, SEGUNDA, '08:00', 240);
    const titular = await mkWorker('tit');
    const assignmentId = await allocate(svc, slotId, titular);
    return { svc, slotId, titular, assignmentId };
  }

  // ════════════════════════════ T105 · as travas, uma a uma ════════════════════════════════════════
  describe('T105 · travas do cabeçalho, da ausência e do registro', () => {
    it('controle positivo: pedido + ausência + registro ABSENCE coerentes são aceitos', async () => {
      const b = await base();
      const req = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, reasonCode: reasonOther, createdBy: PREFIX });
      const abs = (await insertAbsence(b.assignmentId, nextMonday, req)).rows[0].id;
      const log = await insertLog({ serviceId: b.svc.serviceId, kind: 'ABSENCE', outgoing: b.titular, requestId: req, absenceId: abs });
      expect(log.rows[0].id).toBeTruthy();
      const c = await pool.query(`SELECT country FROM patient_itinerary_substitution_request WHERE id = $1`, [req]);
      expect(c.rows[0].country).toBe('AR'); // herdado do serviço por trigger
    });

    it('registro com reason_code ≠ cabeçalho → 23503 picl_request_fk; com pessoa ≠ cabeçalho → 23503 (e o igual passa)', async () => {
      const b = await base();
      const req = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, reasonCode: reasonOther, createdBy: PREFIX });
      const abs = (await insertAbsence(b.assignmentId, nextMonday, req)).rows[0].id;
      const motivo = await pgErr(insertLog({ serviceId: b.svc.serviceId, kind: 'ABSENCE', outgoing: b.titular, reason: reasonAlt, requestId: req, absenceId: abs }));
      expect(motivo.code).toBe('23503');
      expect(motivo.constraint).toBe('picl_request_fk');
      const outro = await mkWorker('outro');
      const pessoa = await pgErr(insertLog({ serviceId: b.svc.serviceId, kind: 'ABSENCE', outgoing: outro, requestId: req, absenceId: abs }));
      expect(pessoa.code).toBe('23503');
      expect(pessoa.constraint).toBe('picl_request_fk');
      // REPLACE no mesmo pedido, motivo e pessoa iguais: passa (controle positivo da FK composta)
      const ok = await insertLog({ serviceId: b.svc.serviceId, kind: 'REPLACE', outgoing: b.titular, requestId: req, destination: 'RESERVE' });
      expect(ok.rows[0].id).toBeTruthy();
    });

    it('ABSENCE sem request_id → trigger picl_absence_sem_pedido (23514)', async () => {
      const b = await base();
      const req = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const abs = (await insertAbsence(b.assignmentId, nextMonday, req)).rows[0].id;
      const e = await pgErr(insertLog({ serviceId: b.svc.serviceId, kind: 'ABSENCE', outgoing: b.titular, requestId: null, absenceId: abs }));
      expect(e.code).toBe('23514');
      expect(e.message).toBe('picl_absence_sem_pedido');
    });

    it('ABSENCE com request_id diferente do da ausência → picl_pedido_diverge_da_ausencia (23514)', async () => {
      const b = await base();
      const req1 = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const req2 = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const abs = (await insertAbsence(b.assignmentId, nextMonday, req1)).rows[0].id;
      const e = await pgErr(insertLog({ serviceId: b.svc.serviceId, kind: 'ABSENCE', outgoing: b.titular, requestId: req2, absenceId: abs }));
      expect(e.code).toBe('23514');
      expect(e.message).toBe('picl_pedido_diverge_da_ausencia');
    });

    it('ausência sem request_id → piab_request_obrigatorio (23514)', async () => {
      const b = await base();
      const e = await pgErr(insertAbsence(b.assignmentId, nextMonday, null));
      expect(e.code).toBe('23514');
      expect(e.message).toBe('piab_request_obrigatorio');
    });

    it('ausência em pedido DESFEITO → piab_pedido_desfeito (23514); com pedido vigente passa', async () => {
      const b = await base();
      const desfeito = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      await pool.query(`UPDATE patient_itinerary_substitution_request SET undone_at = now(), undone_by = $2 WHERE id = $1`, [desfeito, ACTOR]);
      const e = await pgErr(insertAbsence(b.assignmentId, nextMonday, desfeito));
      expect(e.code).toBe('23514');
      expect(e.message).toBe('piab_pedido_desfeito');
      const vigente = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      expect((await insertAbsence(b.assignmentId, nextMonday, vigente)).rows[0].id).toBeTruthy();
    });

    it('ausência de pedido com titular ≠ outgoing_worker_id → piab_pedido_de_outro_titular; de outro serviço → piab_pedido_de_outro_servico', async () => {
      const b = await base();
      const outro = await mkWorker('outro');
      const reqOutroTitular = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: outro, createdBy: PREFIX });
      const e1 = await pgErr(insertAbsence(b.assignmentId, nextMonday, reqOutroTitular));
      expect(e1.code).toBe('23514');
      expect(e1.message).toBe('piab_pedido_de_outro_titular');
      const svc2 = await mkService(addrA);
      const reqOutroServico = await seedSubstitutionRequest(pool, { serviceId: svc2.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const e2 = await pgErr(insertAbsence(b.assignmentId, nextMonday, reqOutroServico));
      expect(e2.code).toBe('23514');
      expect(e2.message).toBe('piab_pedido_de_outro_servico');
    });

    it('request_id alterado em UPDATE → piab_request_imutavel (23514); UPDATE que não o muda passa', async () => {
      const b = await base();
      const req1 = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const req2 = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const abs = (await insertAbsence(b.assignmentId, nextMonday, req1)).rows[0].id;
      const e = await pgErr(pool.query(`UPDATE patient_itinerary_absence SET request_id = $2 WHERE id = $1`, [abs, req2]));
      expect(e.code).toBe('23514');
      expect(e.message).toBe('piab_request_imutavel');
      const ok = await pool.query(`UPDATE patient_itinerary_absence SET updated_by = $2 WHERE id = $1`, [abs, PREFIX]);
      expect(ok.rowCount).toBe(1);
    });

    it('UPDATE do cabeçalho fora de undone_* → pisr_imutavel (55000); undone_* de NULL para valor passa; reescrever não', async () => {
      const b = await base();
      const req = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const outro = await mkWorker('outro');
      const e = await pgErr(pool.query(`UPDATE patient_itinerary_substitution_request SET outgoing_worker_id = $2 WHERE id = $1`, [req, outro]));
      expect(e.code).toBe('55000');
      expect(e.message).toMatch(/^pisr_imutavel/);
      const e2 = await pgErr(pool.query(`UPDATE patient_itinerary_substitution_request SET reason_code = $2 WHERE id = $1`, [req, reasonAlt]));
      expect(e2.code).toBe('55000');
      const ok = await pool.query(`UPDATE patient_itinerary_substitution_request SET undone_at = now(), undone_by = $2 WHERE id = $1`, [req, ACTOR]);
      expect(ok.rowCount).toBe(1);
      const e3 = await pgErr(pool.query(`UPDATE patient_itinerary_substitution_request SET undone_by = 'outro' WHERE id = $1`, [req]));
      expect(e3.code).toBe('55000');
      expect(e3.message).toMatch(/^pisr_desfeito_nao_reabre/);
    });

    it('undone_at com ausência futura ABERTA → 23514 pisr_desfazer_com_turno_aberto; depois de cancelar a ausência, passa', async () => {
      const b = await base();
      const req = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const abs = (await insertAbsence(b.assignmentId, nextMonday, req)).rows[0].id;
      const e = await pgErr(pool.query(`UPDATE patient_itinerary_substitution_request SET undone_at = now(), undone_by = $2 WHERE id = $1`, [req, ACTOR]));
      expect(e.code).toBe('23514');
      expect(e.message).toBe('pisr_desfazer_com_turno_aberto');
      // gate parcial da 484: cancelar a ausência de um pedido PASSA (request_id não muda)
      const canc = await pool.query(`UPDATE patient_itinerary_absence SET cancelled_at = now(), cancelled_by = $2, updated_by = $2 WHERE id = $1`, [abs, ACTOR]);
      expect(canc.rowCount).toBe(1);
      const ok = await pool.query(`UPDATE patient_itinerary_substitution_request SET undone_at = now(), undone_by = $2 WHERE id = $1`, [req, ACTOR]);
      expect(ok.rowCount).toBe(1);
    });

    it('DELETE do cabeçalho como app_runtime → 42501 (e SELECT/INSERT/UPDATE estão concedidos)', async () => {
      const p = await pool.query<Record<string, boolean>>(
        `SELECT has_table_privilege('app_runtime','patient_itinerary_substitution_request','DELETE') AS del,
                has_table_privilege('app_runtime','patient_itinerary_substitution_request','SELECT') AS sel,
                has_table_privilege('app_runtime','patient_itinerary_substitution_request','INSERT') AS ins,
                has_table_privilege('app_runtime','patient_itinerary_substitution_request','UPDATE') AS upd`,
      );
      expect(p.rows[0]).toEqual({ del: false, sel: true, ins: true, upd: true });
      const b = await base();
      const req = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const e = await pgErr(asAppRuntime(ACTOR, (c) => c.query(`DELETE FROM patient_itinerary_substitution_request WHERE id = $1`, [req])));
      expect(e.code).toBe('42501');
    });

    it('picl_request_by_kind: ENTRY_CANCELLED com request_id → 23514; REMOVE com request_id passa', async () => {
      const b = await base();
      const req = await seedSubstitutionRequest(pool, { serviceId: b.svc.serviceId, outgoingWorkerId: b.titular, createdBy: PREFIX });
      const e = await pgErr(insertLog({ serviceId: b.svc.serviceId, kind: 'ENTRY_CANCELLED', outgoing: b.titular, requestId: req }));
      expect(e.code).toBe('23514');
      expect(e.constraint).toBe('picl_request_by_kind');
      const ok = await insertLog({ serviceId: b.svc.serviceId, kind: 'REMOVE', outgoing: b.titular, requestId: req, destination: 'RESERVE' });
      expect(ok.rows[0].id).toBeTruthy();
    });

    it('despacho do alerta: 2× no mesmo (dia, destinatário) → 23505; FAILED sem email_error_code → 23514; uq_notifications_event_recipient → 23505', async () => {
      const recipient = `${PREFIX}dest1`;
      const ev = (
        await one<{ id: string }>(
          `INSERT INTO notification_events (type_code, actor_uid, payload) VALUES ('ITINERARY_UNCOVERED_SHIFTS', $1, '{}'::jsonb) RETURNING id`,
          [ACTOR],
        )
      ).id;
      await pool.query(`INSERT INTO notifications (event_id, recipient_uid) VALUES ($1, $2)`, [ev, recipient]);
      const dup = await pgErr(pool.query(`INSERT INTO notifications (event_id, recipient_uid) VALUES ($1, $2)`, [ev, recipient]));
      expect(dup.code).toBe('23505');
      expect(dup.constraint).toBe('uq_notifications_event_recipient');

      const ins = (status: string, errCode: string | null, uid = recipient) =>
        pool.query(
          `INSERT INTO itinerary_uncovered_alert_dispatch (operation_date, recipient_uid, event_id, email_status, email_error_code)
           VALUES ('2026-10-23', $1, $2, $3, $4)`,
          [uid, ev, status, errCode],
        );
      await ins('PENDING', null);
      const dispatchDup = await pgErr(ins('PENDING', null));
      expect(dispatchDup.code).toBe('23505');
      const failedSemCodigo = await pgErr(
        pool.query(
          `INSERT INTO itinerary_uncovered_alert_dispatch (operation_date, recipient_uid, event_id, email_status) VALUES ('2026-10-24', $1, $2, 'FAILED')`,
          [recipient, ev],
        ),
      );
      expect(failedSemCodigo.code).toBe('23514');
      expect(failedSemCodigo.constraint).toBe('iuad_error_pair');
      // controle positivo: FAILED com código passa; a FK composta recusa notificação inexistente (23503)
      await pool.query(
        `INSERT INTO itinerary_uncovered_alert_dispatch (operation_date, recipient_uid, event_id, email_status, email_error_code) VALUES ('2026-10-25', $1, $2, 'FAILED', 'E_TEST')`,
        [recipient, ev],
      );
      const semNotificacao = await pgErr(ins('PENDING', null, `${PREFIX}sem-notificacao`));
      expect(semNotificacao.code).toBe('23503');
    });

    it('app_runtime só LÊ as tabelas da rotina (itinerary_daily_run, dispatch); app_system escreve', async () => {
      const tabs = ['itinerary_daily_run', 'itinerary_uncovered_alert_dispatch'];
      const priv = async (role: string, p: string) =>
        (await pool.query<{ ok: boolean }>(
          `SELECT bool_and(has_table_privilege($1, t, $2)) AS ok FROM unnest($3::text[]) t`, [role, p, tabs])).rows[0].ok;
      expect(await priv('app_runtime', 'SELECT')).toBe(true);
      expect(await priv('app_runtime', 'INSERT')).toBe(false);
      expect(await priv('app_runtime', 'UPDATE')).toBe(false);
      expect(await priv('app_system', 'INSERT')).toBe(true);
    });
  });

  // ═══════════════════ T106 · pré-visão e as funções de conflito como app_runtime ═══════════════════
  describe('T106 · pré-visão do conflito do substituto', () => {
    /** X é titular de outra faixa (segunda 10:00-14:00, mesmo endereço) que sobrepõe a faixa-alvo (segunda 08:00-12:00). */
    async function conflictScenario() {
      const target = await base();
      const other = await mkService(addrA);
      const otherSlot = await mkSlot(other, SEGUNDA, '10:00', 240);
      const x = await mkWorker('x');
      await allocate(other, otherSlot, x);
      return { target, x };
    }

    it('devolve SÓ (weekday, start_time, duration_minutes, same_address), nenhuma coluna de id; com GUC de ator', async () => {
      const { target, x } = await conflictScenario();
      const r = await asAppRuntime(ACTOR, (c) =>
        c.query(`SELECT * FROM itinerary_substitute_conflict_preview($1, $2, $3::date, $3::date, NULL)`, [x, target.slotId, nextMonday]),
      );
      expect(r.fields.map((f) => f.name)).toEqual(['weekday', 'start_time', 'duration_minutes', 'same_address']);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ weekday: SEGUNDA, duration_minutes: 240, same_address: true });
      expect(r.rows[0].start_time).toBe('10:00:00');
    });

    it('sem GUC de ator → 0 linhas (controle positivo: o mesmo comando COM ator devolve 1)', async () => {
      const { target, x } = await conflictScenario();
      const call = (c: PoolClient) =>
        c.query(`SELECT * FROM itinerary_substitute_conflict_preview($1, $2, $3::date, $3::date, NULL)`, [x, target.slotId, nextMonday]);
      const sem = await asAppRuntime(null, call);
      expect(sem.rows).toHaveLength(0);
      const com = await asAppRuntime(ACTOR, call);
      expect(com.rows).toHaveLength(1);
    });

    it('itinerary_worker_conflict e itinerary_slot_worker_conflict chamadas direto como app_runtime → 42501', async () => {
      const { target, x } = await conflictScenario();
      const direto = await pgErr(
        asAppRuntime(ACTOR, (c) => c.query(`SELECT * FROM itinerary_slot_worker_conflict($1, $2, $3::date, $3::date, NULL)`, [x, target.slotId, nextMonday])),
      );
      expect(direto.code).toBe('42501');
      const bruta = await pgErr(
        asAppRuntime(ACTOR, (c) =>
          c.query(`SELECT * FROM itinerary_worker_conflict($1, int4multirange(int4range(0, 60)), NULL, $2::date, $2::date, NULL, NULL, NULL)`, [x, nextMonday]),
        ),
      );
      expect(bruta.code).toBe('42501');
    });
  });

  // ═══════════════════ T107 · paridade pré-visão × gatilho da ausência ═══════════════════════════════
  describe('T107 · paridade pré-visão × gatilho da ausência (mesmo veredito nas mesmas entradas)', () => {
    interface Case {
      nome: string;
      /** faixa-alvo (a do titular que falta) */
      alvo: { weekday: number; start: string; minutes: number; address: 'A' | 'B' };
      /** faixa onde o substituto X já é titular */
      outra: { weekday: number; start: string; minutes: number; address: 'A' | 'B' };
      conflito: boolean;
    }
    const casos: Case[] = [
      { nome: 'noturno 20:00 + 720 min cruza para terça 07:00 (mesmo endereço)', alvo: { weekday: SEGUNDA, start: '20:00', minutes: 720, address: 'A' }, outra: { weekday: TERCA, start: '07:00', minutes: 120, address: 'A' }, conflito: true },
      { nome: 'mesmo endereço, encostando (12:00 = fim do alvo): sem folga, não conflita', alvo: { weekday: SEGUNDA, start: '08:00', minutes: 240, address: 'A' }, outra: { weekday: SEGUNDA, start: '12:00', minutes: 120, address: 'A' }, conflito: false },
      { nome: 'endereço diferente com 1 h exata de folga: não conflita', alvo: { weekday: SEGUNDA, start: '08:00', minutes: 240, address: 'A' }, outra: { weekday: SEGUNDA, start: '13:00', minutes: 120, address: 'B' }, conflito: false },
      { nome: 'endereço diferente com 30 min de folga: conflita', alvo: { weekday: SEGUNDA, start: '08:00', minutes: 240, address: 'A' }, outra: { weekday: SEGUNDA, start: '12:30', minutes: 120, address: 'B' }, conflito: true },
    ];

    async function build(c: Case) {
      const target = await mkService(addrA);
      const slotId = await mkSlot(target, c.alvo.weekday, c.alvo.start, c.alvo.minutes);
      const titular = await mkWorker('tit');
      const assignmentId = await allocate(target, slotId, titular);
      const other = await mkService(c.outra.address === 'A' ? addrA : addrB);
      const otherSlot = await mkSlot(other, c.outra.weekday, c.outra.start, c.outra.minutes);
      const x = await mkWorker('x');
      await allocate(other, otherSlot, x);
      const wjaX = await mkWja(x, target.jobId);
      const req = await seedSubstitutionRequest(pool, { serviceId: target.serviceId, outgoingWorkerId: titular, createdBy: PREFIX });
      const date = await weekdayDate(c.alvo.weekday);
      return { target, slotId, assignmentId, x, wjaX, req, date };
    }

    it.each(casos)('$nome', async (c) => {
      const s = await build(c);
      const previa = await asAppRuntime(ACTOR, (cl) =>
        cl.query(`SELECT * FROM itinerary_substitute_conflict_preview($1, $2, $3::date, $3::date, NULL)`, [s.x, s.slotId, s.date]),
      );
      const gatilho = await pgErr(insertAbsence(s.assignmentId, s.date, s.req, { workerId: s.x, wjaId: s.wjaX })).then(
        (e) => e,
        () => null, // aceita → sem conflito
      );
      const previaConflita = previa.rows.length > 0;
      const gatilhoConflita = gatilho !== null && gatilho.code === '23P01';
      expect(previaConflita).toBe(c.conflito);
      expect(gatilhoConflita).toBe(c.conflito);
      if (gatilho !== null) expect(gatilho.code).toBe('23P01'); // nenhum outro erro disfarçado de veredito
    });

    it('p_ignore_absence = a própria ausência: sem ele a pré-visão acusa a ausência contra si mesma; com ele, livre — e o gatilho (UPDATE) também libera', async () => {
      const c: Case = { nome: '', alvo: { weekday: SEGUNDA, start: '08:00', minutes: 240, address: 'A' }, outra: { weekday: TERCA, start: '08:00', minutes: 60, address: 'A' }, conflito: false };
      const s = await build(c);
      const abs = (await insertAbsence(s.assignmentId, s.date, s.req, { workerId: s.x, wjaId: s.wjaX })).rows[0].id;
      const prev = (ignore: string | null) =>
        asAppRuntime(ACTOR, (cl) =>
          cl.query(`SELECT * FROM itinerary_substitute_conflict_preview($1, $2, $3::date, $3::date, $4)`, [s.x, s.slotId, s.date, ignore]),
        );
      expect((await prev(null)).rows).toHaveLength(1); // controle positivo: a própria ausência conta como compromisso do X
      expect((await prev(abs)).rows).toHaveLength(0);
      const upd = await pool.query(`UPDATE patient_itinerary_absence SET substitute_worker_id = $2 WHERE id = $1`, [abs, s.x]);
      expect(upd.rowCount).toBe(1); // gatilho dispara (UPDATE OF substitute_worker_id) e ignora a própria linha
    });

    it('o DETAIL do 23P01 do gatilho mantém as 10 chaves (itineraryOverlap.ts lê sem mudança)', async () => {
      const s = await build(casos[0]);
      const e = await pgErr(insertAbsence(s.assignmentId, s.date, s.req, { workerId: s.x, wjaId: s.wjaX }));
      expect(e.code).toBe('23P01');
      const d = JSON.parse(e.detail ?? '{}');
      expect(Object.keys(d).sort()).toEqual(
        [
          'existingEnd',
          'existingServiceId',
          'existingStart',
          'existingWeekday',
          'minGapMinutes',
          'requestedEnd',
          'requestedServiceId',
          'requestedStart',
          'requestedWeekday',
          'sameAddress',
        ].sort(),
      );
      expect(d.sameAddress).toBe(true);
    });
  });
});
