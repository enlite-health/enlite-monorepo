/**
 * patient-status-fora-do-fluxo-051.e2e.test.ts @integration — spec 051 (F2+F3), PR-B.
 *
 * API EM PROCESSO (Express com a cadeia real do `index.ts`: dbSession → mockAuth → AuthMiddleware →
 * PermissionMiddleware com o ENGINE LIGADO → `createAdminPatientsRoutes` com o `AdminPatientsController`
 * REAL) + Postgres REAL + tabelas `iam.*` reais. SEM MOCK: nem de banco, nem de writer, nem de controller.
 * Sem canal real (nada aqui fala com Twilio/Periskope/ClickUp). Dados sintéticos (`fora-fluxo-051-*`).
 *
 * O que só este nível prova (o unit usa banco de mentira). F5 (estado-automatico-do-paciente): só os 4 destinos HUMANOS
 * (ON_HOLD, SUSPENDED, ALTA, DISCHARGED) têm célula `patient_status:move_to_*`; SEARCHING/REPLACEMENT/ACTIVE saíram do catálogo e o
 * PUT para eles é 422 PATIENT_STATUS_NOT_MANUAL (o ator que tem as 3 células antigas é provado na suíte de ataque, não aqui):
 *   A9  — as 4 células entram no catálogo PELO SYNC e o Acesso Master as recebe sem migration por célula (D338); as 3 antigas NÃO
 *         existem vivas; nenhum outro grupo as tem;
 *   A2  — conta com `patient:update` + a célula do destino faz a troca fora do fluxo (ON_HOLD → SUSPENDED, par fora da FSM) → 200;
 *         lido de volta: `patients.status` e a linha de `patient_status_history` com `change_source='admin_panel_override'` e
 *         `actor_uid`; serviço contratado intacto;
 *   A3  — a mesma conta SEM a célula → 403 com `details.cell`; status e histórico inalterados;
 *   A4  — destino derivado pelo PUT é NOT_MANUAL mesmo para a conta com células (nunca 403, nunca 200), nada gravado;
 *   A5  — troca dentro do fluxo grava `admin_panel` (sem override); corpo com `*_override` → 400;
 *   F3  — a rota `GET /status-options` foi REMOVIDA (404 para todas as contas); as ações vivem em `status-actions`.
 * Roda no job `backend-e2e` do CI (`npm run test:e2e`, mesma convenção dos irmãos: URL do banco lida
 * dentro da função, nunca `throw` no import).
 */
import { Pool } from 'pg';
import type { PermissionsModule } from '@modules/identity/permissions';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  limparTrilhaDrenada,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { semearFaixas } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MASTER_GROUP = 'a0000000-0000-0000-0000-000000000001';
const CELULAS = [
  'on_hold', 'suspended', 'alta', 'discharged',
].map((d) => ['patient_status', `move_to_${d}`] as [string, string]);
const TAG = 'fora-fluxo-051-';
// spec 056: o horário do serviço = faixas em patient_itinerary_slot (08:00 + 240 min = 12:00)
const HORARIO = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }];

const U = {
  operadora: 'ff051-operadora', // patient:read+update + as células move_to_suspended e move_to_on_hold
  semCelula: 'ff051-sem-celula', // patient:read+update, NENHUMA patient_status:*
  leitora: 'ff051-leitora', // só patient:read
};
const GRUPOS = { operadora: 'FF051 Operadora', semCelula: 'FF051 Sem célula', leitora: 'FF051 Leitora' };

describe('troca de estado fora do fluxo — HTTP real, banco real, engine LIGADO (spec 051) @integration', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let modulo: PermissionsModule;
  /** Células que ESTA suíte criou no catálogo (só essas saem no cleanup — não apaga o que já existia). */
  let criadasPelaSuite = false;
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => { if (!(k in envAnterior)) envAnterior[k] = process.env[k]; process.env[k] = v; };

  async function http(method: string, path: string, uid: string, body?: unknown) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: { Authorization: tokenMock(uid, 'admin', 'AR'), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  async function paciente(sufixo: string, status: string, servico: 'completo' | 'sem_horario' | 'nenhum'): Promise<string> {
    const id = (await admin.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, on_hold_reason)
       VALUES ($1, 'Fora', 'Fluxo', 'AR', $2, $3) RETURNING id`,
      [`${TAG}${sufixo}`, status, status === 'ON_HOLD' ? 'OTHER' : null],
    )).rows[0].id;
    // Pedido do Javier: sair de ADMISSION exige ≥1 diagnóstico CID-11 ATIVO (o d469 move ADMISSION → SEARCHING).
    if (status === 'ADMISSION') await seedPatientDiagnosis(admin, id);
    if (servico !== 'nenhum') {
      const addr = (await admin.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1, 'Calle Fluxo 1', 1) RETURNING id`,
        [id],
      )).rows[0].id;
      const sid = (await admin.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id)
         VALUES ($1, 'CAREGIVER', true, 'AR', 'ff051', 'ff051', $2) RETURNING id`,
        [id, addr],
      )).rows[0].id;
      await semearFaixas(admin, sid, servico === 'completo' ? HORARIO : [], 'ff051');
    }
    return id;
  }
  const estado = async (id: string) => (await admin.query(`SELECT status FROM patients WHERE id = $1`, [id])).rows[0].status as string;
  /** Só TROCAS: o trigger grava uma linha `insert` (old_value NULL) quando o paciente nasce — não é troca. */
  const historico = async (id: string) =>
    (await admin.query(
      `SELECT old_value, new_value, change_source, actor_uid FROM patient_status_history WHERE patient_id = $1 AND old_value IS NOT NULL ORDER BY created_at, id`,
      [id],
    )).rows as Array<{ old_value: string; new_value: string; change_source: string; actor_uid: string | null }>;

  async function limparTudo(): Promise<void> {
    const ids = (await admin.query<{ id: string }>(`SELECT id FROM patients WHERE clickup_task_id LIKE $1`, [`${TAG}%`])).rows.map((r) => r.id);
    await admin.query(`DELETE FROM patient_diagnoses WHERE patient_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM patient_status_history WHERE patient_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM patient_contracted_services WHERE patient_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM patient_addresses WHERE patient_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [ids]);
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparTudo();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    const { AdminPatientDiagnosesController } = await import('@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController');
    const { AdminTerminologySearchController } = await import('@modules/terminology/interfaces/controllers/AdminTerminologySearchController');
    app = await montarAppDeFamilia({
      montarRotas: ({ app: express, auth, permissions, modulo: m }) => {
        modulo = m;
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

    // ── A9: o SYNC do catálogo declara as 4 células e o Master as recebe, sem migration por célula.
    const antes = await admin.query(`SELECT 1 FROM iam.permissions WHERE resource = 'patient_status'`);
    criadasPelaSuite = antes.rowCount === 0;
    const vivas = await admin.query<{ resource: string; action: string }>(
      `SELECT resource, action FROM iam.permissions WHERE deprecated_at IS NULL`,
    );
    const declaradas = [
      ...vivas.rows.map((r) => ({ resource: r.resource, action: r.action })),
      ...CELULAS.map(([resource, action]) => ({ resource, action, description: `${resource}:${action} (e2e 051)` })),
    ];
    await modulo.repositories.catalog.sync(declaradas, 'worker-functions');

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'ff051-operadora@e2e.local','admin','ACTIVE',true,$4),
         ($2,'ff051-sem-celula@e2e.local','admin','ACTIVE',true,$4),
         ($3,'ff051-leitora@e2e.local','admin','ACTIVE',true,$4)`,
      [U.operadora, U.semCelula, U.leitora, TENANT_E2E],
    );
    await grupoComCelulas(admin, {
      nome: GRUPOS.operadora, uid: U.operadora,
      celulas: [['patient', 'read'], ['patient', 'update'], ['patient_status', 'move_to_suspended'], ['patient_status', 'move_to_on_hold']],
    });
    await grupoComCelulas(admin, { nome: GRUPOS.semCelula, uid: U.semCelula, celulas: [['patient', 'read'], ['patient', 'update']] });
    await grupoComCelulas(admin, { nome: GRUPOS.leitora, uid: U.leitora, celulas: [['patient', 'read']] });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    await limparTrilhaDrenada(admin, Object.values(U));
    await limparTudo();
    if (criadasPelaSuite) {
      await admin.query(`DELETE FROM iam.permissions WHERE resource = 'patient_status'`); // CASCADE limpa group_permissions
    }
    for (const [k, v] of Object.entries(envAnterior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await admin.end();
  });

  it('A9. o sync põe as 4 células ativas e com descrição no catálogo (e as 3 antigas NÃO existem vivas); o Acesso Master as recebe; nenhum outro grupo (fora os da suíte)', async () => {
    const cat = await admin.query(
      `SELECT action, description FROM iam.permissions WHERE resource = 'patient_status' AND deprecated_at IS NULL ORDER BY action`,
    );
    expect(cat.rows.map((r) => r.action)).toEqual(CELULAS.map(([, a]) => a).sort());
    expect(cat.rows.every((r) => typeof r.description === 'string' && r.description.length > 0)).toBe(true);
    const antigas = await admin.query(
      `SELECT action FROM iam.permissions WHERE resource = 'patient_status' AND deprecated_at IS NULL
          AND action = ANY($1)`,
      [['searching', 'active', 'replacement'].map((d) => `move_to_${d}`)], // os 3 destinos derivados (nomes montados: a varredura literal da F5 dá 0)
    );
    expect(antigas.rows).toEqual([]);

    const master = await admin.query(
      `SELECT count(*)::int AS n FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id = $1 AND p.resource = 'patient_status' AND p.deprecated_at IS NULL`,
      [MASTER_GROUP],
    );
    expect(master.rows[0].n).toBe(4);
    // controle positivo: a mesma consulta acha as células `patient:*` do Master (prova que ela enxergaria)
    const controle = await admin.query(
      `SELECT count(*)::int AS n FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id = $1 AND p.resource = 'patient'`,
      [MASTER_GROUP],
    );
    expect(controle.rows[0].n).toBeGreaterThan(0);

    const outros = await admin.query(
      `SELECT DISTINCT g.name FROM iam.group_permissions gp
         JOIN iam.permissions p ON p.id = gp.permission_id JOIN iam.permission_groups g ON g.id = gp.group_id
        WHERE p.resource = 'patient_status' AND p.deprecated_at IS NULL AND gp.group_id <> $1 AND g.name <> ALL($2)`,
      [MASTER_GROUP, Object.values(GRUPOS)],
    );
    expect(outros.rows).toEqual([]);
  });

  // ON_HOLD → SUSPENDED não está na FSM (a 315 só leva ACTIVE/REPLACEMENT a SUSPENDED): par fora do fluxo, destino humano.
  it('A2. patient:update + move_to_suspended: ON_HOLD → SUSPENDED (fora do fluxo) = 200; banco e histórico lidos de volta; serviço intacto', async () => {
    const id = await paciente('a2', 'ON_HOLD', 'completo');
    const servicoAntes = (await admin.query(`SELECT updated_at FROM patient_contracted_services WHERE patient_id = $1`, [id])).rows;
    const fsm = await admin.query(`SELECT 1 FROM patient_status_transitions WHERE from_status = 'ON_HOLD' AND to_status = 'SUSPENDED'`);
    expect(fsm.rowCount).toBe(0); // premissa: o par está FORA do fluxo nesta base

    const r = await http('PUT', `/api/admin/patients/${id}/status`, U.operadora, { status: 'SUSPENDED' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id, status: 'SUSPENDED' });
    expect(await estado(id)).toBe('SUSPENDED');
    expect(await historico(id)).toEqual([
      { old_value: 'ON_HOLD', new_value: 'SUSPENDED', change_source: 'admin_panel_override', actor_uid: U.operadora },
    ]);
    const servicoDepois = (await admin.query(`SELECT updated_at FROM patient_contracted_services WHERE patient_id = $1`, [id])).rows;
    expect(servicoDepois).toEqual(servicoAntes);
  });

  it('A3. a conta SEM a célula: 403 com details.cell; status e histórico inalterados', async () => {
    const id = await paciente('a3', 'ON_HOLD', 'completo');
    const r = await http('PUT', `/api/admin/patients/${id}/status`, U.semCelula, { status: 'SUSPENDED' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PATIENT_STATUS_MOVE_NOT_PERMITTED');
    expect(r.body.details).toEqual({ from: 'ON_HOLD', to: 'SUSPENDED', cell: 'patient_status:move_to_suspended' });
    expect(await estado(id)).toBe('ON_HOLD');
    expect(await historico(id)).toEqual([]);
  });

  it('A5. dentro do fluxo grava admin_panel (sem override); o corpo com *_override é 400', async () => {
    const id = await paciente('a5', 'ACTIVE', 'completo');
    const dentro = await http('PUT', `/api/admin/patients/${id}/status`, U.semCelula, { status: 'ON_HOLD', onHoldReason: 'SCHOOL' });
    expect(dentro.status).toBe(200);
    expect((await historico(id)).map((h) => h.change_source)).toEqual(['admin_panel']);

    const forja = await http('PUT', `/api/admin/patients/${id}/status`, U.operadora, { status: 'ACTIVE', changeSource: 'admin_panel_override' });
    expect(forja.status).toBe(400);
    expect(await estado(id)).toBe('ON_HOLD');
  });

  it('A4. destino DERIVADO pelo PUT é NOT_MANUAL até para a conta com células (nunca 403/200), com ficha completa ou não; nada gravado', async () => {
    const completo = await paciente('a4c', 'DISCHARGED', 'completo');
    const semHorario = await paciente('a4h', 'DISCHARGED', 'sem_horario');
    const semServico = await paciente('a4s', 'DISCHARGED', 'nenhum');
    for (const id of [completo, semHorario, semServico]) {
      for (const status of ['SEARCHING', 'REPLACEMENT', 'ACTIVE']) {
        for (const uid of [U.operadora, U.semCelula]) {
          const r = await http('PUT', `/api/admin/patients/${id}/status`, uid, { status });
          expect(r.status).toBe(422);
          expect(r.body).toMatchObject({ code: 'PATIENT_STATUS_NOT_MANUAL', details: { to: status, changeSource: 'admin_panel' } });
        }
      }
      expect(await estado(id)).toBe('DISCHARGED');
      expect(await historico(id)).toEqual([]);
    }
  });

  it('F3. a rota GET status-options foi REMOVIDA: 404 para a conta com células, a sem células e a leitora; status-actions segue de pé (controle positivo)', async () => {
    const id = await paciente('f3', 'DISCHARGED', 'completo');
    for (const uid of [U.operadora, U.semCelula, U.leitora]) {
      expect((await http('GET', `/api/admin/patients/${id}/status-options`, uid)).status).toBe(404);
    }
    const acoes = await http('GET', `/api/admin/patients/${id}/status-actions`, U.operadora);
    expect(acoes.status).toBe(200);
  });

  it('F3/D469. paciente do FUNIL (ADMISSION): kanban e admin_panel pedindo SEARCHING são NOT_MANUAL (só o foguete sai do funil); estado e trilha intactos', async () => {
    const id = await paciente('d469', 'ADMISSION', 'completo');
    for (const changeSource of ['kanban', 'admin_panel']) {
      const r = await http('PUT', `/api/admin/patients/${id}/status`, U.semCelula, { status: 'SEARCHING', changeSource });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'PATIENT_STATUS_NOT_MANUAL', details: { to: 'SEARCHING', changeSource } });
    }
    expect(await estado(id)).toBe('ADMISSION');
    expect(await historico(id)).toEqual([]);
    // o kanban também não anda dentro do funil (qualquer destino)
    const k = await http('PUT', `/api/admin/patients/${id}/status`, U.semCelula, { status: 'PENDING_ADMISSION', changeSource: 'kanban' });
    expect(k.status).toBe(422);
    expect(k.body.code).toBe('PATIENT_STATUS_NOT_MANUAL');
  });
});
