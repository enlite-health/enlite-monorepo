/**
 * Spec 048 — "Todavía no hay registro" / "No necesita" nos 4 campos de contato do PT, pela API real
 * (HTTP real, banco real, engine de permissão LIGADO na família admin.patients).
 *
 *  FELIZ        PENDING em Responsables e Equipo tratante → 201, `contactStatus` com `deadlineDate`, 1 ciclo + 3
 *               lembretes (dias 2/5/12) com `due_at` à 00:00 de Buenos Aires, SEM uid de quem marcou na resposta.
 *  ALTERNATIVO 1  ids + status no mesmo campo → 400, e nada é gravado.
 *  ALTERNATIVO 2  "No necesita" NOVO sem `patient_therapeutic_project:waive_contact` → 403 e nada gravado
 *               (versão/ciclo contam 0); com a célula → 201.
 *  Mais: editar outra coisa mantém `pendingSince` (prazo não reinicia) e não abre 2º ciclo; "No necesita" HERDADO
 *  passa sem a célula; preencher o campo na versão nova tira o pendente; campo novo pendente com ciclo aberto
 *  entra nele (P6); anular a versão que resolvia o campo abre ciclo (P5).
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const AR_TZ = 'America/Argentina/Buenos_Aires';

describe('spec 048 — PT com "Todavía no hay registro": API sob engine de permissão (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee048001-0a00-0001-0001-000000000001';
  let serviceId: string;
  let objectiveIds: string[];
  let activityIds: string[];
  let ptiSegmentId: string;
  let externalContactId: string;

  const U = { master: 'pt048-master', operador: 'pt048-operador' };
  const GRUPOS = { master: 'PT048 Master', operador: 'PT048 Operador' };
  const BASE_CELULAS: Array<[string, string]> = [
    ['patient', 'read'],
    ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'update'],
    ['patient_clinical', 'read'], ['patient_clinical', 'write'],
    ['patient_services', 'read'],
    ['patient_family', 'read'], ['patient_coverage', 'read'], ['patient_care_team', 'read'],
  ];

  const FIX_RELEASE = 'PT048-FIX';
  const CAP06 = { code: '06', title: 'Trastornos mentales, del comportamiento y del neurodesarrollo' };
  const URI_TEA = 'test://pt048/tea';
  let releaseAnterior: string | null = null;
  async function semearCid(): Promise<void> {
    await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 2) ON CONFLICT (release) DO NOTHING`, [FIX_RELEASE]);
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ('test://pt048/cap06', $1, $2, $3, NULL, $2, NULL, 'chapter', false) ON CONFLICT (icd_uri, release) DO NOTHING`,
      [FIX_RELEASE, CAP06.code, CAP06.title],
    );
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ($1, $2, '6A02', 'Trastorno del espectro autista', NULL, $3, NULL, 'stem', true) ON CONFLICT (icd_uri, release) DO NOTHING`,
      [URI_TEA, FIX_RELEASE, CAP06.code],
    );
    releaseAnterior = (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current LIMIT 1`)).rows[0]?.release ?? null;
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`);
    await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt048-e2e' WHERE release = $1`, [FIX_RELEASE]);
  }
  async function restaurarCid(): Promise<void> {
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = $1`, [FIX_RELEASE]);
    if (releaseAnterior) await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt048-e2e-restore' WHERE release = $1`, [releaseAnterior]);
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [FIX_RELEASE]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [FIX_RELEASE]);
  }

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

  async function chamar(metodo: string, caminho: string, uid: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const versionBody = (over: Record<string, unknown> = {}) => ({
    contractedServiceId: serviceId,
    modality: 'IN_PERSON',
    diagnoses: [{ uri: URI_TEA, code: '6A02', title: 'Diagnóstico sintético e2e' }],
    clinicalContext: 'Síntesis sintética e2e — texto de teste sem dado de titular.',
    generalObjective: 'Objetivo general sintético e2e.',
    specificObjectiveIds: objectiveIds.slice(0, 1),
    activityIds: activityIds.slice(0, 1),
    startDate: '2026-09-01',
    endDate: '2026-12-31',
    contactRefs: [],
    careTeamIds: [],
    contactStatus: {},
    ...over,
  });
  const newVersionBody = (over: Record<string, unknown> = {}) => ({ ...versionBody(), segmentId: ptiSegmentId, ...over });

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
  }
  // O trigger recusa DELETE de versão com paciente vivo: cada cenário usa um PACIENTE novo recriado aqui.
  async function recriarPaciente(): Promise<void> {
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
    await pool.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-048-api', 'Paciente', 'Sintético', 'AR', true)`, [PATIENT]);
    serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, 'CAREGIVER', 'e2e', 'e2e') RETURNING id`, [PATIENT],
    )).rows[0].id;
    externalContactId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, created_by)
       VALUES ($1, 'NEIGHBOR', 'Vizinha Sintética 048', $2, 'e2e-048') RETURNING id`,
      [PATIENT, Buffer.from('+54 11 0000-0001', 'utf8').toString('base64')],
    )).rows[0].id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pt048-master@e2e.local', 'Master Sintético', 'admin', 'ACTIVE', true, $3),
         ($2, 'pt048-operador@e2e.local', 'Operador Sintético', 'admin', 'ACTIVE', true, $3)`,
      [U.master, U.operador, TENANT_E2E],
    );
    for (const [resource, action] of BASE_CELULAS) await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    await garantirCelula(pool, { resource: 'patient_therapeutic_project', action: 'waive_contact', category: 'Pacientes' });
    await grupoComCelulas(pool, { nome: GRUPOS.master, uid: U.master, celulas: [...BASE_CELULAS, ['patient_therapeutic_project', 'waive_contact']] });
    await grupoComCelulas(pool, { nome: GRUPOS.operador, uid: U.operador, celulas: [...BASE_CELULAS] });

    objectiveIds = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order`)).rows.map((r) => r.id);
    activityIds = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_activities WHERE active ORDER BY sort_order`)).rows.map((r) => r.id);
    ptiSegmentId = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_segments WHERE active AND created_by = 'seed:495' ORDER BY sort_order LIMIT 1`)).rows[0].id;
    await semearCid();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/api/admin', caseModule.createAdminTherapeuticProjectsRoutes(new caseModule.AdminTherapeuticProjectsController(), auth, permissions));
        express.use(
          '/api/admin',
          caseModule.createAdminPatientsRoutes(
            new caseModule.AdminPatientsController(),
            auth,
            permissions,
            new caseModule.AdminPatientChatIdsController(),
            new caseModule.AdminPatientChatRolesController(),
            new caseModule.AdminPatientsMapController(),
            new caseModule.AdminPatientAddressesController(),
            new caseModule.AdminInsuranceProvidersController(),
            new caseModule.AdminPatientContractedServicesController(),
            new AdminPatientDiagnosesController(),
            new AdminTerminologySearchController(),
          ),
        );
      },
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await restaurarCid();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  beforeEach(async () => { await recriarPaciente(); });

  const BASE = () => `/api/admin/patients/${PATIENT}/therapeutic-projects`;
  const contar = async (tabela: string): Promise<number> =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabela} WHERE patient_id = $1`, [PATIENT])).rows[0].n;
  const lembretes = async () => (await pool.query<{ day_offset: number; due_local: string; hora: string; dia_ok: boolean }>(
    `SELECT r.day_offset,
            (r.due_at AT TIME ZONE $2)::date::text AS due_local,
            (r.due_at AT TIME ZONE $2)::time::text AS hora,
            ((r.due_at AT TIME ZONE $2)::date = ((c.anchored_at AT TIME ZONE $2)::date + r.day_offset)) AS dia_ok
       FROM patient_tp_contact_reminders r JOIN patient_tp_contact_reminder_cycles c ON c.id = r.cycle_id
      WHERE c.patient_id = $1 ORDER BY r.day_offset`, [PATIENT, AR_TZ])).rows;

  it('FELIZ: PENDING em Responsables e Equipo tratante → 201 com contactStatus + vencimento; 1 ciclo e 3 lembretes (2/5/12) à 00:00 de Buenos Aires; nenhum uid sai', async () => {
    const r = await chamar('POST', BASE(), U.operador, { mode: 'new', version: newVersionBody({ contactStatus: { RESPONSIBLE: 'PENDING', CARE_TEAM: 'PENDING' } }) });
    expect(r.status).toBe(201);
    const cs = r.body.data.contactStatus as Array<{ kind: string; status: string; pendingSince: string; deadlineDate: string }>;
    expect(cs.map((c) => [c.kind, c.status])).toEqual([['RESPONSIBLE', 'PENDING'], ['CARE_TEAM', 'PENDING']]);
    const hojeAr = (await pool.query<{ d: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [AR_TZ])).rows[0].d;
    const mais15 = (await pool.query<{ d: string }>(`SELECT ($1::date + 15)::text AS d`, [hojeAr])).rows[0].d;
    expect(cs[0].deadlineDate).toBe(mais15);
    expect(JSON.stringify(r.body)).not.toContain(U.operador);

    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(1);
    const l = await lembretes();
    expect(l.map((x) => x.day_offset)).toEqual([2, 5, 12]);
    expect(l.every((x) => x.hora === '00:00:00' && x.dia_ok)).toBe(true);
    // quem marcou = o autor da versão (gravado, mas nunca devolvido)
    const marcou = await pool.query(`SELECT DISTINCT marked_by_uid FROM patient_therapeutic_project_contact_status WHERE patient_id = $1`, [PATIENT]);
    expect(marcou.rows.map((x) => x.marked_by_uid)).toEqual([U.operador]);

    // a leitura (GET) devolve o mesmo estado, sem uid
    const g = await chamar('GET', BASE(), U.operador);
    expect(g.body.data.versions[0].contactStatus).toHaveLength(2);
    // as datas REAIS dos 3 lembretes que faltam (a confirmação da tela mostra isto; sem ciclo seria null)
    const somar = async (n: number): Promise<string> => (await pool.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [hojeAr, n])).rows[0].d;
    expect(g.body.data.contactReminderDates).toEqual([await somar(2), await somar(5), await somar(12)]);
    expect(JSON.stringify(g.body)).not.toContain(U.operador);
  });

  it('LISTA sem ciclo aberto: contactReminderDates é null', async () => {
    await chamar('POST', BASE(), U.operador, { mode: 'new', version: newVersionBody() });
    const g = await chamar('GET', BASE(), U.operador);
    expect(g.body.data.contactReminderDates).toBeNull();
  });

  it('ALTERNATIVO 1: ids + status no MESMO campo → 400 e nada gravado', async () => {
    const r = await chamar('POST', BASE(), U.operador, {
      mode: 'new',
      version: newVersionBody({ contactStatus: { EXTERNAL: 'PENDING' }, contactRefs: [{ kind: 'EXTERNAL', id: externalContactId }] }),
    });
    expect(r.status).toBe(400);
    expect(r.body.details.fields).toEqual(['version']);
    expect(await contar('patient_therapeutic_projects')).toBe(0);
    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(0);
    const semStatus = await chamar('POST', BASE(), U.operador, { mode: 'new', version: (({ contactStatus: _c, ...resto }) => resto)(newVersionBody()) });
    expect(semStatus.status).toBe(400);
  });

  it('ALTERNATIVO 2: "No necesita" NOVO sem waive_contact → 403 e nada gravado; com a célula → 201 e SEM ciclo', async () => {
    const negado = await chamar('POST', BASE(), U.operador, { mode: 'new', version: newVersionBody({ contactStatus: { COVERAGE: 'NOT_NEEDED' } }) });
    expect(negado.status).toBe(403);
    expect(negado.body.details.cell).toBe('patient_therapeutic_project:waive_contact');
    expect(await contar('patient_therapeutic_projects')).toBe(0);
    expect(await contar('patient_therapeutic_project_contact_status')).toBe(0);
    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(0);

    const ok = await chamar('POST', BASE(), U.master, { mode: 'new', version: newVersionBody({ contactStatus: { COVERAGE: 'NOT_NEEDED' } }) });
    expect(ok.status).toBe(201);
    expect(ok.body.data.contactStatus).toEqual([{ kind: 'COVERAGE', status: 'NOT_NEEDED', pendingSince: null, deadlineDate: null }]);
    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(0);
  });

  it('"No necesita" HERDADO passa sem a célula (o operador só salva outra coisa); trocar por contatos também', async () => {
    const v10 = (await chamar('POST', BASE(), U.master, { mode: 'new', version: newVersionBody({ contactStatus: { COVERAGE: 'NOT_NEEDED' } }) })).body.data.id;
    const herdado = await chamar('POST', BASE(), U.operador, { mode: 'edit', fromVersionId: v10, version: versionBody({ modality: 'ONLINE', contactStatus: { COVERAGE: 'NOT_NEEDED' } }) });
    expect(herdado.status).toBe(201);
    expect(herdado.body.data.contactStatus[0].status).toBe('NOT_NEEDED');
    const trocado = await chamar('POST', BASE(), U.operador, { mode: 'edit', fromVersionId: herdado.body.data.id, version: versionBody({ modality: 'HYBRID', contactRefs: [{ kind: 'EXTERNAL', id: externalContactId }] }) });
    expect(trocado.status).toBe(201);
    expect(trocado.body.data.contactStatus).toEqual([]);
  });

  it('editar OUTRA coisa mantém o prazo (pendingSince herdado) e NÃO abre 2º ciclo; preencher o campo na versão nova tira o pendente', async () => {
    const v10 = await chamar('POST', BASE(), U.operador, { mode: 'new', version: newVersionBody({ contactStatus: { RESPONSIBLE: 'PENDING', CARE_TEAM: 'PENDING' } }) });
    const since = v10.body.data.contactStatus[0].pendingSince;
    const v11 = await chamar('POST', BASE(), U.operador, { mode: 'edit', fromVersionId: v10.body.data.id, version: versionBody({ modality: 'ONLINE', contactStatus: { RESPONSIBLE: 'PENDING', CARE_TEAM: 'PENDING' } }) });
    expect(v11.status).toBe(201);
    expect(v11.body.data.contactStatus.map((c: any) => c.pendingSince)).toEqual([since, since]);
    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(1);

    const v12 = await chamar('POST', BASE(), U.master, { mode: 'edit', fromVersionId: v11.body.data.id, version: versionBody({ modality: 'HYBRID', contactRefs: [{ kind: 'EXTERNAL', id: externalContactId }], contactStatus: { CARE_TEAM: 'PENDING' } }) });
    expect(v12.status).toBe(201);
    expect(v12.body.data.contactStatus.map((c: any) => c.kind)).toEqual(['CARE_TEAM']);
    expect(v12.body.data.contactStatus[0].pendingSince).toBe(since);
    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(1);
  });

  it('campo NOVO pendente com ciclo aberto entra no ciclo corrente: nenhum 2º ciclo, nenhum lembrete a mais (P6, Opção A)', async () => {
    const v10 = await chamar('POST', BASE(), U.operador, { mode: 'new', version: newVersionBody({ contactStatus: { RESPONSIBLE: 'PENDING' } }) });
    const v11 = await chamar('POST', BASE(), U.operador, { mode: 'edit', fromVersionId: v10.body.data.id, version: versionBody({ contactStatus: { RESPONSIBLE: 'PENDING', COVERAGE: 'PENDING' } }) });
    expect(v11.status).toBe(201);
    expect(v11.body.data.contactStatus.map((c: any) => c.kind)).toEqual(['RESPONSIBLE', 'COVERAGE']);
    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(1);
    expect((await lembretes()).length).toBe(3);
  });

  it('anular a versão que resolvia o campo deixa a vigente pendente e ABRE ciclo com 3 lembretes (P5, 08/10)', async () => {
    const v10 = await chamar('POST', BASE(), U.operador, { mode: 'new', version: newVersionBody({ contactStatus: { CARE_TEAM: 'PENDING' } }) });
    // fecha o ciclo como o 12º dia faria (a varredura é a F3; aqui só preparamos o estado)
    await pool.query(`UPDATE patient_tp_contact_reminder_cycles SET closed_at = now(), close_reason = 'COMPLETED' WHERE patient_id = $1`, [PATIENT]);
    const v11 = await chamar('POST', BASE(), U.operador, { mode: 'edit', fromVersionId: v10.body.data.id, version: versionBody({ modality: 'ONLINE', contactRefs: [{ kind: 'EXTERNAL', id: externalContactId }] }) });
    expect(v11.status).toBe(201);
    expect(await contar('patient_tp_contact_reminder_cycles')).toBe(1);
    const anulou = await chamar('POST', `${BASE()}/${v11.body.data.id}/annul`, U.operador, { reason: 'carga errada' });
    expect(anulou.status).toBe(200);
    const abertos = await pool.query(`SELECT 1 FROM patient_tp_contact_reminder_cycles WHERE patient_id = $1 AND closed_at IS NULL`, [PATIENT]);
    expect(abertos.rowCount).toBe(1);
    const doAberto = await pool.query(
      `SELECT r.day_offset FROM patient_tp_contact_reminders r JOIN patient_tp_contact_reminder_cycles c ON c.id = r.cycle_id
        WHERE c.patient_id = $1 AND c.closed_at IS NULL ORDER BY r.day_offset`, [PATIENT]);
    expect(doAberto.rows.map((x) => x.day_offset)).toEqual([2, 5, 12]);
  });
});
