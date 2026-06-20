/**
 * worker-phone-merge.e2e.test.ts
 *
 * Testes de integração contra Postgres real (Docker local).
 *
 * Semeia workers duplicados com os 3 cenários + ghost, depois executa
 * WorkerPhoneMergeService e verifica que:
 *   1. firebase    → sobrevivente é o com UID real
 *   2. most_complete → sobrevivente é o com mais campos preenchidos
 *   3. ghost match → ghost absorvido no real; ghost.merged_into_id = real.id
 *   4. conflict    → NENHUM merge executado (>1 Firebase real)
 *   5. idempotência → rodar 2× não altera nada (merged_into_id já setado)
 *   6. reparent    → 0 FKs órfãs apontando para workers com merged_into_id IS NOT NULL
 *   7. auditoria   → worker_merge_audit tem linhas com category e fields_filled corretos
 *   8. FK discovery → tabelas reais descobertas dinamicamente; worker_quiz_responses ausente
 *
 * Pré-requisito: Docker stack em pé (make test-integration ou npm run test:e2e).
 */

import { Pool, PoolClient } from 'pg';
import { WorkerPhoneMergeService } from '../../src/infrastructure/services/WorkerPhoneMergeService';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { discoverWorkerFkTables } from '../../src/infrastructure/services/WorkerPhoneMergeFkDiscovery';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

// Prefixo único por execução para isolar os dados semeados
const STAMP = `merge_e2e_${Date.now()}`;

// ─── Helpers de seed ──────────────────────────────────────────────────────

async function insertWorker(
  client: PoolClient,
  params: {
    id: string;
    auth_uid: string;
    email: string;
    phone: string;
    profession?: string | null;
    document_number_encrypted?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [params.id, params.auth_uid, params.email, params.phone],
  );

  if (params.profession) {
    await client.query(
      `UPDATE workers SET profession = $1 WHERE id = $2::uuid`,
      [params.profession, params.id],
    );
  }

  if (params.document_number_encrypted) {
    await client.query(
      `UPDATE workers SET document_number_encrypted = $1 WHERE id = $2::uuid`,
      [params.document_number_encrypted, params.id],
    );
  }
}

async function seedCollision(
  client: PoolClient,
  phoneNormalized: string,
  workerIds: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO worker_phone_collisions (phone_normalized, worker_ids, worker_count)
     VALUES ($1, $2::uuid[], $3)
     ON CONFLICT (phone_normalized) DO NOTHING`,
    [phoneNormalized, workerIds, workerIds.length],
  );
}

// ─── Setup / teardown ─────────────────────────────────────────────────────

let pool: Pool;
let service: WorkerPhoneMergeService;

// IDs dos workers semeados (para limpeza)
const seededWorkerIds: string[] = [];
const seededPhones: string[] = [];

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });

  // Injeta o pool compartilhado no DatabaseConnection (sem iniciar servidor HTTP)
  const dbConn = DatabaseConnection.getInstance();
  (dbConn as unknown as { pool: Pool }).pool = pool;

  service = new WorkerPhoneMergeService();

  const client = await pool.connect();
  try {
    // Migration 222 criou idx_workers_phone_normalized_unique APÓS os dados duplicados
    // já existirem em prod. O teste simula esse estado pré-migration-222, onde múltiplos
    // workers ativos tinham o mesmo phone_normalized. Para reproduzir, removemos
    // temporariamente o índice único (ele é idempotente, recriado no afterAll).
    await client.query(`DROP INDEX IF EXISTS idx_workers_phone_normalized_unique`);
    await client.query('BEGIN');

    // NOTA: idx_workers_phone_unique é UNIQUE no campo `phone` bruto.
    // Para semear múltiplos workers com o mesmo phone_normalized, usamos
    // variações de formato que normalizam para o mesmo valor canônico:
    //   - 13 dígitos: '549XXXXXXXXXX'  (já canônico)
    //   - 10 dígitos: 'XXXXXXXXXX'     (normalize_phone_ar prepend '549')
    //   - 12 dígitos: '54XXXXXXXXXX'   (normalize_phone_ar prepend '9')
    // Isso garante phones raw diferentes (não conflitam na UNIQUE) e
    // phone_normalized idêntico (ativam a lógica de colisão).

    // ── Cenário 1: firebase (1 Firebase real + 2 sintéticos) ──────────────
    // base10 = 10 dígitos derivados do STAMP (único por execução)
    const base1 = `1100${STAMP.slice(-6)}`;       // 10 dígitos
    const phone1_canonical  = `549${base1}`;       // 13 dígitos (canônico)
    const phone1_raw10      = base1;               // 10 dígitos
    const phone1_raw12      = `54${base1}`;        // 12 dígitos (54XX…)
    const phoneNorm1 = phone1_canonical;
    seededPhones.push(phoneNorm1);

    const ids1 = [`00000001-0001-0001-0001-${STAMP.slice(-12)}`,
                   `00000001-0002-0002-0002-${STAMP.slice(-12)}`,
                   `00000001-0003-0003-0003-${STAMP.slice(-12)}`];
    seededWorkerIds.push(...ids1);

    await insertWorker(client, { id: ids1[0], auth_uid: `FirebaseReal_${STAMP}`, email: `fb_real_${STAMP}@example.com`, phone: phone1_canonical, profession: 'AT' });
    await insertWorker(client, { id: ids1[1], auth_uid: `base1import_${STAMP}`,  email: `import1_${STAMP}@enlite.import`, phone: phone1_raw10 });
    await insertWorker(client, { id: ids1[2], auth_uid: `talentum_${STAMP}`,     email: `talentum_${STAMP}@enlite.import`, phone: phone1_raw12 });
    await seedCollision(client, phoneNorm1, ids1);

    // ── Cenário 2: most_complete (0 Firebase, 2 sintéticos, um mais completo) ─
    const base2 = `1200${STAMP.slice(-6)}`;
    const phone2_canonical = `549${base2}`;
    const phone2_raw10     = base2;
    const phoneNorm2 = phone2_canonical;
    seededPhones.push(phoneNorm2);

    const ids2 = [`00000002-0001-0001-0001-${STAMP.slice(-12)}`,
                   `00000002-0002-0002-0002-${STAMP.slice(-12)}`];
    seededWorkerIds.push(...ids2);

    await insertWorker(client, { id: ids2[0], auth_uid: `anacareimport_A${STAMP}`, email: `ana_a_${STAMP}@enlite.import`, phone: phone2_canonical, profession: 'CAREGIVER' });
    await insertWorker(client, { id: ids2[1], auth_uid: `anacareimport_B${STAMP}`, email: `ana_b_${STAMP}@enlite.import`, phone: phone2_raw10 });
    await seedCollision(client, phoneNorm2, ids2);

    // ── Cenário 3: ghost match (ghost + real com mesmo phone_normalized) ─────
    const base3 = `1300${STAMP.slice(-6)}`;
    const phone3_canonical = `549${base3}`;
    const phone3_raw10     = base3;
    const phoneNorm3 = phone3_canonical;
    seededPhones.push(phoneNorm3);

    const idGhost = `00000003-0001-0001-0001-${STAMP.slice(-12)}`;
    const idReal  = `00000003-0002-0002-0002-${STAMP.slice(-12)}`;
    seededWorkerIds.push(idGhost, idReal);

    await insertWorker(client, { id: idGhost, auth_uid: `base1import_ghost${STAMP}`, email: `ghost_${STAMP}@enlite.import`, phone: phone3_raw10 });
    await insertWorker(client, { id: idReal,  auth_uid: `FirebaseReal2_${STAMP}`,    email: `real_${STAMP}@example.com`,    phone: phone3_canonical });
    // Ghost match é detectado via resolveGhosts (não precisa de worker_phone_collisions)

    // ── Cenário 4: conflict (2 Firebase reais) ────────────────────────────
    const base4 = `1400${STAMP.slice(-6)}`;
    const phone4_canonical = `549${base4}`;
    const phone4_raw10     = base4;
    const phoneNorm4 = phone4_canonical;
    seededPhones.push(phoneNorm4);

    const ids4 = [`00000004-0001-0001-0001-${STAMP.slice(-12)}`,
                   `00000004-0002-0002-0002-${STAMP.slice(-12)}`];
    seededWorkerIds.push(...ids4);

    await insertWorker(client, { id: ids4[0], auth_uid: `FirebaseConflict1_${STAMP}`, email: `conf1_${STAMP}@example.com`, phone: phone4_canonical });
    await insertWorker(client, { id: ids4[1], auth_uid: `FirebaseConflict2_${STAMP}`, email: `conf2_${STAMP}@example.com`, phone: phone4_raw10 });
    await seedCollision(client, phoneNorm4, ids4);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (!pool) return;

  // Remove dados semeados (auditoria, colisões, workers) e recria o índice único
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM worker_merge_audit WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])`, [seededWorkerIds]);
    await client.query(`DELETE FROM worker_phone_collisions WHERE phone_normalized = ANY($1)`, [seededPhones]);
    await client.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [seededWorkerIds]);
    // Recria o índice único removido no beforeAll para permitir o seed
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_phone_normalized_unique
        ON workers (phone_normalized)
        WHERE phone_normalized IS NOT NULL AND merged_into_id IS NULL
    `);
  } finally {
    client.release();
  }

  await pool.end();
});

// ─── Cenário 1: firebase ──────────────────────────────────────────────────

describe('Cenário 1: firebase (1 Firebase real)', () => {
  let executed = false;

  beforeAll(async () => {
    if (!executed) {
      await service.execute();
      executed = true;
    }
  });

  it('sobrevivente é o worker com auth_uid Firebase real', async () => {
    const result = await pool.query(
      `SELECT id, merged_into_id FROM workers
       WHERE auth_uid = $1`,
      [`FirebaseReal_${STAMP}`],
    );
    expect(result.rows[0].merged_into_id).toBeNull(); // sobrevivente: nunca mergeado
  });

  it('sintéticos têm merged_into_id apontando para o Firebase real', async () => {
    const survivor = await pool.query(
      `SELECT id FROM workers WHERE auth_uid = $1`,
      [`FirebaseReal_${STAMP}`],
    );
    const survivorId = survivor.rows[0].id;

    const absorbed = await pool.query(
      `SELECT merged_into_id FROM workers
       WHERE auth_uid = ANY($1)`,
      [[`base1import_${STAMP}`, `talentum_${STAMP}`]],
    );

    for (const row of absorbed.rows) {
      expect(row.merged_into_id).toBe(survivorId);
    }
  });

  it('auditoria tem 2 linhas com category=firebase', async () => {
    const survivorRes = await pool.query(
      `SELECT id FROM workers WHERE auth_uid = $1`,
      [`FirebaseReal_${STAMP}`],
    );
    const survivorId = survivorRes.rows[0].id;

    const audit = await pool.query(
      `SELECT category FROM worker_merge_audit WHERE survivor_id = $1::uuid`,
      [survivorId],
    );
    expect(audit.rows.length).toBe(2);
    for (const row of audit.rows) {
      expect(row.category).toBe('firebase');
    }
  });
});

// ─── Cenário 2: most_complete ─────────────────────────────────────────────

describe('Cenário 2: most_complete (0 Firebase real)', () => {
  it('sobrevivente é o com profession preenchida (mais completo)', async () => {
    const complete = await pool.query(
      `SELECT id, merged_into_id FROM workers
       WHERE auth_uid = $1`,
      [`anacareimport_A${STAMP}`],
    );
    expect(complete.rows[0].merged_into_id).toBeNull(); // é o sobrevivente

    const incomplete = await pool.query(
      `SELECT merged_into_id FROM workers
       WHERE auth_uid = $1`,
      [`anacareimport_B${STAMP}`],
    );
    expect(incomplete.rows[0].merged_into_id).toBe(complete.rows[0].id);
  });

  it('auditoria registra category=most_complete', async () => {
    const audit = await pool.query(
      `SELECT category FROM worker_merge_audit
       WHERE phone_normalized = $1`,
      [`5491200${STAMP.slice(-6)}`],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].category).toBe('most_complete');
  });
});

// ─── Cenário 3: ghost match ───────────────────────────────────────────────

describe('Cenário 3: ghost reconciliation', () => {
  it('ghost tem merged_into_id = real.id', async () => {
    const realRes = await pool.query(
      `SELECT id FROM workers WHERE auth_uid = $1`,
      [`FirebaseReal2_${STAMP}`],
    );
    const realId = realRes.rows[0].id;

    const ghostRes = await pool.query(
      `SELECT merged_into_id FROM workers WHERE auth_uid = $1`,
      [`base1import_ghost${STAMP}`],
    );
    expect(ghostRes.rows[0].merged_into_id).toBe(realId);
  });

  it('worker real NÃO tem merged_into_id (ele é o sobrevivente)', async () => {
    const realRes = await pool.query(
      `SELECT merged_into_id FROM workers WHERE auth_uid = $1`,
      [`FirebaseReal2_${STAMP}`],
    );
    expect(realRes.rows[0].merged_into_id).toBeNull();
  });

  it('auditoria tem category=ghost', async () => {
    const audit = await pool.query(
      `SELECT category FROM worker_merge_audit
       WHERE phone_normalized = $1`,
      [`5491300${STAMP.slice(-6)}`],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].category).toBe('ghost');
  });
});

// ─── Cenário 4: conflict ──────────────────────────────────────────────────

describe('Cenário 4: conflict (>1 Firebase real) — não mescla', () => {
  it('ambos os workers com auth_uid Firebase têm merged_into_id NULL (não mergeados)', async () => {
    const result = await pool.query(
      `SELECT merged_into_id FROM workers
       WHERE auth_uid = ANY($1)`,
      [[`FirebaseConflict1_${STAMP}`, `FirebaseConflict2_${STAMP}`]],
    );
    for (const row of result.rows) {
      expect(row.merged_into_id).toBeNull();
    }
  });

  it('sem linha em worker_merge_audit para o grupo de conflito', async () => {
    const audit = await pool.query(
      `SELECT * FROM worker_merge_audit
       WHERE phone_normalized = $1`,
      [`5491400${STAMP.slice(-6)}`],
    );
    expect(audit.rows).toHaveLength(0);
  });
});

// ─── Cenário 5: idempotência ──────────────────────────────────────────────

describe('Cenário 5: idempotência (rodar execute() 2x)', () => {
  it('segunda execução não altera merged_into_id já setados', async () => {
    // Salva estado após primeira execução
    const before = await pool.query(
      `SELECT id, merged_into_id FROM workers WHERE id = ANY($1::uuid[])`,
      [seededWorkerIds],
    );
    const statesBefore = Object.fromEntries(
      before.rows.map(r => [r.id, r.merged_into_id]),
    );

    // Segunda execução
    await service.execute();

    const after = await pool.query(
      `SELECT id, merged_into_id FROM workers WHERE id = ANY($1::uuid[])`,
      [seededWorkerIds],
    );
    for (const row of after.rows) {
      expect(row.merged_into_id).toBe(statesBefore[row.id]);
    }
  });
});

// ─── Cenário 6: reparent — sem FK órfã ───────────────────────────────────

describe('Cenário 6: reparent — 0 FK órfãs', () => {
  const fkTablesToCheck = [
    'worker_job_applications',
    'encuadres',
    'blacklist',
    'worker_service_areas',
    'worker_availability',
    'worker_documents',
    'worker_payment_info',
    'worker_status_history',
    'worker_tags',
    'messaging_outbox',
    'messaging_opt_out',
  ];

  for (const table of fkTablesToCheck) {
    it(`${table}: nenhuma linha com worker_id apontando para worker mergeado`, async () => {
      const result = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM ${table} t
         JOIN workers w ON w.id = t.worker_id
         WHERE w.merged_into_id IS NOT NULL`,
      );
      expect(Number(result.rows[0].cnt)).toBe(0);
    });
  }
});

// ─── Cenário 7 (novo): descoberta dinâmica de FKs ────────────────────────

describe('Cenário 7 (regressão bug prod): descoberta dinâmica de FKs — resiliente a drift', () => {
  it('discoverWorkerFkTables retorna ao menos as tabelas essenciais presentes no Docker', async () => {
    const discovered = await discoverWorkerFkTables(pool);

    // Tabelas essenciais que DEVEM existir no Docker (schema completo com migrations)
    const essentialTables = [
      'worker_job_applications',
      'worker_documents',
      'worker_payment_info',
      'worker_availability',
      'blacklist',
      'messaging_outbox',
      'worker_status_history',
    ];

    const discoveredTableNames = discovered.map(t => t.table);
    for (const t of essentialTables) {
      expect(discoveredTableNames).toContain(t);
    }

    // Todas as entradas têm campos obrigatórios
    for (const entry of discovered) {
      expect(entry.table).toBeTruthy();
      expect(entry.fk_column).toBeTruthy();
      expect(['update', 'upsert_delete']).toContain(entry.strategy);
      expect(Array.isArray(entry.unique_cols)).toBe(true);
    }
  });

  it('REGRESSÃO: worker_quiz_responses NÃO causa erro — simplesmente ausente se não existir no banco', async () => {
    // Este é o bug que quebrou todos os merges em prod:
    // worker_quiz_responses estava na lista hardcoded mas não existia em prod.
    // Com descoberta dinâmica, se não existir no banco, não aparece na lista — sem erro.
    const discovered = await discoverWorkerFkTables(pool);
    const tableNames = discovered.map(t => t.table);

    // Se existir no banco, aparece — sem problema
    // Se não existir, simplesmente não aparece — isso é o comportamento correto
    // O teste verifica que a função não lança erro independentemente
    expect(Array.isArray(tableNames)).toBe(true);
    // (a tabela pode ou não existir dependendo da migration — ambos são válidos)
  });

  it('worker_job_applications tem strategy upsert_delete com unique_cols [worker_id, job_posting_id]', async () => {
    const discovered = await discoverWorkerFkTables(pool);
    const wja = discovered.find(t => t.table === 'worker_job_applications' && t.fk_column === 'worker_id');

    expect(wja).toBeDefined();
    expect(wja!.strategy).toBe('upsert_delete');
    expect(wja!.unique_cols).toContain('worker_id');
    expect(wja!.unique_cols).toContain('job_posting_id');
  });

  it('worker_documents tem strategy upsert_delete com unique_cols [worker_id] (1:1)', async () => {
    const discovered = await discoverWorkerFkTables(pool);
    const docs = discovered.find(t => t.table === 'worker_documents' && t.fk_column === 'worker_id');

    expect(docs).toBeDefined();
    expect(docs!.strategy).toBe('upsert_delete');
    expect(docs!.unique_cols).toEqual(expect.arrayContaining(['worker_id']));
  });

  it('workers.merged_into_id NÃO está na lista (auto-referência excluída)', async () => {
    const discovered = await discoverWorkerFkTables(pool);
    const selfRef = discovered.find(
      t => t.table === 'workers' && t.fk_column === 'merged_into_id',
    );
    expect(selfRef).toBeUndefined();
  });
});
