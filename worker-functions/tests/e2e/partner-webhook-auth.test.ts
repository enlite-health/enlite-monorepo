/**
 * partner-webhook-auth.test.ts
 *
 * Testa o sistema de autenticação de parceiros via X-Partner-Key
 * e a autorização por path (webhook_partners.allowed_paths).
 *
 * Os testes rodam com USE_MOCK_AUTH=true (padrão em E2E),
 * então a validação da Google API é bypassada.
 * O foco é testar:
 *   - Roteamento correto (prod vs test endpoints)
 *   - Coluna environment ('production' | 'test') na persistência
 *   - Integração do middleware com o controller
 */

import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { postTalentumAndDrain, TALENTUM_WEBHOOK_TEST } from './helpers/talentumWebhook';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// Payload mínimo válido para o webhook Talentum (formato v2: action/subtype/data)
const VALID_PAYLOAD = {
  action: 'PRESCREENING_RESPONSE',
  subtype: 'INITIATED',
  data: {
    prescreening: {
      id: 'tp-auth-test-001',
      name: 'Caso Auth Test',
    },
    profile: {
      id: 'prof-auth-test-001',
      firstName: 'Auth',
      lastName: 'Test',
      email: 'auth-test@example.com',
      phoneNumber: '+5491100000000',
      cuil: '20-99999999-0',
      registerQuestions: [],
    },
    response: {
      id: 'resp-auth-test-001',
      state: [],
    },
  },
};

describe('Partner Webhook Auth', () => {
  let pool: Pool;
  const api = createApiClient();

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // Limpar dados de teste anteriores
    await pool.query(`DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (
      SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'tp-auth-test-%'
    )`).catch(() => {});
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'tp-auth-test-%'`).catch(() => {});
  });

  afterAll(async () => {
    // Cleanup
    await pool.query(`DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (
      SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'tp-auth-test-%'
    )`).catch(() => {});
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'tp-auth-test-%'`).catch(() => {});
    if (pool) await pool.end();
  });

  // ─────────────────────────────────────────────────────────────────
  // Parte 1 — Endpoint de produção (/api/webhooks/talentum/prescreening)
  // ─────────────────────────────────────────────────────────────────

  describe('POST /api/webhooks/talentum/prescreening (produção)', () => {
    it('deve retornar 400 com payload inválido', async () => {
      const res = await api.post('/api/webhooks/talentum/prescreening', {
        invalid: 'payload',
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Invalid payload');
    });

    it('deve retornar 200 com payload válido e salvar environment=production', async () => {
      // Ack assíncrono (spec 095): o environment da linha em talentum_prescreenings só existe depois do drain da inbox.
      const res = await postTalentumAndDrain(api, VALID_PAYLOAD);
      expect(res.ack.status).toBe(200);
      expect(res.drain).toMatchObject({ selected: 1, processed: 1, failed: 0 });

      // Verificar que environment=production foi salvo
      const dbResult = await pool.query(
        `SELECT environment FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`,
        ['tp-auth-test-001'],
      );
      expect(dbResult.rows[0]?.environment).toBe('production');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Parte 2 — Endpoint de teste (/api/webhooks-test/talentum/prescreening)
  // ─────────────────────────────────────────────────────────────────

  describe('POST /api/webhooks-test/talentum/prescreening (teste)', () => {
    it('deve retornar 200 e salvar environment=test', async () => {
      // Constrói payload v2 correto com id único dentro de data (não no top-level)
      const testPayload = {
        action: 'PRESCREENING_RESPONSE',
        subtype: 'INITIATED',
        data: {
          prescreening: {
            id: 'tp-auth-test-002',
            name: 'Caso Auth Test 2',
          },
          profile: {
            id: 'prof-auth-test-002',
            firstName: 'Auth',
            lastName: 'Test2',
            email: 'auth-test-2@example.com',
            phoneNumber: '+5491100000001',
            cuil: '20-99999999-1',
            registerQuestions: [],
          },
          response: {
            id: 'resp-auth-test-002',
            state: [],
          },
        },
      };

      const res = await postTalentumAndDrain(api, testPayload, TALENTUM_WEBHOOK_TEST);
      expect(res.ack.status).toBe(200);
      expect(res.drain).toMatchObject({ selected: 1, processed: 1, failed: 0 });

      // Verificar que environment=test foi salvo
      const dbResult = await pool.query(
        `SELECT environment FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`,
        ['tp-auth-test-002'],
      );
      expect(dbResult.rows[0]?.environment).toBe('test');
    });

    it('deve retornar 400 com payload inválido no endpoint de teste', async () => {
      const res = await api.post('/api/webhooks-test/talentum/prescreening', {});
      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Parte 3 — Tabela webhook_partners (schema)
  // ─────────────────────────────────────────────────────────────────

  describe('webhook_partners table', () => {
    it('deve existir com as colunas esperadas', async () => {
      const result = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'webhook_partners'
        ORDER BY ordinal_position
      `);

      const columns = result.rows.map(r => r.column_name);
      expect(columns).toEqual(expect.arrayContaining([
        'id', 'name', 'display_name', 'allowed_paths',
        'is_active', 'metadata', 'created_at', 'updated_at',
      ]));
    });

    it('deve ter index único em display_name', async () => {
      const result = await pool.query(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'webhook_partners'
          AND indexname = 'idx_webhook_partners_display_name'
      `);
      expect(result.rows.length).toBe(1);
    });

    it('seed do Talentum deve existir', async () => {
      const result = await pool.query(
        `SELECT name, display_name, allowed_paths, is_active
         FROM webhook_partners WHERE name = 'talentum'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].display_name).toBe('API-Key-Talentum');
      expect(result.rows[0].allowed_paths).toEqual(['talentum/*']);
      expect(result.rows[0].is_active).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Parte 4 — Coluna environment em talentum_prescreenings
  // ─────────────────────────────────────────────────────────────────

  describe('talentum_prescreenings.environment column', () => {
    it('deve existir e ter default production', async () => {
      const result = await pool.query(`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_name = 'talentum_prescreenings'
          AND column_name = 'environment'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].column_default).toContain('production');
    });

    it('deve rejeitar valores fora de production/test', async () => {
      await expect(
        pool.query(`
          INSERT INTO talentum_prescreenings (
            talentum_prescreening_id, talentum_profile_id,
            job_case_name, status, environment
          ) VALUES ('tp-check-001', 'pp-check-001', 'test', 'INITIATED', 'staging')
        `),
      ).rejects.toThrow();
    });
  });
});
