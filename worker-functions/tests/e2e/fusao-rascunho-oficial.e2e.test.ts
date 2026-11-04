/**
 * fusao-rascunho-oficial.e2e.test.ts @integration — fusão da vaga RASCUNHO (foguete) na vaga OFICIAL legada (03/11).
 *
 * `FuseDraftIntoOfficialVacancyUseCase` + `DraftFusionRepository` + o vínculo REAL (`LinkExistingVacancyUseCase`) EM
 * PROCESSO contra Postgres real (triggers, CHECK 525, UNIQUE de postulação/encuadre e índice de vaga viva por serviço
 * de verdade). Sem API: o use case é de manutenção (CLI), não tem rota.
 *
 * Side-effects outbound: nenhum. A fusão só faz SELECT/UPDATE/DELETE no Postgres e audita em job_posting_audit_log;
 * não emite evento de funil (nenhuma mensagem de etapa nasce) e não chama Talentum/WhatsApp/Ana Care/Short.io.
 * Dados 100% sintéticos, sem PII.
 */
import { Pool, type PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { FuseDraftIntoOfficialVacancyUseCase, type FusionPair } from '@modules/case/application/FuseDraftIntoOfficialVacancyUseCase';
import { LinkExistingVacancyUseCase } from '@modules/case/application/LinkExistingVacancyUseCase';
import { DraftFusionRepository } from '@modules/case/infrastructure/DraftFusionRepository';
import { LinkExistingVacancyRepository } from '@modules/case/infrastructure/LinkExistingVacancyRepository';
import { ACCEPT_ANY_SERVICE_VALUE } from '@modules/case/domain/LinkExistingVacancyPlan';
import { JobPostingAuditRepository } from '@modules/matching/infrastructure/JobPostingAuditRepository';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';
import { vincularServicoAoPagador } from './helpers/vinculoPagador';
import { semearFaixas } from './helpers/seedFaixaDoServico';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const JOB = 'fusao-rascunho-oficial';
const STAMP = `fusao-e2e-${Date.now()}`;

describe('Fusão rascunho → vaga oficial @integration', () => {
  let pool: Pool;
  let useCase: FuseDraftIntoOfficialVacancyUseCase;
  let seq = 0;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const linkRepo = new LinkExistingVacancyRepository();
    const auditRepo = new JobPostingAuditRepository();
    useCase = new FuseDraftIntoOfficialVacancyUseCase(
      new DraftFusionRepository(),
      linkRepo,
      auditRepo,
      (client: PoolClient) =>
        new LinkExistingVacancyUseCase(linkRepo, auditRepo, ACCEPT_ANY_SERVICE_VALUE, <T,>(fn: (c: PoolClient) => Promise<T>) => fn(client)),
      <T,>(fn: (c: PoolClient) => Promise<T>) => withActorContext(pool, fn, systemActor(JOB)),
      { actorUserId: null, actorType: 'CLI', actorLabel: JOB, traceId: null },
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
    (await pool.query(sql, params)).rows[0] as T;

  async function vaga(patientId: string, opts: { draft: boolean; serviceId: string | null; addressId: string }): Promise<string> {
    const { vn } = await one<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
    const r = await one<{ id: string }>(
      `INSERT INTO job_postings (vacancy_number, patient_id, title, description, country, status, is_draft, is_test,
                                 patient_address_id, contracted_service_id, case_ordinal)
       VALUES ($1, $2, $3, '', 'AR', $4, $5, true, $6, $7, $8) RETURNING id`,
      [parseInt(vn, 10), patientId, `${STAMP}-vaga-${++seq}`, opts.draft ? 'PENDING_ACTIVATION' : 'SEARCHING',
        opts.draft, opts.addressId, opts.serviceId, opts.draft ? 2 : 1],
    );
    return r.id;
  }

  async function worker(): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, country, timezone) VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [`${STAMP}-uid-${++seq}`, `${STAMP}-${seq}@fusao.test`],
    );
    return r.id;
  }

  /** source 'talentum'/'system': passa o guard de postulação sem precisar de worker REGISTERED (migration 229). */
  async function postular(workerId: string, vacancyId: string, stage: string, source: string): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [workerId, vacancyId, stage, source],
    );
    return r.id;
  }

  /** Paciente pronto para o portão do vínculo; oficial legada (sem serviço) + rascunho do foguete (com serviço). */
  async function endereco(patientId: string, texto: string): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, country, address_formatted, address_type)
       VALUES ($1, 'AR', $2, 'domicilio_propio') RETURNING id`,
      [patientId, texto],
    );
    return r.id;
  }

  async function cenario(opts: { enderecoDaOficial?: 'mesmo' | 'outro'; semDiaDePagamento?: boolean; semFaixa?: boolean } = {}): Promise<FusionPair & { addressId: string; officialAddressId: string }> {
    const { id: patientId } = await one<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Fusao', 'E2E', 'AR', 'PENDING_ADMISSION') RETURNING id`,
      [`${STAMP}-p-${++seq}`],
    );
    await seedPatientDiagnosis(pool, patientId);
    const addressId = await endereco(patientId, 'Calle Sintetica 1');
    const officialAddressId = opts.enderecoDaOficial === 'outro' ? await endereco(patientId, 'Calle Sintetica 2') : addressId;
    const { id: serviceId } = await one<{ id: string }>(
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, country, created_by, updated_by, address_id, providers_needed,
          required_professions, required_sex, required_experience, work_schedule, payment_day)
       VALUES ($1, 'AT', 'AR', $2, $2, $3, 1, ARRAY['AT'], 'F', 'EXP-E2E', 'part-time', $4) RETURNING id`,
      [patientId, STAMP, addressId, opts.semDiaDePagamento ? null : 'DIA-E2E'],
    );
    await vincularServicoAoPagador(pool, serviceId); // COVERAGE (spec 087): o portão da fusão lê o vínculo vigente do serviço
    if (!opts.semFaixa) {
      await semearFaixas(pool, serviceId, [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], STAMP);
    }
    const officialId = await vaga(patientId, { draft: false, serviceId: null, addressId: officialAddressId });
    const draftId = await vaga(patientId, { draft: true, serviceId, addressId });
    return { patientId, draftId, officialId, serviceId, addressId, officialAddressId };
  }

  const fusionPair = (c: FusionPair): FusionPair => ({
    patientId: c.patientId, draftId: c.draftId, officialId: c.officialId, serviceId: c.serviceId,
  });

  const countOn = async (table: string, vacancyId: string): Promise<number> =>
    (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE job_posting_id = $1`, [vacancyId])).n;

  it('dry-run executa e dá ROLLBACK: nada muda no banco', async () => {
    const pair = await cenario();
    const w = await worker();
    await postular(w, pair.draftId, 'QUALIFIED', 'talentum');

    const out = await useCase.fuse(fusionPair(pair), { apply: false, waiveGateWhenBothEmpty: true });

    expect(out).toMatchObject({ status: 'FUSED', committed: false });
    expect(await one(`SELECT deleted_at, contracted_service_id FROM job_postings WHERE id = $1`, [pair.draftId]))
      .toEqual({ deleted_at: null, contracted_service_id: pair.serviceId });
    expect(await one(`SELECT contracted_service_id FROM job_postings WHERE id = $1`, [pair.officialId]))
      .toEqual({ contracted_service_id: null });
    expect(await countOn('worker_job_applications', pair.draftId)).toBe(1);
  });

  it('apply: rascunho apagado, oficial vinculada, Kanban fundido com a etapa do rascunho, filhos movidos, auditado', async () => {
    const pair = await cenario();
    const [wAmbas, wSoRascunho] = [await worker(), await worker()];
    const oficialWja = await postular(wAmbas, pair.officialId, 'INVITED', 'system');
    await postular(wAmbas, pair.draftId, 'QUALIFIED', 'talentum');
    await postular(wSoRascunho, pair.draftId, 'IN_PROGRESS', 'talentum');
    await pool.query(
      `INSERT INTO talentum_prescreenings (talentum_prescreening_id, talentum_profile_id, worker_id, job_posting_id, job_case_name, status, environment)
       VALUES ($1, $2, $3, $4, 'caso', 'QUALIFIED', 'test')`,
      [`${STAMP}-ps`, `${STAMP}-prof`, wSoRascunho, pair.draftId],
    );
    await pool.query(
      `INSERT INTO funnel_stage_message_log (worker_id, job_posting_id, stage, source, status, skip_reason, country)
       VALUES ($1, $2, 'QUALIFIED', 'talentum', 'skipped', 'SOURCE_NOT_HUMAN', 'AR')`,
      [wAmbas, pair.draftId],
    );
    expect(await countOn('encuadres', pair.draftId)).toBe(2); // trigger da migration 189 nasce 1 por postulação

    const out = await useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true });

    expect(out).toMatchObject({
      status: 'FUSED',
      committed: true,
      result: { merged: { worker_job_applications: 1, encuadres: 1 }, collisionStages: { QUALIFIED: 1 } },
    });
    // rascunho: apagado pela semântica do DELETE (CLOSED + deleted_at), sem nada pendurado
    expect(await one(`SELECT status, deleted_at IS NOT NULL AS apagado FROM job_postings WHERE id = $1`, [pair.draftId]))
      .toEqual({ status: 'CLOSED', apagado: true });
    for (const t of ['worker_job_applications', 'encuadres', 'talentum_prescreenings', 'funnel_stage_message_log']) {
      expect(await countOn(t, pair.draftId)).toBe(0);
    }
    // oficial: vinculada ao serviço, mantém número e ordinal, os 9 campos do serviço zerados (CHECK 525)
    expect(await one(`SELECT contracted_service_id, case_ordinal, is_draft, schedule, providers_needed FROM job_postings WHERE id = $1`, [pair.officialId]))
      .toEqual({ contracted_service_id: pair.serviceId, case_ordinal: 1, is_draft: false, schedule: null, providers_needed: null });
    // Kanban: uma linha por worker; quem estava nas duas ADOTOU a etapa do rascunho na linha da oficial
    const wjas = (await pool.query(
      `SELECT id, worker_id, application_funnel_stage AS stage FROM worker_job_applications WHERE job_posting_id = $1 ORDER BY stage`,
      [pair.officialId],
    )).rows;
    expect(wjas).toEqual([
      { id: expect.any(String), worker_id: wSoRascunho, stage: 'IN_PROGRESS' },
      { id: oficialWja, worker_id: wAmbas, stage: 'QUALIFIED' },
    ]);
    // trilha: a mudança INVITED→QUALIFIED nasce na linha da oficial, com o ator da fusão
    expect(await one(
      `SELECT old_value, new_value, changed_by FROM worker_job_application_stage_history
        WHERE application_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [oficialWja],
    )).toEqual({ old_value: 'INVITED', new_value: 'QUALIFIED', changed_by: `system:${JOB}` });
    expect(await countOn('encuadres', pair.officialId)).toBe(2);
    expect(await countOn('talentum_prescreenings', pair.officialId)).toBe(1);
    expect(await countOn('funnel_stage_message_log', pair.officialId)).toBe(1);
    // auditoria: DELETED no rascunho e "fusão com rascunho <id>" na oficial
    expect(await one(`SELECT count(*)::int AS n FROM job_posting_audit_log WHERE job_posting_id = $1 AND event_type = 'DELETED'`, [pair.draftId]))
      .toEqual({ n: 1 });
    expect(await one(
      `SELECT changes->>'before' AS antes, changes->>'after' AS depois FROM job_posting_audit_log
        WHERE job_posting_id = $1 AND field_name = 'fusao_rascunho'`,
      [pair.officialId],
    )).toEqual({ antes: pair.draftId, depois: pair.officialId });

    // rodar de novo: o par saiu do estado do mapa → pula, nada muda
    // (o serviço agora tem a OFICIAL como vaga viva)
    await expect(useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true })).resolves.toEqual({ status: 'SKIPPED', reason: 'SERVICE_HAS_OTHER_VACANCY' });
  });

  it('conflito (as duas etapas decididas e diferentes): o paciente inteiro fica como está', async () => {
    const pair = await cenario();
    const w = await worker();
    await postular(w, pair.officialId, 'SELECTED', 'system');
    await postular(w, pair.draftId, 'REJECTED', 'talentum');

    await expect(useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true })).resolves.toEqual({
      status: 'CONFLICT', conflicts: [{ workerId: w, officialStage: 'SELECTED', draftStage: 'REJECTED' }],
    });
    expect(await one(`SELECT deleted_at FROM job_postings WHERE id = $1`, [pair.draftId])).toEqual({ deleted_at: null });
    expect(await countOn('worker_job_applications', pair.draftId)).toBe(1);
  });

  it('endereço divergente: vale o do serviço — a oficial passa a apontar para o endereço do serviço', async () => {
    const pair = await cenario({ enderecoDaOficial: 'outro' });
    const out = await useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true });
    expect(out).toMatchObject({ status: 'FUSED', result: { addressAligned: true } });
    expect(await one(`SELECT patient_address_id FROM job_postings WHERE id = $1`, [pair.officialId]))
      .toEqual({ patient_address_id: pair.addressId });
    expect(await one(
      `SELECT changes->>'before' AS antes, changes->>'after' AS depois FROM job_posting_audit_log
        WHERE job_posting_id = $1 AND field_name = 'patient_address_id'`,
      [pair.officialId],
    )).toEqual({ antes: pair.officialAddressId, depois: pair.addressId });
  });

  it('serviço sem endereço vivo: nada a alinhar; o vínculo copia o endereço da oficial para o serviço', async () => {
    const pair = await cenario({ enderecoDaOficial: 'outro' });
    await pool.query(`UPDATE patient_addresses SET archived_at = NOW() WHERE id = $1`, [pair.addressId]);
    const out = await useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true });
    expect(out).toMatchObject({ status: 'FUSED', result: { addressAligned: false } });
    expect(await one(`SELECT address_id FROM patient_contracted_services WHERE id = $1`, [pair.serviceId]))
      .toEqual({ address_id: pair.officialAddressId });
  });

  it('referência ao rascunho que a fusão não move (nota da vaga) → pula o paciente, nada muda', async () => {
    const pair = await cenario();
    await pool.query(
      `INSERT INTO job_posting_notes (job_posting_id, occurred_at, category, contact, body, created_by)
       VALUES ($1, NOW(), 'OUTRO', 'e2e', 'nota sintetica', $2)`,
      [pair.draftId, STAMP],
    );
    await expect(useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true })).resolves.toEqual({
      status: 'SKIPPED', reason: 'UNHANDLED_REFS:job_posting_notes.job_posting_id',
    });
    expect(await one(`SELECT deleted_at FROM job_postings WHERE id = $1`, [pair.draftId])).toEqual({ deleted_at: null });
  });

  it('dia de pagamento vazio no serviço E na vaga: funde sem o portão desse campo e audita a dispensa', async () => {
    const pair = await cenario({ semDiaDePagamento: true });
    const out = await useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true });
    expect(out).toMatchObject({ status: 'FUSED', committed: true, result: { gateWaived: ['SERVICE_PAYMENT_DAY'] } });
    expect(await one(`SELECT contracted_service_id FROM job_postings WHERE id = $1`, [pair.officialId]))
      .toEqual({ contracted_service_id: pair.serviceId });
    expect(await one(
      `SELECT changes->'after' AS depois FROM job_posting_audit_log
        WHERE job_posting_id = $1 AND field_name = 'fusao_sem_portao_campos_vazios'`,
      [pair.officialId],
    )).toEqual({ depois: ['SERVICE_PAYMENT_DAY'] });
  });

  it('sem a dispensa explícita, o mesmo caso continua bloqueado pelo portão do vínculo', async () => {
    const pair = await cenario({ semDiaDePagamento: true });
    await expect(useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: false }))
      .resolves.toEqual({ status: 'SKIPPED', reason: 'LINK_BLOCKED:SERVICE_PAYMENT_DAY' });
    expect(await one(`SELECT deleted_at FROM job_postings WHERE id = $1`, [pair.draftId])).toEqual({ deleted_at: null });
  });

  it('campo vazio nos dois lados + outro bloqueio (sem horário) → continua pulando, nada muda', async () => {
    const pair = await cenario({ semDiaDePagamento: true, semFaixa: true });
    await expect(useCase.fuse(fusionPair(pair), { apply: true, waiveGateWhenBothEmpty: true }))
      .resolves.toEqual({ status: 'SKIPPED', reason: 'LINK_BLOCKED:SERVICE_SCHEDULE' });
    expect(await one(`SELECT deleted_at FROM job_postings WHERE id = $1`, [pair.draftId])).toEqual({ deleted_at: null });
    expect(await one(`SELECT contracted_service_id FROM job_postings WHERE id = $1`, [pair.officialId]))
      .toEqual({ contracted_service_id: null });
  });
});
