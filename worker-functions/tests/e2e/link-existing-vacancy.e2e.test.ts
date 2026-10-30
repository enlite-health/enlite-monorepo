/**
 * link-existing-vacancy.e2e.test.ts @integration — spec 079, T025 (spec §8.4, plan §3.2/§3.4/§3.5).
 *
 * Vínculo de uma vaga LEGADA (já existente, com os 9 campos do serviço gravados nela) a um serviço contratado:
 *   - `POST /patients/:id/contracted-services/:sid/link-existing-vacancy/preview` (candidatas + prévia, NÃO grava);
 *   - `POST /patients/:id/contracted-services/:sid/link-existing-vacancy` (confirmação).
 *
 * API real + Postgres real, com o engine ABAC LIGADO na API (`PERMISSION_ENGINE_ENABLED=true` +
 * `admin.patients` + catálogo sincronizado): staff entra por GRUPO, e o 403 vem da célula que falta, não do papel.
 * Stack: docker-compose.yml + docker-compose.test.yml + um override com PERMISSION_ENGINE_ENABLED=true,
 * PERMISSION_ENFORCED_ROUTES (famílias admin.*), PERMISSION_CATALOG_SYNC_ENABLED=true, PERMISSION_CACHE_TTL_MS=0 e
 * `iam.rollout_state permission_groups_migrated=done` (gate D117). Sem o engine o caso 1 (403) falha por construção.
 *
 * Side-effects outbound: nenhum. `LinkExistingVacancyUseCase`/`Repository` só fazem SELECT/UPDATE no Postgres e
 * `logFieldChangesSafe` (job_posting_audit_log); sem Talentum/Periskope/Twilio/Ana Care no caminho (grep = 0). A
 * stack de teste ainda bloqueia terceiros por `extra_hosts` (docker-compose.test.yml). Dados 100% sintéticos, sem PII.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E } from './helpers/permissionFamilyHarness';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';
import { semearFaixas } from './helpers/seedFaixaDoServico';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'link079-e2e-%';
const U = { completo: 'link079-completo', soServicos: 'link079-so-servicos', soVaga: 'link079-so-vaga' };
const GRUPOS = { completo: 'Link079 Completo', soServicos: 'Link079 So Servicos', soVaga: 'Link079 So Vaga' };

// Requisitos sintéticos GRAVADOS NA VAGA LEGADA (o serviço nasce sem eles). Valores dentro do domínio de escrita do serviço.
const VAGA = {
  required_professions: ['AT'],
  required_sex: 'F',
  required_experience: 'EXP-E2E-079',
  work_schedule: 'part-time',
  payment_day: 'DIA-E2E-079',
  providers_needed: '2',
  age_range_min: 30,
  age_range_max: 44, // casa EXATAMENTE a faixa AGE_30_45
  schedule: '[{"dayOfWeek":1,"startTime":"08:00","durationMinutes":240}]',
  salary_text: 'SALARIO-E2E-079',
  worker_profile_sought: 'PERFIL-E2E-079',
};
const NOVE_COLUNAS = [
  'schedule', 'providers_needed', 'age_range_min', 'age_range_max', 'required_sex',
  'required_professions', 'required_experience', 'work_schedule', 'payment_day',
] as const;

describe('Vínculo de vaga existente ao serviço (spec 079, T025) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let seq = 0;
  const as = (uid: string) => ({ headers: { Authorization: tokenMock(uid, 'admin', 'AR') } });

  interface Cenario {
    patientId: string;
    serviceId: string;
    addressId: string;
    vagaId: string;
  }

  const base = (c: Pick<Cenario, 'patientId' | 'serviceId'>) =>
    `/api/admin/patients/${c.patientId}/contracted-services/${c.serviceId}/link-existing-vacancy`;
  const preview = (c: Cenario, uid: string, vacancyId?: string) =>
    api.post(`${base(c)}/preview`, vacancyId ? { vacancyId } : {}, as(uid));
  const confirmar = (c: Cenario, uid: string, vacancyId: string) =>
    api.post(base(c), { vacancyId }, as(uid));

  async function semearVaga(patientId: string, addressId: string | null, opts: {
    status?: string; legada?: boolean; deleted?: boolean; contractedServiceId?: string | null;
  } = {}): Promise<string> {
    const { status = 'SEARCHING', legada = true, deleted = false, contractedServiceId = null } = opts;
    const vn = (await pool.query<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn")).rows[0].vn;
    const v = legada && !contractedServiceId ? VAGA : null; // o CHECK da 525: vinculada não guarda os 9
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings
         (vacancy_number, patient_id, title, description, country, status, is_draft, is_test,
          patient_address_id, contracted_service_id, deleted_at,
          required_professions, required_sex, required_experience, work_schedule, payment_day,
          providers_needed, age_range_min, age_range_max, schedule, salary_text, worker_profile_sought)
       VALUES ($1, $2, $3, '', 'AR', $4, false, true, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18) RETURNING id`,
      [
        parseInt(vn, 10), patientId, `link079-vaga-${++seq}`, status, addressId, contractedServiceId,
        deleted ? new Date() : null,
        v?.required_professions ?? null, v?.required_sex ?? null, v?.required_experience ?? null,
        v?.work_schedule ?? null, v?.payment_day ?? null, v?.providers_needed ?? null,
        v?.age_range_min ?? null, v?.age_range_max ?? null, v?.schedule ?? null,
        VAGA.salary_text, VAGA.worker_profile_sought,
      ],
    );
    return rows[0].id;
  }

  async function criarPaciente(nome: string): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, insurance_informed)
       VALUES ($1, 'Link079', 'E2E', 'AR', 'PENDING_ADMISSION', 'Particular') RETURNING id`,
      [`link079-e2e-${nome}-${++seq}`],
    )).rows[0].id;
    await seedPatientDiagnosis(pool, id);
    return id;
  }

  async function criarEndereco(patientId: string, texto: string): Promise<string> {
    const r = await api.post(`/api/admin/patients/${patientId}/addresses`,
      { address_formatted: texto, address_type: 'primary' }, as(U.completo));
    expect(r.status).toBe(201);
    return r.data.data.id as string;
  }

  /** Serviço SEM nenhum requisito de recrutamento (a vaga legada é quem os tem); com ou sem faixa vigente. */
  async function criarServico(patientId: string, addressId: string, opts: { comFaixa: boolean; code?: string } = { comFaixa: true }): Promise<string> {
    const r = await api.post(`/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: opts.code ?? 'AT', addressId }, as(U.completo));
    expect(r.status).toBe(201);
    const serviceId = r.data.data.id as string;
    if (opts.comFaixa) {
      await semearFaixas(pool, serviceId, [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], 'link079-e2e');
    }
    return serviceId;
  }

  async function cenario(nome: string, opts: { comFaixa?: boolean; enderecoDaVaga?: 'igual' | 'outro' } = {}): Promise<Cenario> {
    const patientId = await criarPaciente(nome);
    const addressId = await criarEndereco(patientId, 'Av. Siempre Viva 742');
    const serviceId = await criarServico(patientId, addressId, { comFaixa: opts.comFaixa ?? true });
    const addrVaga = opts.enderecoDaVaga === 'outro' ? await criarEndereco(patientId, 'Calle Falsa 123') : addressId;
    const vagaId = await semearVaga(patientId, addrVaga);
    return { patientId, serviceId, addressId, vagaId };
  }

  async function fotoVaga(vagaId: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `SELECT ${NOVE_COLUNAS.join(', ')}, salary_text, worker_profile_sought, patient_address_id, contracted_service_id,
              updated_at::text AS updated_at
         FROM job_postings WHERE id = $1`, [vagaId]);
    return rows[0];
  }
  async function fotoServico(serviceId: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `SELECT required_professions, required_experience, work_schedule, payment_day, required_sex,
              providers_needed, provider_age_band, address_id, updated_at::text AS updated_at, updated_by
         FROM patient_contracted_services WHERE id = $1`, [serviceId]);
    return rows[0];
  }
  const nAudit = async (vagaId: string) => Number((await pool.query(
    'SELECT COUNT(*) AS n FROM job_posting_audit_log WHERE job_posting_id = $1', [vagaId])).rows[0].n);
  const nCandidaturas = async (vagaId: string) => Number((await pool.query(
    'SELECT COUNT(*) AS n FROM worker_job_applications WHERE job_posting_id = $1', [vagaId])).rows[0].n);
  const statusPaciente = async (id: string) =>
    (await pool.query<{ status: string }>('SELECT status FROM patients WHERE id = $1', [id])).rows[0].status;

  async function limpar(): Promise<void> {
    const ids = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id IN (${ids}))`, [TAG]);
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (${ids})`, [TAG]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'link079-completo@e2e.local', 'Link079 completo', 'admin', 'ACTIVE', true, $4),
         ($2, 'link079-so-servicos@e2e.local', 'Link079 so servicos', 'admin', 'ACTIVE', true, $4),
         ($3, 'link079-so-vaga@e2e.local', 'Link079 so vaga', 'admin', 'ACTIVE', true, $4)`,
      [U.completo, U.soServicos, U.soVaga, TENANT_E2E],
    );
    for (const [resource, action] of [['patient_services', 'update'], ['vacancy', 'update'], ['patient_services', 'create'], ['patient', 'update'], ['patient_address', 'create']]) {
      await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    }
    // O "completo" também cria endereço e serviço (seed pela API) — as duas células do vínculo são patient_services:update + vacancy:update.
    await grupoComCelulas(pool, {
      nome: GRUPOS.completo, uid: U.completo,
      celulas: [['patient_services', 'update'], ['vacancy', 'update'], ['patient_services', 'create'], ['patient_address', 'create'], ['patient', 'read']],
    });
    await grupoComCelulas(pool, { nome: GRUPOS.soServicos, uid: U.soServicos, celulas: [['patient_services', 'update']] });
    await grupoComCelulas(pool, { nome: GRUPOS.soVaga, uid: U.soVaga, celulas: [['vacancy', 'update']] });
  }, 60000);

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  // ── 1. permissão ────────────────────────────────────────────────────────────────────────────────────────────
  it('1. sem vacancy:update (só patient_services:update) → 403 nas 2 rotas; sem patient_services:update → 403 nas 2; nada gravado', async () => {
    const c = await cenario('perm');
    const vagaAntes = await fotoVaga(c.vagaId);
    const servicoAntes = await fotoServico(c.serviceId);
    const auditAntes = await nAudit(c.vagaId);

    for (const uid of [U.soServicos, U.soVaga]) {
      const p = await preview(c, uid, c.vagaId);
      const k = await confirmar(c, uid, c.vagaId);
      expect([uid, p.status]).toEqual([uid, 403]);
      expect([uid, k.status]).toEqual([uid, 403]);
    }
    // contraprova: quem tem as DUAS células entra (a negação acima vem da célula, não de token/país quebrado)
    expect((await preview(c, U.completo)).status).toBe(200);

    expect(await fotoVaga(c.vagaId)).toEqual(vagaAntes);
    expect(await fotoServico(c.serviceId)).toEqual(servicoAntes);
    expect(await nAudit(c.vagaId)).toBe(auditAntes);
  });

  // ── 2. candidatas ───────────────────────────────────────────────────────────────────────────────────────────
  it('2. prévia sem vacancyId → candidatas = só a vaga legada elegível (fora: outro paciente, já vinculada, apagada, DE_BAJA)', async () => {
    const c = await cenario('cand');
    const outroPaciente = await criarPaciente('cand-outro');
    const vagaOutroPaciente = await semearVaga(outroPaciente, null);
    const servico2 = await criarServico(c.patientId, c.addressId, { comFaixa: false, code: 'CAREGIVER' });
    const vagaJaVinculada = await semearVaga(c.patientId, c.addressId, { contractedServiceId: servico2 });
    const vagaApagada = await semearVaga(c.patientId, c.addressId, { deleted: true });
    const vagaDeBaja = await semearVaga(c.patientId, c.addressId, { status: 'DE_BAJA' });

    const r = await preview(c, U.completo);
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    const ids = (r.data.data.candidates as Array<{ id: string }>).map((v) => v.id);
    expect(ids).toContain(c.vagaId);
    for (const fora of [vagaOutroPaciente, vagaJaVinculada, vagaApagada, vagaDeBaja]) {
      expect(ids).not.toContain(fora);
    }
    expect(ids).toEqual([c.vagaId]);
    expect(r.data.data.preview).toBeNull();
  });

  // ── 3. prévia não grava ─────────────────────────────────────────────────────────────────────────────────────
  it('3. prévia com vacancyId → 200 coerente e NADA GRAVADO (vaga, serviço e audit idênticos por SQL)', async () => {
    const c = await cenario('prev');
    const vagaAntes = await fotoVaga(c.vagaId);
    const servicoAntes = await fotoServico(c.serviceId);
    const auditAntes = await nAudit(c.vagaId);

    const r = await preview(c, U.completo, c.vagaId);
    expect(r.status).toBe(200);
    const p = r.data.data.preview;
    expect(p.vacancyId).toBe(c.vagaId);
    expect(p.blockers).toEqual([]);
    expect(p.canConfirm).toBe(true);
    const campos = (p.rows as Array<{ field: string; origin: string }>);
    expect(campos.length).toBeGreaterThan(0);
    // serviço vazio → alimentado pela vaga (VACANCY); o horário NUNCA alimenta: vale a faixa do serviço (SERVICE)
    for (const row of campos) expect([row.field, row.origin]).toEqual([row.field, row.field === 'schedule' ? 'SERVICE' : 'VACANCY']);
    expect(campos.map((x) => x.field)).toEqual(expect.arrayContaining(['required_professions', 'work_schedule', 'providers_needed']));
    expect(p.warnings).toEqual([]);

    expect(await fotoVaga(c.vagaId)).toEqual(vagaAntes);
    expect(await fotoServico(c.serviceId)).toEqual(servicoAntes);
    expect(await nAudit(c.vagaId)).toBe(auditAntes);
    expect(vagaAntes.contracted_service_id).toBeNull();
  });

  // ── 4. confirmação feliz ────────────────────────────────────────────────────────────────────────────────────
  it('4. confirmação → vaga vinculada com as 9 colunas NULL, serviço alimentado, mesmo id, candidaturas intactas, audit e paciente', async () => {
    const c = await cenario('feliz');
    // uma candidatura na vaga: o vínculo não pode perdê-la (Kanban intacto)
    const worker = (await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [`link079-w-${Date.now()}`, `link079-w-${Date.now()}@e2e.local`])).rows[0].id;
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, match_score)
       VALUES ($1, $2, 'INVITED', 'talentum', 50)`, [worker, c.vagaId]);
    const vagaAntes = await fotoVaga(c.vagaId);
    const servicoAntes = await fotoServico(c.serviceId);
    const candidaturasAntes = await nCandidaturas(c.vagaId);
    const statusAntes = await statusPaciente(c.patientId);
    expect(candidaturasAntes).toBe(1);
    expect(servicoAntes.required_professions == null || (servicoAntes.required_professions as string[]).length === 0).toBe(true);

    const r = await confirmar(c, U.completo, c.vagaId);
    expect([r.status, r.data]).toEqual([200, expect.objectContaining({ success: true })]);
    expect(r.data.data.vacancyId).toBe(c.vagaId);
    expect(r.data.data.serviceId).toBe(c.serviceId);
    expect(r.data.data.fedFields).toEqual(expect.arrayContaining(['required_professions', 'work_schedule', 'providers_needed', 'age_range']));

    const vaga = await fotoVaga(c.vagaId);
    expect(vaga.contracted_service_id).toBe(c.serviceId);
    for (const col of NOVE_COLUNAS) expect([col, vaga[col]]).toEqual([col, null]);
    expect(vaga.salary_text).toBe(vagaAntes.salary_text);
    expect(vaga.worker_profile_sought).toBe(vagaAntes.worker_profile_sought);
    expect(vaga.patient_address_id).toBe(vagaAntes.patient_address_id);

    const svc = await fotoServico(c.serviceId);
    expect(svc).toMatchObject({
      required_professions: ['AT'], required_sex: 'F', required_experience: 'EXP-E2E-079',
      work_schedule: 'part-time', payment_day: 'DIA-E2E-079', providers_needed: 2, provider_age_band: 'AGE_30_45',
    });
    expect(svc.updated_by).toBe(U.completo);
    expect(svc.updated_at).not.toBe(servicoAntes.updated_at); // carimbo de autoria/tempo renovado pelo feed

    // Kanban intacto: mesma vaga (id), mesma candidatura
    expect((await pool.query('SELECT id FROM job_postings WHERE id = $1', [c.vagaId])).rowCount).toBe(1);
    expect(await nCandidaturas(c.vagaId)).toBe(candidaturasAntes);
    expect(await statusPaciente(c.patientId)).toBe(statusAntes);

    // audit (plan §3.5): contracted_service_id null→sid, colunas esvaziadas (valor→null), contracted_service.<col>
    const { rows: audit } = await pool.query<{ field_name: string; event_type: string; actor_user_id: string; changes: { before: unknown; after: unknown } }>(
      `SELECT field_name, event_type, actor_user_id, changes FROM job_posting_audit_log WHERE job_posting_id = $1`, [c.vagaId]);
    const porCampo = new Map(audit.map((a) => [a.field_name, a]));
    expect(porCampo.get('contracted_service_id')?.changes).toEqual({ before: null, after: c.serviceId });
    for (const col of ['required_professions', 'required_sex', 'required_experience', 'work_schedule', 'payment_day', 'providers_needed', 'age_range_min', 'age_range_max', 'schedule']) {
      const linha = porCampo.get(col);
      expect([col, linha?.changes?.after]).toEqual([col, null]);
      expect([col, linha?.changes?.before]).not.toEqual([col, null]);
    }
    expect(porCampo.get('contracted_service.required_professions')?.changes).toEqual({ before: null, after: ['AT'] });
    expect(porCampo.get('contracted_service.provider_age_band')?.changes).toEqual({ before: null, after: 'AGE_30_45' });
    expect(porCampo.get('contracted_service.providers_needed')?.changes).toEqual({ before: null, after: 2 });
    for (const a of audit) {
      expect(a.event_type).toBe('UPDATED');
      expect(a.actor_user_id).toBe(U.completo);
    }
    // salary_text e worker_profile_sought nunca aparecem na trilha
    expect(porCampo.has('salary_text')).toBe(false);
    expect(porCampo.has('worker_profile_sought')).toBe(false);
  });

  // ── 5. segunda confirmação ──────────────────────────────────────────────────────────────────────────────────
  it('5. segunda confirmação da mesma vaga → 409 SERVICE_ALREADY_RECRUITING (o serviço agora tem vaga viva); estado não muda', async () => {
    const c = await cenario('dupla');
    expect((await confirmar(c, U.completo, c.vagaId)).status).toBe(200);
    const vagaDepois = await fotoVaga(c.vagaId);
    const servicoDepois = await fotoServico(c.serviceId);
    const auditDepois = await nAudit(c.vagaId);

    const r = await confirmar(c, U.completo, c.vagaId);
    expect(r.status).toBe(409);
    expect(r.data.code ?? r.data.error?.code ?? r.data.error).toBe('SERVICE_ALREADY_RECRUITING');
    const p = await preview(c, U.completo);
    expect(p.status).toBe(409);

    expect(await fotoVaga(c.vagaId)).toEqual(vagaDepois);
    expect(await fotoServico(c.serviceId)).toEqual(servicoDepois);
    expect(await nAudit(c.vagaId)).toBe(auditDepois);
  });

  // ── 6. endereço diferente ───────────────────────────────────────────────────────────────────────────────────
  it('6. endereço da vaga ≠ endereço do serviço → 422 LINK_BLOCKED [ADDRESS_MISMATCH] e nada gravado', async () => {
    const c = await cenario('end', { enderecoDaVaga: 'outro' });
    const vagaAntes = await fotoVaga(c.vagaId);
    const servicoAntes = await fotoServico(c.serviceId);
    const auditAntes = await nAudit(c.vagaId);

    const p = await preview(c, U.completo, c.vagaId);
    expect(p.status).toBe(200);
    expect(p.data.data.preview.blockers).toContain('ADDRESS_MISMATCH');
    expect(p.data.data.preview.canConfirm).toBe(false);

    const r = await confirmar(c, U.completo, c.vagaId);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.data)).toContain('LINK_BLOCKED');
    expect(r.data.blockers ?? r.data.data?.blockers ?? r.data.error?.blockers).toContain('ADDRESS_MISMATCH');

    expect(await fotoVaga(c.vagaId)).toEqual(vagaAntes);
    expect(await fotoServico(c.serviceId)).toEqual(servicoAntes);
    expect(await nAudit(c.vagaId)).toBe(auditAntes);
  });

  // ── 7. portão ───────────────────────────────────────────────────────────────────────────────────────────────
  it('7. serviço sem faixa vigente → prévia com blocker SERVICE_SCHEDULE e confirmação 422 LINK_BLOCKED sem gravar', async () => {
    const c = await cenario('portao', { comFaixa: false });
    const vagaAntes = await fotoVaga(c.vagaId);
    const servicoAntes = await fotoServico(c.serviceId);
    const auditAntes = await nAudit(c.vagaId);

    const p = await preview(c, U.completo, c.vagaId);
    expect(p.status).toBe(200);
    expect(p.data.data.preview.blockers).toContain('SERVICE_SCHEDULE');
    expect(p.data.data.preview.canConfirm).toBe(false);

    const r = await confirmar(c, U.completo, c.vagaId);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.data)).toContain('LINK_BLOCKED');
    expect(JSON.stringify(r.data)).toContain('SERVICE_SCHEDULE');

    expect(await fotoVaga(c.vagaId)).toEqual(vagaAntes);
    expect(await fotoServico(c.serviceId)).toEqual(servicoAntes);
    expect(await nAudit(c.vagaId)).toBe(auditAntes);
  });

  // ── 8. endereço ARQUIVADO (real, não dublê) ─────────────────────────────────────────────────────────────────
  it('8. serviço sem endereço vivo + vaga com endereço ARQUIVADO → blocker SERVICE_ADDRESS, 422 LINK_BLOCKED e nada gravado', async () => {
    const patientId = await criarPaciente('arq');
    const a1 = await criarEndereco(patientId, 'Av. Siempre Viva 742');
    const serviceId = await criarServico(patientId, a1, { comFaixa: true });
    const vagaId = await semearVaga(patientId, a1);
    // arquiva o endereço: o serviço aponta para ele (cru), a vaga também; nenhum endereço vivo sobra
    await pool.query('UPDATE patient_addresses SET archived_at = now() WHERE id = $1', [a1]);
    const c: Cenario = { patientId, serviceId, addressId: a1, vagaId };
    const vagaAntes = await fotoVaga(vagaId);
    const servicoAntes = await fotoServico(serviceId);
    const auditAntes = await nAudit(vagaId);

    const p = await preview(c, U.completo, vagaId);
    expect(p.status).toBe(200);
    expect(p.data.data.preview.blockers).toContain('SERVICE_ADDRESS');
    expect(p.data.data.preview.canConfirm).toBe(false);

    const r = await confirmar(c, U.completo, vagaId);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.data)).toContain('LINK_BLOCKED');
    expect(JSON.stringify(r.data)).toContain('SERVICE_ADDRESS');

    expect(await fotoVaga(vagaId)).toEqual(vagaAntes);
    expect(await fotoServico(serviceId)).toEqual(servicoAntes);
    expect(await nAudit(vagaId)).toBe(auditAntes);
  });

  // ── 9. auditoria com "before" real ──────────────────────────────────────────────────────────────────────────
  it('9. serviço com endereço A1 ARQUIVADO + vaga com A2 VIVO → 200, serviço passa a A2 e a auditoria guarda before=A1 after=A2', async () => {
    const patientId = await criarPaciente('aud');
    const a1 = await criarEndereco(patientId, 'Av. Siempre Viva 742');
    const serviceId = await criarServico(patientId, a1, { comFaixa: true });
    const a2 = await criarEndereco(patientId, 'Calle Falsa 123');
    const vagaId = await semearVaga(patientId, a2);
    await pool.query('UPDATE patient_addresses SET archived_at = now() WHERE id = $1', [a1]);
    const c: Cenario = { patientId, serviceId, addressId: a1, vagaId };
    expect((await fotoServico(serviceId)).address_id).toBe(a1);

    const r = await confirmar(c, U.completo, vagaId);
    expect([r.status, r.data]).toEqual([200, expect.objectContaining({ success: true })]);

    expect((await fotoServico(serviceId)).address_id).toBe(a2);
    const { rows } = await pool.query<{ changes: { before: unknown; after: unknown } }>(
      `SELECT changes FROM job_posting_audit_log WHERE job_posting_id = $1 AND field_name = 'contracted_service.address_id'`, [vagaId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].changes).toEqual({ before: a1, after: a2 });
  });
});
