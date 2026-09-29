/**
 * vacancy-diagnoses.e2e.test.ts — fecha o gate `revisao-pr` do PR #562 (cid-na-vacante).
 *
 * `GET /api/admin/vacancies/:id` passou a embutir `diagnoses[]`/`diagnosesUnavailable` do
 * paciente (`vacancyPatientDiagnoses.ts`), sob a célula `patient_clinical:read`. O gate bloqueou
 * o merge porque isso só tinha unit com serviço FAKE — o gate de célula, o bulkhead e a RLS de
 * país nunca rodaram contra HTTP real + Postgres real. Este arquivo fecha os três.
 *
 * MOLDE: dois arquivos existentes, combinados —
 *  · `tests/e2e/helpers/permissionFamilyHarness.ts` (`montarAppDeFamilia`) — usado por
 *    `permission-enforcement-admin-patients.test.ts`/`me-simulation-route.e2e.test.ts`: sobe a
 *    CADEIA DE VERDADE (`dbSessionMiddleware` → `mockAuthMiddleware` → `AuthMiddleware` real →
 *    `PermissionMiddleware` real) num Express efêmero, ligando `PERMISSION_ENGINE_ENABLED` +
 *    `PERMISSION_ENFORCED_ROUTES=admin.vacancies` ANTES do boot — é o único jeito de fazer
 *    `req.permissionCells` (o que `cellsOfRequest`/`loadVacancyPatientDiagnoses` leem) nascer de
 *    verdade, em vez de ficar `null` (fail-open, D113).
 *  · `tests/e2e/patient-diagnoses-rls-context.e2e.test.ts` — o único e2e do repo que já testava
 *    RLS de país de verdade: cria uma role de LOGIN membro de `app_runtime` (NOLOGIN, NOBYPASSRLS
 *    — migration 269) e troca `DATABASE_URL` para ela ANTES do primeiro `DatabaseConnection`,
 *    porque `enlite_admin` (o usuário de todo o resto do e2e) é SUPERUSER com BYPASSRLS e a RLS
 *    simplesmente não vale para ele (medido: `psql \du` nesta stack confirma Superuser+BypassRLS).
 *
 * Nenhum dos dois moldes sozinho prova os 4 casos: o primeiro nunca ligou `COUNTRY_RLS_ENABLED`
 * (não precisava — testava só células), o segundo não passa pela rota HTTP nem por
 * `PermissionMiddleware` (testava o repositório direto). Combinados, a MESMA
 * `DatabaseConnection` singleton desta suíte fica: (a) conectada como a role não-owner
 * (`DATABASE_URL`), (b) com `COUNTRY_RLS_ENABLED=true`, e (c) o Express real por cima dela via
 * `montarAppDeFamilia`. Isso é viável — não é o caso "não dá para testar honestamente" que a
 * tarefa pediu para declarar como NÃO VIÁVEL.
 *
 * Todo o SEED/CLEANUP roda por um pool ADMIN separado (`enlite_admin`, bypassa RLS de propósito
 * — senão eu não conseguiria nem inserir o paciente BR nem confirmar, no caso 4, que a linha
 * BLOQUEADA realmente existe no banco). O app sob teste nunca usa esse pool.
 */
import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  garantirCelula,
  controllerStub,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5563/enlite_e2e';
const RUNTIME_USER = 'e2e_vacdiag_runtime';
const RUNTIME_PASSWORD = 'e2e_vacdiag_pw';

const PREFIXO = 'e2e-vacdiag-';
const U = {
  /** `vacancy:read` + `patient_clinical:read` — vê a vaga E o quadro clínico do paciente. */
  comCelula: `${PREFIXO}com-celula`,
  /** Só `vacancy:read` — vê a vaga, mas não o clínico (caso 2, o que protege o paciente). */
  semCelula: `${PREFIXO}sem-celula`,
};
const GRUPOS = {
  comCelula: 'E2E VacDiag Com Célula',
  semCelula: 'E2E VacDiag Sem Célula',
};

/** Título fictício — nunca dado clínico real (regra da casa). */
const TITULO_FELIZ_1 = 'Fictício QA — Transtorno Alfa';
const TITULO_FELIZ_2 = 'Fictício QA — Transtorno Beta';
/** O canário do caso 4 (RLS): se este texto aparecer na resposta do ator AR, a RLS vazou. */
const TITULO_RLS_BR = 'Fictício QA — Transtorno RLS-Cross-País (NUNCA deveria sair para ator AR)';

describe('GET /api/admin/vacancies/:id — diagnoses[] sob célula + bulkhead + RLS de país (HTTP real, banco real)', () => {
  let adminPool: Pool;
  let app: AppDeFamilia;

  const patientIds: Record<'happy' | 'noDiag' | 'rlsBr', string> = { happy: '', noDiag: '', rlsBr: '' };
  const vacancyIds: Record<'happy' | 'noDiag' | 'rlsBr', string> = { happy: '', noDiag: '', rlsBr: '' };

  let celulaClinicaCriada = false;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }
  function restaurarEnv(): void {
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }

  async function limparFixturesDeNegocio(): Promise<void> {
    await adminPool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [Object.values(vacancyIds).filter(Boolean)]);
    // `patient_diagnoses` cai por ON DELETE CASCADE junto com `patients`.
    await adminPool.query(`DELETE FROM patients WHERE id = ANY($1)`, [Object.values(patientIds).filter(Boolean)]);
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL });

    // ── Role não-owner, membro de app_runtime — a ÚNICA forma de RLS valer (enlite_admin bypassa) ──
    await adminPool.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_USER}') THEN
          CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PASSWORD}';
        END IF;
      END $$;`);
    await adminPool.query(`GRANT app_runtime TO ${RUNTIME_USER}`);

    // ── Fixtures de negócio (paciente + vaga), sempre pelo pool ADMIN (bypassa RLS) ──
    const felizPatient = await adminPool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('vacdiag-e2e-happy', 'QA', 'Feliz', 'AR', 'ACTIVE') RETURNING id`,
    );
    patientIds.happy = felizPatient.rows[0].id;

    const noDiagPatient = await adminPool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('vacdiag-e2e-nodiag', 'QA', 'SemDiagnostico', 'AR', 'ACTIVE') RETURNING id`,
    );
    patientIds.noDiag = noDiagPatient.rows[0].id;

    const rlsPatient = await adminPool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('vacdiag-e2e-rls-br', 'QA', 'OutroPais', 'BR', 'ACTIVE') RETURNING id`,
    );
    patientIds.rlsBr = rlsPatient.rows[0].id;

    // 2 diagnósticos ativos no paciente feliz (caso 1).
    await adminPool.query(
      `INSERT INTO patient_diagnoses
         (patient_id, terminology_system, concept_uri, concept_code, concept_title, concept_language,
          concept_group, catalog_release, source, is_primary, created_by, updated_by)
       VALUES
         ($1, 'ICD-11', 'http://e2e.local/vacdiag/alfa', 'QA10.Z', $2, 'es', '06', '2026-01', 'PANEL', true, 'e2e', 'e2e'),
         ($1, 'ICD-11', 'http://e2e.local/vacdiag/beta', 'QA11.Z', $3, 'es', '06', '2026-01', 'PANEL', false, 'e2e', 'e2e')`,
      [patientIds.happy, TITULO_FELIZ_1, TITULO_FELIZ_2],
    );

    // 1 diagnóstico no paciente BR — existe de verdade no banco; o caso 4 prova que o ator AR
    // nunca o vê, não que ele não exista.
    await adminPool.query(
      `INSERT INTO patient_diagnoses
         (patient_id, terminology_system, concept_uri, concept_code, concept_title, concept_language,
          concept_group, catalog_release, source, is_primary, created_by, updated_by)
       VALUES ($1, 'ICD-11', 'http://e2e.local/vacdiag/rls', 'QA12.Z', $2, 'es', '06', '2026-01', 'PANEL', true, 'e2e', 'e2e')`,
      [patientIds.rlsBr, TITULO_RLS_BR],
    );

    const vacHappy = await adminPool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso vacdiag E2E feliz', 'AR', 'SEARCHING', $1, 99991) RETURNING id`,
      [patientIds.happy],
    );
    vacancyIds.happy = vacHappy.rows[0].id;

    const vacNoDiag = await adminPool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso vacdiag E2E sem diagnostico', 'AR', 'SEARCHING', $1, 99992) RETURNING id`,
      [patientIds.noDiag],
    );
    vacancyIds.noDiag = vacNoDiag.rows[0].id;

    const vacRls = await adminPool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso vacdiag E2E RLS BR', 'BR', 'SEARCHING', $1, 99993) RETURNING id`,
      [patientIds.rlsBr],
    );
    vacancyIds.rlsBr = vacRls.rows[0].id;

    // ── IAM: usuários + célula (patient_clinical:read não está no seed 206 — garante) + grupos ──
    await limparIamFixtures(adminPool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });

    await adminPool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'vacdiag-com-celula@e2e.local', 'admin', 'ACTIVE', true, $3),
         ($2, 'vacdiag-sem-celula@e2e.local', 'admin', 'ACTIVE', true, $3)`,
      [U.comCelula, U.semCelula, TENANT_E2E],
    );

    const { criada } = await garantirCelula(adminPool, {
      resource: 'patient_clinical',
      action: 'read',
      category: 'Pacientes',
    });
    celulaClinicaCriada = criada;

    await grupoComCelulas(adminPool, {
      nome: GRUPOS.comCelula,
      uid: U.comCelula,
      celulas: [
        ['vacancy', 'read'],
        ['patient_clinical', 'read'],
      ],
    });
    await grupoComCelulas(adminPool, {
      nome: GRUPOS.semCelula,
      uid: U.semCelula,
      celulas: [['vacancy', 'read']],
    });

    // ── Liga o engine + a RLS de país ANTES do primeiro DatabaseConnection.getInstance() ──
    // (`montarAppDeFamilia`, chamado abaixo, faz esse primeiro `getInstance()` — depois disso
    // trocar DATABASE_URL não teria efeito: o pool já foi construído.)
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.vacancies');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('COUNTRY_RLS_ENABLED', 'true');
    setEnv(
      'DATABASE_URL',
      (() => {
        const url = new URL(ADMIN_DATABASE_URL);
        url.username = RUNTIME_USER;
        url.password = RUNTIME_PASSWORD;
        return url.toString();
      })(),
    );
    // Garante o ramo `DATABASE_URL` (dev/local) do construtor de `DatabaseConnection`, não o de
    // Cloud SQL — mesma cautela de `patient-diagnoses-rls-context.e2e.test.ts`.
    delete process.env.DB_HOST;

    const { createAdminVacanciesRoutes, VacanciesController } = await import('@modules/matching');
    const vacanciesController = new VacanciesController();

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.vacancies',
      ttlMs: 0,
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use(
          '/api/admin',
          createAdminVacanciesRoutes(
            vacanciesController,
            controllerStub('vacancyCrud') as never,
            controllerStub('vacancyTalentum') as never,
            controllerStub('vacancyMatch') as never,
            controllerStub('vacancyMeetLinks') as never,
            controllerStub('vacancySocialLinks') as never,
            controllerStub('funnel') as never,
            controllerStub('dashboard') as never,
            controllerStub('interviewSlots') as never,
            auth,
            permissions,
          ),
        ),
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();

    await limparFixturesDeNegocio();
    await limparIamFixtures(adminPool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    if (celulaClinicaCriada) {
      await adminPool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN
           (SELECT id FROM iam.permissions WHERE resource = 'patient_clinical' AND action = 'read')`,
      );
      await adminPool.query(`DELETE FROM iam.permissions WHERE resource = 'patient_clinical' AND action = 'read'`);
    }
    await adminPool.query(`REVOKE app_runtime FROM ${RUNTIME_USER}`).catch(() => undefined);
    await adminPool.query(`DROP ROLE IF EXISTS ${RUNTIME_USER}`).catch(() => undefined);
    await adminPool.end();

    restaurarEnv();
  }, 30000);

  async function getVacancy(id: string, uid: string, country: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}/api/admin/vacancies/${id}`, {
      headers: { Authorization: tokenMock(uid, 'admin', country) },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  it('1. FELIZ — ator COM patient_clinical:read vê os 2 títulos, e NENHUM item carrega conceptCode/conceptGroup/catalogRelease', async () => {
    const { status, body } = await getVacancy(vacancyIds.happy, U.comCelula, 'AR');

    expect(status).toBe(200);
    const { diagnoses, diagnosesUnavailable } = body.data;
    expect(diagnosesUnavailable).toBe(false);
    expect(Array.isArray(diagnoses)).toBe(true);
    expect(diagnoses).toHaveLength(2);
    expect(diagnoses.map((d: { title: string }) => d.title).sort()).toEqual(
      [TITULO_FELIZ_1, TITULO_FELIZ_2].sort(),
    );

    // A fronteira REQ-21: as CHAVES do objeto, não o valor — `conceptCode`/`conceptGroup`/
    // `catalogRelease` não podem existir no item, em NENHUMA forma (camelCase ou snake_case).
    for (const item of diagnoses) {
      const chaves = Object.keys(item);
      expect(chaves).toEqual(expect.arrayContaining(['id', 'uri', 'title', 'isPrimary', 'source', 'active']));
      expect(chaves).not.toEqual(expect.arrayContaining(['conceptCode', 'concept_code']));
      expect(chaves).not.toEqual(expect.arrayContaining(['conceptGroup', 'concept_group']));
      expect(chaves).not.toEqual(expect.arrayContaining(['catalogRelease', 'catalog_release']));
    }
  });

  it('2. SEM PERMISSÃO — ator SEM patient_clinical:read (mas com vacancy:read) recebe diagnoses === null, NUNCA []', async () => {
    const { status, body } = await getVacancy(vacancyIds.happy, U.semCelula, 'AR');

    expect(status).toBe(200); // vacancy:read basta para abrir a vaga
    expect(body.data.diagnoses).toBeNull();
    expect(body.data.diagnosesUnavailable).toBe(false);
    // Reforço: o título clínico do paciente FELIZ (que existe de verdade) não pode vazar por
    // nenhum outro campo da resposta.
    expect(JSON.stringify(body)).not.toContain(TITULO_FELIZ_1);
    expect(JSON.stringify(body)).not.toContain(TITULO_FELIZ_2);
  });

  it('3. SEM DIAGNÓSTICO — paciente sem linha em patient_diagnoses → [] e diagnosesUnavailable === false', async () => {
    const { status, body } = await getVacancy(vacancyIds.noDiag, U.comCelula, 'AR');

    expect(status).toBe(200);
    expect(body.data.diagnoses).toEqual([]);
    expect(body.data.diagnosesUnavailable).toBe(false);
  });

  it('4. RLS DE PAÍS — ator AR com patient_clinical:read NUNCA vê o diagnóstico do paciente BR, mesmo a linha existindo de verdade no banco', async () => {
    // Prova PRIMEIRO, pelo pool ADMIN (bypassa RLS), que a linha existe — sem isto o teste
    // passaria por ausência de dado, não por RLS bloqueando.
    const direto = await adminPool.query(
      `SELECT concept_title FROM patient_diagnoses WHERE patient_id = $1`,
      [patientIds.rlsBr],
    );
    expect(direto.rows).toEqual([{ concept_title: TITULO_RLS_BR }]);

    // Ator AR (sem grant de BR, sem system_context) pedindo a MESMA vaga via HTTP.
    const { status, body } = await getVacancy(vacancyIds.rlsBr, U.comCelula, 'AR');

    expect(status).toBe(200); // job_postings não tem RLS (D271) — a vaga em si abre
    // A RLS de `patients`/`patient_diagnoses` (migrations 271/413) esconde a linha: sob o
    // contexto do ator, `patientExists`/`listForPatient` não a enxergam — `found: false` →
    // `diagnoses: []`. Coincide na FORMA com o caso 3 (mesmo vocabulário de ausência, D286), mas
    // o MECANISMO é outro: aqui a linha existe e foi bloqueada, não está ausente.
    expect(body.data.diagnoses).toEqual([]);
    expect(body.data.diagnosesUnavailable).toBe(false);
    // A prova forte: o título clínico do paciente BR nunca aparece em NENHUM canto da resposta.
    expect(JSON.stringify(body)).not.toContain(TITULO_RLS_BR);
  });
});
