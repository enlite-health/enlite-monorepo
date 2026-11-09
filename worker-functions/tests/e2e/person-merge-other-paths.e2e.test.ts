/**
 * person-merge-other-paths.e2e.test.ts — os outros caminhos de merge também unem as pessoas
 * (spec acesso-do-cliente, F1, item 15; D648).
 *
 * (i)  lote por CLI: `WorkerPhoneMergeService.execute()` com grupo *ghost* de uid REAL (e-mail @enlite.import) →
 *      `iam.person.merged_into_id` preenchido para a pessoa do ghost, com o auditId do merge.
 * (ii) `POST /analytics/dedup/run` (rota REAL, controller REAL, serviço de dedup REAL, banco real) com DUBLÊ do LLM:
 *      o único canal externo do caminho é o `fetch` para api.groq.com; o teste o substitui por uma resposta sintética
 *      e FALHA se o fetch for chamado para qualquer outro destino. Nenhum canal real é tocado. Só a autenticação/permissão
 *      é passante (o que se prova é a união das pessoas, não o login). Merge por LLM não tem audit → merged_by_… NULL.
 *
 * Fixtures sintéticas (`@enlite.test`/`@enlite.import`, sufixo único); iam.* é append-only e não é apagado.
 */
import { randomBytes, randomUUID } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { AnalyticsRepository } from '../../src/infrastructure/repositories/AnalyticsRepository';
import { WorkerPhoneMergeService } from '../../src/infrastructure/services/WorkerPhoneMergeService';
import { AnalyticsController } from '../../src/modules/matching/interfaces/controllers/AnalyticsController';
import { createAnalyticsRoutes } from '../../src/modules/matching/interfaces/routes/analyticsRoutes';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = randomBytes(4).toString('hex');
let pool: Pool;

async function seedWorker(label: string, email: string, phone: string): Promise<{ id: string; uid: string }> {
  const id = randomUUID();
  const uid = `e2e-op-${RUN}-${label}`;
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [id, uid, email, phone],
  );
  return { id, uid };
}

const personOf = async (uid: string): Promise<string> =>
  (await pool.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [uid])).rows[0].p;

async function personRow(personId: string): Promise<{ merged_into_id: string | null; audit: string | null }> {
  const r = await pool.query(
    `SELECT merged_into_id, merged_by_worker_merge_audit_id AS audit FROM iam.person WHERE id = $1`,
    [personId],
  );
  return r.rows[0];
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;
});

afterAll(async () => {
  await pool.end();
});

describe('(i) merge em lote pela CLI (ghost de uid real)', () => {
  it('execute() une a pessoa do ghost à pessoa do real, com o auditId do merge', async () => {
    // mesmo phone_normalized com raw diferente (10 dígitos × 13 dígitos): ghost = e-mail @enlite.import, uid REAL
    const base = `1133${(parseInt(RUN, 16) % 1000000).toString().padStart(6, '0')}`;
    const real = await seedWorker('real-i', `real-i-${RUN}@enlite.test`, `549${base}`);
    const ghost = await seedWorker('ghost-i', `ghost-i-${RUN}@enlite.import`, base);
    const pReal = await personOf(real.uid);
    const pGhost = await personOf(ghost.uid);
    expect(pReal).not.toBe(pGhost);

    const result = await new WorkerPhoneMergeService().execute();
    expect(result.errors ?? []).toEqual([]);

    const row = await personRow(pGhost);
    expect(row.merged_into_id).toBe(pReal);
    const audit = await pool.query(
      `SELECT id FROM worker_merge_audit WHERE survivor_id = $1::uuid AND absorbed_id = $2::uuid`,
      [real.id, ghost.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(String(row.audit)).toBe(String(audit.rows[0].id));
  });
});

describe('(ii) POST /analytics/dedup/run com dublê do LLM', () => {
  // DEFEITO PRÉ-EXISTENTE (fora da T130, vai à LISTA): contra o schema migrado, a rota não fecha sozinha —
  // (1) a view v_potential_duplicate_workers (028) expõe worker_id_1/worker_id_2/match_type e o AnalyticsRepository lê
  //     worker1_id/worker2_id/match_reason; (2) WorkerDeduplicationService.mergeWorkers faz `cuit = COALESCE($6, cuit)` e
  //     a coluna workers.cuit foi dropada na 028. Para provar o gancho DENTRO do mergeWorkers real, o teste (a) devolve
  //     o par de candidatos por spy em findDuplicateCandidates e (b) cria workers.cuit só enquanto o describe roda
  //     (e só se não existir), removendo no fim.
  let cuitCriadaAqui = false;
  const realFetch = global.fetch;
  const groqCalls: string[] = [];
  const prevKey = process.env.GROQ_API_KEY;

  beforeAll(async () => {
    const tem = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='workers' AND column_name='cuit'`);
    if (tem.rowCount === 0) {
      await pool.query(`ALTER TABLE workers ADD COLUMN cuit TEXT`);
      cuitCriadaAqui = true;
    }
    process.env.GROQ_API_KEY = 'e2e-double-key'; // chave fictícia: o fetch abaixo nunca sai da máquina
    global.fetch = (async (input: unknown) => {
      const url = String(input);
      if (!url.startsWith('https://api.groq.com/openai/v1/chat/completions')) {
        throw new Error(`fetch inesperado no teste do dedup (canal real bloqueado): ${url}`);
      }
      groqCalls.push(url);
      const analysis = {
        is_same_person: true, confidence: 0.99, explanation: 'dublê e2e',
        preferred_phone: null, preferred_email: null, preferred_first_name: null, preferred_last_name: null,
        preferred_cuit: null, merged_phone: null, merged_email: 'dedup-ii@enlite.test',
        merged_first_name: null, merged_last_name: null, merged_cuit: null,
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (cuitCriadaAqui) await pool.query(`ALTER TABLE workers DROP COLUMN IF EXISTS cuit`);
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prevKey;
  });

  it('une as pessoas das duas fichas, sem audit (merged_by_… NULL)', async () => {
    // duas fichas de uid real, pessoas distintas; o par candidato vem do spy (ver o defeito pré-existente acima)
    const tail = (parseInt(RUN, 16) % 10000000).toString().padStart(7, '0');
    const w1 = await seedWorker('dd1', `dd1-${RUN}@enlite.test`, `549115${tail}`);
    const w2 = await seedWorker('dd2', `dd2-${RUN}@enlite.test`, `549116${tail}`);
    const p1 = await personOf(w1.uid);
    const p2 = await personOf(w2.uid);
    jest.spyOn(AnalyticsRepository.prototype, 'findDuplicateCandidates').mockResolvedValue([{
      worker1Id: w1.id, worker1Phone: `549115${tail}`, worker1Email: `dd1-${RUN}@enlite.test`,
      worker1FirstName: null, worker1LastName: null, worker1Cuit: null, worker1Sources: [],
      worker2Id: w2.id, worker2Phone: `549116${tail}`, worker2Email: `dd2-${RUN}@enlite.test`,
      worker2FirstName: null, worker2LastName: null, worker2Cuit: null, worker2Sources: [],
      matchReason: 'phone_similar',
    }]);

    const passa = (_q: Request, _s: Response, next: NextFunction) => next();
    const authFake = { requireStaff: () => passa } as never;
    const permFake = { family: () => ({ require: () => passa }) } as never;
    const app = express();
    app.use(express.json());
    app.use('/analytics', createAnalyticsRoutes(new AnalyticsController(), authFake, permFake));

    const res = await request(app).post('/analytics/dedup/run').send({ dryRun: false, confidence: 0.85, limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data.mergesExecuted).toBe(1);
    expect(res.body.data.errors).toBe(0);
    expect(groqCalls).toHaveLength(1);

    const rows = [await personRow(p1), await personRow(p2)];
    const absorbed = rows.filter((r) => r.merged_into_id !== null);
    expect(absorbed).toHaveLength(1); // exatamente uma foi absorvida pela outra
    expect([p1, p2]).toContain(absorbed[0].merged_into_id);
    expect(absorbed[0].audit).toBeNull(); // merge por LLM não tem worker_merge_audit → sem undo
  });
});
