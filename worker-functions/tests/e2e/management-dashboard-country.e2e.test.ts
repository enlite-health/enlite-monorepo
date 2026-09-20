/**
 * management-dashboard-country.e2e.test.ts (PR-9, `lex` #9)
 *
 * Banco REAL — mesmo padrão de `management-dashboard.integration.test.ts` e
 * `country-rls-policies.test.ts`: instancia `resolveCountryScope` e
 * `GetManagementDashboardUseCase` com o pool direto, e monta os grupos/scopes
 * como o app faz via `iam.grant_country`/`user_groups`/`permission_groups`
 * (compat views em `public`, tabelas reais em `iam`).
 *
 * Cobre:
 *   L9-2 — ator {AR} pedindo BR → 403; ator {AR} pedindo ALL → só AR (comparado
 *          com contagem direta por SQL).
 *   L9-3 — o MESMO cenário com COUNTRY_RLS_ENABLED=false e
 *          PERMISSION_ENGINE_ENABLED=false (modo PRD) dá o MESMO resultado —
 *          o predicado nunca depende dessas flags.
 *   L9-5 — consolidado (ALL, |actorCountries|>1) só com TODO grant com
 *          `granted_by` preenchido (D113). `reason` NÃO é mais exigido desde
 *          a migration 412 (`412_group_country_reason_opcional.sql`) e a
 *          decisão do Gabriel em 20/09/2026 — um grant sem `reason` (mas com
 *          `granted_by`) soma normalmente na união. O parecer do `lex` (#9,
 *          11/09) que impunha `reason` obrigatório valia para o padrão
 *          antigo; não foi reaberto, só alinhado ao teto novo da coluna.
 */
import { Pool } from 'pg';
import { resolveCountryScope, CountryScopeError } from '../../src/modules/identity/application/resolveCountryScope';
import { GetManagementDashboardUseCase } from '../../src/modules/matching/application/GetManagementDashboardUseCase';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5565/enlite_e2e';

const TENANT = '00000000-0000-0000-0000-000000000001';

// Fixos de propósito (não por timestamp): o Postgres desta suíte é EXCLUSIVO
// da worktree 018-pr9 (docker-compose -p 018-pr9), e o `cleanup()` no
// beforeAll/afterAll garante idempotência entre reruns — nenhum outro teste
// grava nestes ids.
const IDS = {
  patientAR: 'e9000000-a000-0001-0001-000000000001',
  patientBR: 'e9000000-a000-0001-0002-000000000001',
  jobAR: 'e9000000-a000-0002-0001-000000000001',
  jobBR: 'e9000000-a000-0002-0002-000000000001',
  groupArOnly: 'e9000000-a000-0003-0001-000000000001',
  groupMultiDocumented: 'e9000000-a000-0003-0002-000000000001',
  groupMultiUndocumented: 'e9000000-a000-0003-0003-000000000001',
  scopeArOnly: 'e9000000-a000-0004-0001-000000000001',
  scopeMultiDocAr: 'e9000000-a000-0004-0002-000000000001',
  scopeMultiDocBr: 'e9000000-a000-0004-0003-000000000001',
  scopeMultiUndocAr: 'e9000000-a000-0004-0004-000000000001',
  scopeMultiUndocBr: 'e9000000-a000-0004-0005-000000000001',
};

const STAFF_AR_ONLY = 'pr9-e2e-staff-ar-only';
const STAFF_MULTI_DOCUMENTED = 'pr9-e2e-staff-multi-doc';
const STAFF_MULTI_UNDOCUMENTED = 'pr9-e2e-staff-multi-undoc';
const STAFF_NO_GROUP = 'pr9-e2e-staff-no-group';

describe('filtro de país na Gestão à Vista — banco real (L9-2, L9-3, L9-5)', () => {
  let pool: Pool;

  async function cleanup(p: Pool): Promise<void> {
    await p.query(`DELETE FROM group_country_scopes WHERE id = ANY($1)`, [
      [IDS.scopeArOnly, IDS.scopeMultiDocAr, IDS.scopeMultiDocBr, IDS.scopeMultiUndocAr, IDS.scopeMultiUndocBr],
    ]);
    await p.query(`DELETE FROM user_groups WHERE user_id = ANY($1)`, [
      [STAFF_AR_ONLY, STAFF_MULTI_DOCUMENTED, STAFF_MULTI_UNDOCUMENTED, STAFF_NO_GROUP],
    ]);
    await p.query(`DELETE FROM permission_groups WHERE id = ANY($1)`, [
      [IDS.groupArOnly, IDS.groupMultiDocumented, IDS.groupMultiUndocumented],
    ]);
    await p.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [
      [STAFF_AR_ONLY, STAFF_MULTI_DOCUMENTED, STAFF_MULTI_UNDOCUMENTED, STAFF_NO_GROUP],
    ]);
    await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jobAR, IDS.jobBR]]);
    await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status) VALUES
         ($1, 'pr9-e2e-task-ar', 'Paciente', 'AR', 'AR', 'ACTIVE'),
         ($2, 'pr9-e2e-task-br', 'Paciente', 'BR', 'BR', 'ACTIVE')`,
      [IDS.patientAR, IDS.patientBR],
    );
    await pool.query(
      `INSERT INTO job_postings (id, title, status, is_draft, country, patient_id) VALUES
         ($1, 'Caso pr9 AR', 'SEARCHING', false, 'AR', $3),
         ($2, 'Caso pr9 BR', 'SEARCHING', false, 'BR', $4)`,
      [IDS.jobAR, IDS.jobBR, IDS.patientAR, IDS.patientBR],
    );

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, tenant_id) VALUES
         ($1, 'pr9-e2e-ar@e2e.local', 'admin', $5),
         ($2, 'pr9-e2e-multi-doc@e2e.local', 'admin', $5),
         ($3, 'pr9-e2e-multi-undoc@e2e.local', 'admin', $5),
         ($4, 'pr9-e2e-no-group@e2e.local', 'admin', $5)`,
      [STAFF_AR_ONLY, STAFF_MULTI_DOCUMENTED, STAFF_MULTI_UNDOCUMENTED, STAFF_NO_GROUP, TENANT],
    );

    await pool.query(
      `INSERT INTO permission_groups (id, tenant_id, name) VALUES
         ($1, $4, 'PR9 e2e AR only'),
         ($2, $4, 'PR9 e2e Multi documentado'),
         ($3, $4, 'PR9 e2e Multi SEM documentação')`,
      [IDS.groupArOnly, IDS.groupMultiDocumented, IDS.groupMultiUndocumented, TENANT],
    );

    await pool.query(
      `INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES
         ($1, $4, $5),
         ($2, $6, $5),
         ($3, $7, $5)`,
      [
        STAFF_AR_ONLY, STAFF_MULTI_DOCUMENTED, STAFF_MULTI_UNDOCUMENTED,
        IDS.groupArOnly, TENANT, IDS.groupMultiDocumented, IDS.groupMultiUndocumented,
      ],
    );

    // Grupo AR-only: 1 scope, AR, com motivo (irrelevante para país único).
    await pool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES
         ($1, $2, 'AR', 'pr9-e2e-admin', 'e2e: grupo só AR')`,
      [IDS.scopeArOnly, IDS.groupArOnly],
    );

    // Grupo multi-país DOCUMENTADO: AR e BR, os dois com motivo (L9-5, caminho feliz).
    await pool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES
         ($1, $3, 'AR', 'pr9-e2e-admin', 'e2e: multi-país documentado — AR'),
         ($2, $3, 'BR', 'pr9-e2e-admin', 'e2e: multi-país documentado — BR')`,
      [IDS.scopeMultiDocAr, IDS.scopeMultiDocBr, IDS.groupMultiDocumented],
    );

    // Grupo multi-país com `granted_by` nos DOIS mas `reason` só em um: AR
    // com motivo, BR SEM motivo (NULL). Desde a migration 412 (decisão de
    // 20/09) isso NÃO reprova mais — prova a metade da regra que MUDOU
    // (`reason` deixou de ser exigido). A metade que NÃO mudou (`granted_by`
    // sempre exigido) não tem fixture aqui: a coluna é NOT NULL desde a
    // migration 268 e nunca foi relaxada, então "grant com granted_by NULL"
    // é um estado IRREPRODUZÍVEL num INSERT de banco real (23502 antes de
    // chegar à app) — essa metade é coberta no teste unitário mockado
    // (`resolveCountryScope.test.ts`, caso "granted_by NULL … continua
    // indocumentado, 403").
    await pool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES
         ($1, $3, 'AR', 'pr9-e2e-admin', 'e2e: AR documentado'),
         ($2, $3, 'BR', 'pr9-e2e-admin', NULL)`,
      [IDS.scopeMultiUndocAr, IDS.scopeMultiUndocBr, IDS.groupMultiUndocumented],
    );
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  async function directCount(countries: string[]): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM patients
        WHERE deleted_at IS NULL AND status = 'ACTIVE' AND country = ANY($1)`,
      [countries],
    );
    return Number(rows[0].n);
  }

  describe('L9-2 — resolução no servidor: pedido ∩ países do ator; ALL = união do ator', () => {
    it('ator {AR} pedindo BR → 403 COUNTRY_SCOPE_REQUIRED', async () => {
      await expect(resolveCountryScope(pool, STAFF_AR_ONLY, 'BR')).rejects.toMatchObject({
        status: 403,
        code: 'COUNTRY_SCOPE_REQUIRED',
      });
    });

    it('ator {AR} pedindo ALL → scope = [AR], e a contagem do dashboard bate com o SQL direto só de AR', async () => {
      const scope = await resolveCountryScope(pool, STAFF_AR_ONLY, 'ALL');
      expect(scope).toEqual({ countries: ['AR'], requested: 'ALL' });

      const data = await new GetManagementDashboardUseCase(pool).execute({
        countries: scope.countries,
        requested: scope.requested,
      });
      const expected = await directCount(['AR']);
      expect(data.bigNumbers.pacientesActivos).toBeGreaterThanOrEqual(expected);
      // Como o banco é exclusivo desta suíte (worktree 018-pr9), a igualdade vale:
      expect(data.bigNumbers.pacientesActivos).toBe(expected);
      // E precisa ser MENOR que o total dos dois países — prova que BR ficou de fora.
      const totalAmbos = await directCount(['AR', 'BR']);
      expect(data.bigNumbers.pacientesActivos).toBeLessThan(totalAmbos);
    });

    it('ator SEM nenhum grupo → 403, mesmo pedindo AR', async () => {
      await expect(resolveCountryScope(pool, STAFF_NO_GROUP, 'AR')).rejects.toMatchObject({
        status: 403,
        code: 'COUNTRY_SCOPE_REQUIRED',
      });
    });
  });

  describe('L9-3 — nunca depende de COUNTRY_RLS_ENABLED nem PERMISSION_ENGINE_ENABLED', () => {
    const ORIGINAL_RLS = process.env.COUNTRY_RLS_ENABLED;
    const ORIGINAL_ENGINE = process.env.PERMISSION_ENGINE_ENABLED;

    afterEach(() => {
      if (ORIGINAL_RLS === undefined) delete process.env.COUNTRY_RLS_ENABLED;
      else process.env.COUNTRY_RLS_ENABLED = ORIGINAL_RLS;
      if (ORIGINAL_ENGINE === undefined) delete process.env.PERMISSION_ENGINE_ENABLED;
      else process.env.PERMISSION_ENGINE_ENABLED = ORIGINAL_ENGINE;
    });

    it('ator {AR} pedindo BR com as flags de PRD desligadas → 403 do mesmo jeito (nunca depende delas)', async () => {
      process.env.COUNTRY_RLS_ENABLED = 'false';
      process.env.PERMISSION_ENGINE_ENABLED = 'false';

      await expect(resolveCountryScope(pool, STAFF_AR_ONLY, 'BR')).rejects.toMatchObject({
        status: 403,
        code: 'COUNTRY_SCOPE_REQUIRED',
      });

      const scope = await resolveCountryScope(pool, STAFF_AR_ONLY, 'ALL');
      const data = await new GetManagementDashboardUseCase(pool).execute({ countries: scope.countries });
      expect(data.bigNumbers.pacientesActivos).toBe(await directCount(['AR']));
    });
  });

  describe('L9-5 — consolidado multi-país só com escopo concedido E granted_by documentado (D113 + migration 412)', () => {
    it('ator {AR,BR} com os DOIS grants documentados → ALL soma os dois países', async () => {
      const scope = await resolveCountryScope(pool, STAFF_MULTI_DOCUMENTED, 'ALL');
      expect(scope.countries.sort()).toEqual(['AR', 'BR']);

      const data = await new GetManagementDashboardUseCase(pool).execute({ countries: scope.countries });
      expect(data.bigNumbers.pacientesActivos).toBe(await directCount(['AR', 'BR']));
    });

    it('ator {AR,BR} com 1 grant SEM reason (mesmo que o outro tenha granted_by) → ALL soma os dois países, SEM 403 (migration 412: reason não é mais exigido, decisão de 20/09)', async () => {
      const scope = await resolveCountryScope(pool, STAFF_MULTI_UNDOCUMENTED, 'ALL');
      expect(scope.countries.sort()).toEqual(['AR', 'BR']);

      const data = await new GetManagementDashboardUseCase(pool).execute({ countries: scope.countries });
      expect(data.bigNumbers.pacientesActivos).toBe(await directCount(['AR', 'BR']));
    });

    it('mas o MESMO ator com 1 grant sem reason continua podendo pedir um país específico do seu escopo (AR)', async () => {
      const scope = await resolveCountryScope(pool, STAFF_MULTI_UNDOCUMENTED, 'AR');
      expect(scope).toEqual({ countries: ['AR'], requested: 'AR' });
    });
  });

  it('erro tipado: toda rejeição é CountryScopeError (o controller decide o HTTP status a partir dele)', async () => {
    try {
      await resolveCountryScope(pool, STAFF_AR_ONLY, 'BR');
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(CountryScopeError);
    }
  });
});
