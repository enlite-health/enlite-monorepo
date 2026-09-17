/**
 * Conferência de horas do Ana Care — fase 1 (spec `anacare-conferencia-de-horas`), com o ENGINE DE
 * PERMISSÃO LIGADO (família `admin.patients`), HTTP real, banco real, adapter FALSO (massa
 * sintética, `ANACARE_HOURS_SOURCE=fake`).
 *
 * O que se prova:
 *   1. fail-closed: SEM a env, 503 `ANACARE_SOURCE_NOT_CONFIGURED` mesmo autenticado e com célula;
 *   2. célula: sem `anacare_hours:read` → 403; com ela → 200 com turnos sintéticos;
 *   3. só leitura não autoriza ação: `anacare_hours:read` sem `:validate` → 403 em validar/contestar;
 *   4. validar um turno grava em `shift_hours_validation`, some da UI como pendente e some 204;
 *   5. validar de novo o MESMO turno → 409 `JA_VALIDADO` — o trigger de imutabilidade da migration
 *      437 nunca chega a rodar porque o repositório recusa antes;
 *   6. contestar com motivo fora da lista fechada → 400 (zod), nunca chega ao banco;
 *   7. contestar com sucesso grava `note_encrypted` cifrado — nunca o texto claro na coluna.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('spec anacare-conferencia-de-horas F1 — API sob engine de permissão (HTTP real, banco real, adapter falso)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = { leitura: 'ach-f1-leitura', completo: 'ach-f1-completo', semGrupo: 'ach-f1-sem-grupo' };
  const GRUPOS = { leitura: 'ACH F1 Leitura', completo: 'ACH F1 Completo' };
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['anacare_hours', 'read'],
    ['anacare_hours', 'validate'],
  ];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };
  const unsetEnv = (k: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    delete process.env[k];
  };

  async function chamar(metodo: string, caminho: string, uid: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function limpar(): Promise<void> {
    // `shift_hours_validation.validated_by` é FK para `users` (migration 437) — apagar ANTES dos
    // usuários, senão `limparIamFixtures` (que apaga `users`) esbarra na FK.
    await pool.query(`DELETE FROM shift_hours_validation WHERE source = 'anacare' AND source_shift_id LIKE 'FAKE-%'`);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'ach-f1-leitura@e2e.local', 'Leitora Sintética QA', 'admin', 'ACTIVE', true, $3),
         ($2, 'ach-f1-completo@e2e.local', 'Validador Sintético QA', 'admin', 'ACTIVE', true, $3)`,
      [U.leitura, U.completo, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    }
    await grupoComCelulas(pool, { nome: GRUPOS.leitura, uid: U.leitura, celulas: [['anacare_hours', 'read']] });
    await grupoComCelulas(pool, {
      nome: GRUPOS.completo,
      uid: U.completo,
      celulas: [['anacare_hours', 'read'], ['anacare_hours', 'validate']],
    });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const anacareHours = await import('@modules/anacare-hours');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', anacareHours.createAnaCareHoursRoutes(new anacareHours.AnaCareHoursController(), auth, permissions)),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('fail-closed — sem ANACARE_HOURS_SOURCE', () => {
    it('503 ANACARE_SOURCE_NOT_CONFIGURED mesmo com célula de leitura — produção nunca serve dado falso por omissão', async () => {
      unsetEnv('ANACARE_HOURS_SOURCE');
      const res = await chamar('GET', '/api/admin/anacare-hours/months/2026-09', U.completo);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ANACARE_SOURCE_NOT_CONFIGURED');
    });
  });

  describe('com ANACARE_HOURS_SOURCE=fake', () => {
    beforeAll(() => setEnv('ANACARE_HOURS_SOURCE', 'fake'));

    it('sem célula nenhuma → 403 do engine', async () => {
      const res = await chamar('GET', '/api/admin/anacare-hours/months/2026-09', U.semGrupo);
      expect(res.status).toBe(403);
    });

    it('com anacare_hours:read → 200 com os 10 pacientes sintéticos e 100 turnos no total (LISTA, contrato F6.2 agregado)', async () => {
      const res = await chamar('GET', '/api/admin/anacare-hours/months/2026-09', U.leitura);
      expect(res.status).toBe(200);
      const patients: any[] = res.body.data.patients;
      expect(patients).toHaveLength(10);

      // F6.2 (D361 Adendo 17/09): o total de turnos vem PRONTO em `shiftsCount` — a LISTA não
      // manda mais nenhum turno individual, então não há mais `providers[].shifts` para somar.
      const totalShifts = patients.reduce((acc: number, p: any) => acc + p.shiftsCount, 0);
      expect(totalShifts).toBe(100);

      // Prova ponta a ponta contra banco real de que o contrato novo se cumpre — nenhum teste
      // unitário alcança isto porque o fixture aqui é a massa sintética real (10 pacientes/100 turnos).
      for (const p of patients) {
        for (const pr of p.providers) {
          expect(pr).not.toHaveProperty('shifts');
        }
        expect(p.providersCount).toBe(p.providers.length);
        expect(typeof p.validated).toBe('number');
        expect(typeof p.contested).toBe('number');
        expect(typeof p.hoursActualSum).toBe('number');
        expect(typeof p.hoursScheduledSumMissingActual).toBe('number');
      }
    });

    it('só anacare_hours:read (sem :validate) → 403 ao tentar validar', async () => {
      const res = await chamar('POST', '/api/admin/anacare-hours/shifts/FAKE-2026-09-0-0-0/validate', U.leitura);
      expect(res.status).toBe(403);
    });

    it('validar um turno pendente → 204, grava shift_hours_validation com status validado', async () => {
      const res = await chamar('POST', '/api/admin/anacare-hours/shifts/FAKE-2026-09-1-0-0/validate', U.completo);
      expect(res.status).toBe(204);

      const row = await pool.query(
        `SELECT status, validated_by, approved_hours FROM shift_hours_validation WHERE source = 'anacare' AND source_shift_id = 'FAKE-2026-09-1-0-0'`,
      );
      expect(row.rows[0]).toMatchObject({ status: 'validado', validated_by: U.completo });
    });

    it('validar o MESMO turno de novo → 409 JA_VALIDADO (o repositório recusa antes do trigger)', async () => {
      const res = await chamar('POST', '/api/admin/anacare-hours/shifts/FAKE-2026-09-1-0-0/validate', U.completo);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('JA_VALIDADO');
    });

    it('contestar com motivo fora da lista fechada → 400, nada é gravado', async () => {
      const res = await chamar('POST', '/api/admin/anacare-hours/shifts/FAKE-2026-09-2-0-0/contest', U.completo, {
        reason: 'motivo_que_nao_existe',
      });
      expect(res.status).toBe(400);
      const row = await pool.query(`SELECT 1 FROM shift_hours_validation WHERE source_shift_id = 'FAKE-2026-09-2-0-0'`);
      expect(row.rowCount).toBe(0);
    });

    it('contestar com motivo válido e nota → 204, note_encrypted NUNCA é o texto claro', async () => {
      const notaClara = 'Horario cargado a mano, no coincide con lo real';
      const res = await chamar('POST', '/api/admin/anacare-hours/shifts/FAKE-2026-09-2-0-0/contest', U.completo, {
        reason: 'horario_distinto',
        note: notaClara,
      });
      expect(res.status).toBe(204);

      const row = await pool.query(
        `SELECT status, reason, note_encrypted FROM shift_hours_validation WHERE source_shift_id = 'FAKE-2026-09-2-0-0'`,
      );
      expect(row.rows[0].status).toBe('contestado');
      expect(row.rows[0].reason).toBe('horario_distinto');
      expect(row.rows[0].note_encrypted).not.toBeNull();
      expect(row.rows[0].note_encrypted).not.toBe(notaClara);
      expect(String(row.rows[0].note_encrypted)).not.toContain('Horario cargado');
    });

    it('turno contestado PODE ser validado depois (não reabre, só congela)', async () => {
      const res = await chamar('POST', '/api/admin/anacare-hours/shifts/FAKE-2026-09-2-0-0/validate', U.completo);
      expect(res.status).toBe(204);
      const row = await pool.query(`SELECT status FROM shift_hours_validation WHERE source_shift_id = 'FAKE-2026-09-2-0-0'`);
      expect(row.rows[0].status).toBe('validado');
    });

    it('turno inexistente na fonte → 404 TURNO_NAO_ENCONTRADO', async () => {
      const res = await chamar('POST', '/api/admin/anacare-hours/shifts/FAKE-nao-existe/validate', U.completo);
      expect(res.status).toBe(404);
    });
  });
});
