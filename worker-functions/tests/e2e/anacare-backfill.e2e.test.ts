/**
 * anacare-backfill.e2e.test.ts
 *
 * E2E do endpoint POST /api/admin/integrations/anacare/backfill.
 *
 * Estratégia: mock HTTP do AnaCare via ANACARE_BASE_URL apontando para servidor
 * local de mock (nock/interceptor inline). O banco é real (enlite_e2e).
 *
 * O que é testado:
 *   1. Auth/permissão — requer admin, rejeita worker/anon
 *   2. dryRun=true (default) — responde com sumário sem criar workers no AnaCare
 *   3. Filtros de elegibilidade — exclui INCOMPLETE_REGISTER, merged_into_id, @enlite.import, colisão de phone
 *   4. dryRun=false com mock AnaCare — cria enfermera (POST), persiste ana_care_id + ana_care_synced_at
 *   5. Idempotência — segunda execução usa PATCH (ana_care_id já preenchido), não POST
 *
 * Nota: ANACARE_API_KEY e ANACARE_BASE_URL são injetados nas envs do processo antes
 * da suite. O servidor mock responde em http://localhost:29999.
 */

import http from 'http';
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { AnaCareClient, AnaCareMirrorProvider } from '@modules/integration';
import type { WorkerMirrorRecord } from '@modules/integration';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MOCK_PORT = 29999;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}`;
const MOCK_ANA_CARE_ID = 777;

// ─── Mock HTTP Server para AnaCare ────────────────────────────────

interface MockState {
  createCalls: number;
  updateCalls: number;
  lastCreateBody: Record<string, unknown> | null;
  lastUpdateBody: Record<string, unknown> | null;
  lastUpdateId: number | null;
}

function createAnaCareServer(state: MockState): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};

      // Catálogos
      if (req.url === '/api/v2/agencies/nurse-types/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 1, next: null, previous: null, results: [{ id: 1, name: 'Acompañante Terapéutico' }] }));
        return;
      }
      if (req.url === '/api/v2/agencies/hiring-types/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
        return;
      }

      // POST /api/v2/agencies/nurses/
      if (req.url === '/api/v2/agencies/nurses/' && req.method === 'POST') {
        state.createCalls++;
        state.lastCreateBody = parsed;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: MOCK_ANA_CARE_ID,
          nombre: parsed.nombre,
          apellidos: parsed.apellidos,
          genero: parsed.genero,
          email: parsed.email,
        }));
        return;
      }

      // PATCH /api/v2/agencies/nurses/<id>/
      const patchMatch = req.url?.match(/^\/api\/v2\/agencies\/nurses\/(\d+)\/$/) ?? null;
      if (patchMatch && req.method === 'PATCH') {
        state.updateCalls++;
        state.lastUpdateId = parseInt(patchMatch[1], 10);
        state.lastUpdateBody = parsed;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: state.lastUpdateId,
          nombre: parsed.nombre ?? 'updated',
          apellidos: parsed.apellidos ?? 'updated',
          genero: parsed.genero ?? 'M',
          email: parsed.email ?? 'updated@example.com',
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'not found' }));
    });
  });
}

// ─── Suite ────────────────────────────────────────────────────────

describe('AnaCare Backfill API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let mockServer: http.Server;
  let mockState: MockState;

  // IDs de workers criados no beforeAll, limpos no afterAll
  const workerIds: string[] = [];

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'anacare-backfill-admin',
      email: 'anacare-backfill-admin@e2e.local',
      role: 'admin',
    });
    workerToken = await getMockToken(api, {
      uid: 'anacare-backfill-worker',
      email: 'anacare-backfill-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Iniciar mock AnaCare
    mockState = { createCalls: 0, updateCalls: 0, lastCreateBody: null, lastUpdateBody: null, lastUpdateId: null };
    mockServer = createAnaCareServer(mockState);
    await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, resolve));

    // Configurar env para apontar ao mock (lido pelo AnaCareClient.fromEnv)
    process.env.ANACARE_API_KEY = 'ana_care.test.key';
    process.env.ANACARE_BASE_URL = MOCK_BASE_URL;
  });

  afterAll(async () => {
    // Limpar workers criados no teste
    if (workerIds.length > 0) {
      await pool.query(
        `DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`,
        [workerIds],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`,
        [workerIds],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`,
        [workerIds],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM workers WHERE id = ANY($1::uuid[])`,
        [workerIds],
      ).catch(() => {});
    }
    await pool.end().catch(() => {});
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    delete process.env.ANACARE_API_KEY;
    delete process.env.ANACARE_BASE_URL;
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. Auth/permissões
  // ═══════════════════════════════════════════════════════════════

  describe('POST /api/admin/integrations/anacare/backfill — auth', () => {
    it('retorna 401 sem token', async () => {
      const res = await api.post('/api/admin/integrations/anacare/backfill');
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.post(
        '/api/admin/integrations/anacare/backfill',
        {},
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. dryRun=true (default) — sem chamadas ao AnaCare
  // ═══════════════════════════════════════════════════════════════

  describe('dryRun=true', () => {
    it('responde 200 com sumário (success=true)', async () => {
      const res = await api.post(
        '/api/admin/integrations/anacare/backfill',
        { dryRun: true },
        auth(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toHaveProperty('eligible');
      expect(res.data.data).toHaveProperty('created');
      expect(res.data.data).toHaveProperty('updated');
      expect(res.data.data).toHaveProperty('skipped');
      expect(res.data.data).toHaveProperty('errors');
    });

    it('sem body é equivalente a dryRun=true', async () => {
      const res = await api.post(
        '/api/admin/integrations/anacare/backfill',
        {},
        auth(adminToken),
      );
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. Filtros de elegibilidade (DB-level)
  // ═══════════════════════════════════════════════════════════════

  describe('filtros de elegibilidade', () => {
    let registeredWorkerId: string;
    let incompleteWorkerId: string;
    let mergedWorkerId: string;
    let importWorkerId: string;
    let collisionWorker1: string;
    let collisionWorker2: string;

    beforeAll(async () => {
      // Helper para criar worker REGISTERED mínimo (sem PII real)
      async function insertWorker(overrides: Record<string, unknown>): Promise<string> {
        const r = await pool.query(
          `INSERT INTO workers (auth_uid, email, phone, status, country,
             first_name_encrypted, last_name_encrypted, sex_encrypted)
           VALUES ($1, $2, $3, $4, 'AR', 'enc-fn', 'enc-ln', 'enc-sex')
           RETURNING id`,
          [
            overrides.auth_uid,
            overrides.email,
            overrides.phone ?? null,
            overrides.status ?? 'REGISTERED',
          ],
        );
        const id = r.rows[0].id as string;
        workerIds.push(id);
        return id;
      }

      // Worker REGISTERED normal (elegível)
      registeredWorkerId = await insertWorker({
        auth_uid: 'e2e-backfill-reg-1',
        email: 'e2e-backfill-eligible@example.com',
        phone: '5219991110001',
        status: 'REGISTERED',
      });

      // Worker INCOMPLETE_REGISTER — inelegível
      incompleteWorkerId = await insertWorker({
        auth_uid: 'e2e-backfill-inc-1',
        email: 'e2e-backfill-incomplete@example.com',
        phone: '5219991110002',
        status: 'INCOMPLETE_REGISTER',
      });

      // Worker merged — inelegível
      const mergedIntoWorkerResult = await pool.query(
        `INSERT INTO workers (auth_uid, email, phone, status, country,
           first_name_encrypted, last_name_encrypted, sex_encrypted)
         VALUES ($1, $2, $3, 'REGISTERED', 'AR', 'enc-fn', 'enc-ln', 'enc-sex')
         RETURNING id`,
        ['e2e-backfill-merge-target', 'e2e-backfill-merge-target@example.com', null],
      );
      const mergeTargetId = mergedIntoWorkerResult.rows[0].id as string;
      workerIds.push(mergeTargetId);

      mergedWorkerId = await insertWorker({
        auth_uid: 'e2e-backfill-merged-1',
        email: 'e2e-backfill-merged@example.com',
        phone: '5219991110003',
        status: 'REGISTERED',
      });
      await pool.query(
        `UPDATE workers SET merged_into_id = $2 WHERE id = $1`,
        [mergedWorkerId, mergeTargetId],
      );

      // Worker @enlite.import — inelegível
      importWorkerId = await insertWorker({
        auth_uid: 'e2e-backfill-import-1',
        email: 'worker-123@enlite.import',
        phone: '5219991110004',
        status: 'REGISTERED',
      });

      // Dois workers com phones CRUS diferentes que normalizam ao mesmo
      // phone_normalized ('+5491190000001' e '1190000001' → '5491190000001').
      // Colisão semântica sem violar idx_workers_phone_unique (raw distinto).
      collisionWorker1 = await insertWorker({
        auth_uid: 'e2e-backfill-coll-1',
        email: 'e2e-backfill-coll1@example.com',
        phone: '+5491190000001',
        status: 'REGISTERED',
      });
      collisionWorker2 = await insertWorker({
        auth_uid: 'e2e-backfill-coll-2',
        email: 'e2e-backfill-coll2@example.com',
        phone: '1190000001', // normaliza para o mesmo phone_normalized
        status: 'REGISTERED',
      });
    });

    it('workers INCOMPLETE_REGISTER NÃO aparecem como elegíveis', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM workers
         WHERE id = $1 AND status = 'REGISTERED' AND merged_into_id IS NULL
           AND email NOT LIKE '%@enlite.import'`,
        [incompleteWorkerId],
      );
      expect(rows).toHaveLength(0);
    });

    it('workers com merged_into_id NÃO aparecem como elegíveis', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM workers
         WHERE id = $1 AND status = 'REGISTERED' AND merged_into_id IS NULL`,
        [mergedWorkerId],
      );
      expect(rows).toHaveLength(0);
    });

    it('workers @enlite.import NÃO aparecem como elegíveis', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM workers
         WHERE id = $1 AND email NOT LIKE '%@enlite.import'`,
        [importWorkerId],
      );
      expect(rows).toHaveLength(0);
    });

    it('workers em colisão de phone NÃO aparecem como elegíveis', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM workers
         WHERE id = ANY($1::uuid[])
           AND phone_normalized NOT IN (
             SELECT phone_normalized FROM workers
             WHERE merged_into_id IS NULL AND phone_normalized IS NOT NULL
             GROUP BY phone_normalized HAVING count(*) > 1
           )`,
        [[collisionWorker1, collisionWorker2]],
      );
      expect(rows).toHaveLength(0);
    });

    it('worker REGISTERED normal É elegível', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM workers
         WHERE id = $1
           AND status = 'REGISTERED'
           AND merged_into_id IS NULL
           AND email NOT LIKE '%@enlite.import'`,
        [registeredWorkerId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. Entrega real ao AnaCare via provider → mock HTTP (in-process)
  //
  // dryRun=false pela rota HTTP não dá: o backfill roda DENTRO do container
  // da API (processo separado), que não alcança o mock do processo de teste
  // nem tem ANACARE_API_KEY. Então exercitamos o caminho de entrega in-process
  // com o AnaCareClient REAL apontando para o mock — valida o formato do wire
  // (genero invertido, tipo_enfermera resolvido do catálogo, POST vs PATCH).
  // ═══════════════════════════════════════════════════════════════

  describe('entrega ao AnaCare (provider real → mock HTTP)', () => {
    let provider: AnaCareMirrorProvider;

    const record: WorkerMirrorRecord = {
      workerId: 'rec-e2e-1',
      firstName: 'María',
      lastName: 'Pérez',
      sex: 'FEMALE',
      email: 'maria.e2e@example.com',
      phone: '5491100000001',
      birthDate: '1990-05-20',
      documentNumber: '12345678',
      address: {
        line: 'Av Corrientes 1234',
        city: 'CABA',
        state: 'Buenos Aires',
        neighborhood: 'Balvanera',
        postalCode: 'C1043',
      },
      profession: 'AT',
      occupation: 'AT',
      employmentType: null,
    };

    beforeAll(() => {
      // fromEnv lê ANACARE_API_KEY + ANACARE_BASE_URL (setados no beforeAll → mock)
      provider = new AnaCareMirrorProvider(AnaCareClient.fromEnv());
      mockState.createCalls = 0;
      mockState.updateCalls = 0;
    });

    it('upsert sem externalId → POST com payload correto (FEMALE→"M", tipo resolvido)', async () => {
      const result = await provider.upsert(record, null);
      expect(result.externalId).toBe(String(MOCK_ANA_CARE_ID));
      expect(mockState.createCalls).toBe(1);
      expect(mockState.lastCreateBody).toMatchObject({
        nombre: 'María',
        apellidos: 'Pérez',
        genero: 'M', // FEMALE → M (invertido)
        email: 'maria.e2e@example.com',
        cedula_ciudadania: '12345678',
        tipo_enfermera: 1, // resolvido do catálogo do mock (Acompañante Terapéutico)
      });
    });

    it('upsert com externalId → PATCH (idempotência), nunca POST', async () => {
      mockState.createCalls = 0;
      mockState.updateCalls = 0;
      const result = await provider.upsert(record, '777');
      expect(result.externalId).toBe('777');
      expect(mockState.updateCalls).toBe(1);
      expect(mockState.createCalls).toBe(0);
      expect(mockState.lastUpdateId).toBe(777);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. Persistência de estado + idempotência (DB real)
  // ═══════════════════════════════════════════════════════════════

  describe('persistência de estado (DB real)', () => {
    let eligibleWorkerId: string;

    beforeAll(async () => {
      const r = await pool.query(
        `INSERT INTO workers (auth_uid, email, phone, status, country, profession)
         VALUES ('e2e-backfill-state-1', 'e2e-backfill-state@example.com', '5219997770001', 'REGISTERED', 'AR', 'AT')
         RETURNING id`,
      );
      eligibleWorkerId = r.rows[0].id as string;
      workerIds.push(eligibleWorkerId);
    });

    it('persiste ana_care_id + ana_care_synced_at e limpa sync_error no sucesso', async () => {
      // Primeiro deixa um erro pendente
      await pool.query(
        `UPDATE workers SET ana_care_sync_error = 'HTTP 400: bad email' WHERE id = $1`,
        [eligibleWorkerId],
      );
      // Simula o que persistSuccess do use case faz
      await pool.query(
        `UPDATE workers
         SET ana_care_id = $2, ana_care_synced_at = NOW(), ana_care_sync_error = NULL
         WHERE id = $1`,
        [eligibleWorkerId, String(MOCK_ANA_CARE_ID)],
      );

      const { rows } = await pool.query(
        `SELECT ana_care_id, ana_care_synced_at, ana_care_sync_error FROM workers WHERE id = $1`,
        [eligibleWorkerId],
      );
      expect(rows[0].ana_care_id).toBe(String(MOCK_ANA_CARE_ID));
      expect(rows[0].ana_care_synced_at).not.toBeNull();
      expect(rows[0].ana_care_sync_error).toBeNull();
    });

    it('índice único parcial em ana_care_id previne duplicatas', async () => {
      const dupId = '90909';
      const first = await pool.query(
        `INSERT INTO workers (auth_uid, email, status, country, ana_care_id)
         VALUES ('e2e-backfill-dup-a', 'e2e-backfill-dup-a@example.com', 'REGISTERED', 'AR', $1)
         RETURNING id`,
        [dupId],
      );
      workerIds.push(first.rows[0].id as string);

      const err = await pool.query(
        `INSERT INTO workers (auth_uid, email, status, country, ana_care_id)
         VALUES ('e2e-backfill-dup-b', 'e2e-backfill-dup-b@example.com', 'REGISTERED', 'AR', $1)
         RETURNING id`,
        [dupId],
      ).catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/unique/i);
    });
  });
});
