/**
 * patient-status-fora-do-fluxo-051.e2e.test.ts @integration — spec 051 (F2+F3), PR-B.
 *
 * API EM PROCESSO (Express com a cadeia real do `index.ts`: dbSession → mockAuth → AuthMiddleware →
 * PermissionMiddleware com o ENGINE LIGADO → `createAdminPatientsRoutes` com o `AdminPatientsController`
 * REAL) + Postgres REAL + tabelas `iam.*` reais. SEM MOCK: nem de banco, nem de writer, nem de controller.
 * Sem canal real (nada aqui fala com Twilio/Periskope/ClickUp). Dados sintéticos (`fora-fluxo-051-*`).
 *
 * O que só este nível prova (o unit usa banco de mentira):
 *   A9  — as 7 células `patient_status:move_to_*` entram no catálogo PELO SYNC e o Acesso Master as
 *         recebe sem migration por célula (D338); nenhum outro grupo as tem;
 *   A2  — conta com `patient:update` + a célula do destino faz a troca fora do fluxo → 200; lido de
 *         volta: `patients.status` e a linha de `patient_status_history` com
 *         `change_source='admin_panel_override'` e `actor_uid`; serviço contratado intacto;
 *   A3  — a mesma conta SEM a célula → 403 com `details.cell`; status e histórico inalterados;
 *   A4  — a integridade vale COM a célula (SEARCHING sem horário / sem serviço → 422, nada gravado);
 *   A5  — troca dentro do fluxo grava `admin_panel` (sem override); corpo com `*_override` → 400;
 *   F3  — `GET /status-options` coerente com as duas contas e exige `patient:update`.
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

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MASTER_GROUP = 'a0000000-0000-0000-0000-000000000001';
const CELULAS = [
  'searching', 'active', 'replacement', 'on_hold', 'suspended', 'alta', 'discharged',
].map((d) => ['patient_status', `move_to_${d}`] as [string, string]);
const TAG = 'fora-fluxo-051-';
const HORARIO = '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]';

const U = {
  operadora: 'ff051-operadora', // patient:read+update + a célula move_to_searching (e move_to_on_hold)
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
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Fora', 'Fluxo', 'AR', $2) RETURNING id`,
      [`${TAG}${sufixo}`, status],
    )).rows[0].id;
    if (servico !== 'nenhum') {
      const addr = (await admin.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1, 'Calle Fluxo 1', 1) RETURNING id`,
        [id],
      )).rows[0].id;
      await admin.query(
        `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ($1, 'CAREGIVER', true, 'AR', 'ff051', 'ff051', $2, $3::jsonb)`,
        [id, addr, servico === 'completo' ? HORARIO : null],
      );
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

    // ── A9: o SYNC do catálogo declara as 7 células e o Master as recebe, sem migration por célula.
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
      celulas: [['patient', 'read'], ['patient', 'update'], ['patient_status', 'move_to_searching'], ['patient_status', 'move_to_on_hold']],
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

  it('A9. o sync põe as 7 células ativas e com descrição no catálogo; o Acesso Master as recebe; nenhum outro grupo (fora os da suíte)', async () => {
    const cat = await admin.query(
      `SELECT action, description FROM iam.permissions WHERE resource = 'patient_status' AND deprecated_at IS NULL ORDER BY action`,
    );
    expect(cat.rows.map((r) => r.action)).toEqual(CELULAS.map(([, a]) => a).sort());
    expect(cat.rows.every((r) => typeof r.description === 'string' && r.description.length > 0)).toBe(true);

    const master = await admin.query(
      `SELECT count(*)::int AS n FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id = $1 AND p.resource = 'patient_status'`,
      [MASTER_GROUP],
    );
    expect(master.rows[0].n).toBe(7);
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
        WHERE p.resource = 'patient_status' AND gp.group_id <> $1 AND g.name <> ALL($2)`,
      [MASTER_GROUP, Object.values(GRUPOS)],
    );
    expect(outros.rows).toEqual([]);
  });

  it('A2. patient:update + move_to_searching: ACTIVE → SEARCHING (fora do fluxo) = 200; banco e histórico lidos de volta; serviço intacto', async () => {
    const id = await paciente('a2', 'ACTIVE', 'completo');
    const servicoAntes = (await admin.query(`SELECT updated_at FROM patient_contracted_services WHERE patient_id = $1`, [id])).rows;
    const fsm = await admin.query(`SELECT 1 FROM patient_status_transitions WHERE from_status = 'ACTIVE' AND to_status = 'SEARCHING'`);
    expect(fsm.rowCount).toBe(0); // premissa: o par está FORA do fluxo nesta base

    const r = await http('PUT', `/api/admin/patients/${id}/status`, U.operadora, { status: 'SEARCHING' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id, status: 'SEARCHING' });
    expect(await estado(id)).toBe('SEARCHING');
    expect(await historico(id)).toEqual([
      { old_value: 'ACTIVE', new_value: 'SEARCHING', change_source: 'admin_panel_override', actor_uid: U.operadora },
    ]);
    const servicoDepois = (await admin.query(`SELECT updated_at FROM patient_contracted_services WHERE patient_id = $1`, [id])).rows;
    expect(servicoDepois).toEqual(servicoAntes);
  });

  it('A3. a conta SEM a célula: 403 com details.cell; status e histórico inalterados', async () => {
    const id = await paciente('a3', 'ACTIVE', 'completo');
    const r = await http('PUT', `/api/admin/patients/${id}/status`, U.semCelula, { status: 'SEARCHING' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PATIENT_STATUS_MOVE_NOT_PERMITTED');
    expect(r.body.details).toEqual({ from: 'ACTIVE', to: 'SEARCHING', cell: 'patient_status:move_to_searching' });
    expect(await estado(id)).toBe('ACTIVE');
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

  it('A4. a integridade vale COM a célula: SEARCHING sem horário e sem serviço → 422, nada gravado', async () => {
    const semHorario = await paciente('a4h', 'DISCHARGED', 'sem_horario');
    const r1 = await http('PUT', `/api/admin/patients/${semHorario}/status`, U.operadora, { status: 'SEARCHING' });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('PATIENT_STATUS_NOT_READY');
    expect(r1.body.details.missing).toEqual(['SERVICE_SCHEDULE']);
    expect(await estado(semHorario)).toBe('DISCHARGED');
    expect(await historico(semHorario)).toEqual([]);

    const semServico = await paciente('a4s', 'DISCHARGED', 'nenhum');
    const r2 = await http('PUT', `/api/admin/patients/${semServico}/status`, U.operadora, { status: 'SEARCHING' });
    expect(r2.status).toBe(422);
    expect(r2.body.details.missing).toContain('CONTRACTED_SERVICE');
    expect(await estado(semServico)).toBe('DISCHARGED');
  });

  it('F3. status-options: coerente com as duas contas; blockedBy nos destinos que o PUT recusaria; exige patient:update', async () => {
    const id = await paciente('f3', 'ACTIVE', 'completo');
    const fsmDeActive = (await admin.query<{ to_status: string }>(
      `SELECT to_status FROM patient_status_transitions WHERE from_status = 'ACTIVE'`,
    )).rows.map((r) => r.to_status).sort();

    const com = await http('GET', `/api/admin/patients/${id}/status-options`, U.operadora);
    expect(com.status).toBe(200);
    expect(com.body.data.current).toBe('ACTIVE');
    const viaPermissao = (com.body.data.options as Array<{ status: string; via: string }>).filter((o) => o.via === 'permissao').map((o) => o.status).sort();
    expect(viaPermissao).toEqual(['SEARCHING'].filter((s) => !fsmDeActive.includes(s)));
    expect(com.body.data.options.map((o: { status: string }) => o.status)).not.toContain('ACTIVE');

    const sem = await http('GET', `/api/admin/patients/${id}/status-options`, U.semCelula);
    expect(sem.status).toBe(200);
    expect((sem.body.data.options as Array<{ status: string }>).map((o) => o.status).sort()).toEqual(fsmDeActive);
    expect((sem.body.data.options as Array<{ via: string }>).every((o) => o.via === 'fluxo')).toBe(true);

    // o que a lista oferece o PUT aceita; o que não oferece o PUT recusa (A6, no nível do HTTP)
    expect((await http('PUT', `/api/admin/patients/${id}/status`, U.semCelula, { status: 'SEARCHING' })).status).toBe(403);

    const incompleto = await paciente('f3b', 'DISCHARGED', 'sem_horario');
    const blk = await http('GET', `/api/admin/patients/${incompleto}/status-options`, U.operadora);
    expect((blk.body.data.options as Array<{ status: string; blockedBy?: string[] }>).find((o) => o.status === 'SEARCHING'))
      .toEqual({ status: 'SEARCHING', via: 'permissao', blockedBy: ['SERVICE_SCHEDULE'] });

    const leitora = await http('GET', `/api/admin/patients/${id}/status-options`, U.leitora);
    expect(leitora.status).toBe(403);
  });
});
