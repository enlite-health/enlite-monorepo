/**
 * worker-merge-identity-foundation.e2e.test.ts
 *
 * Fundação do vínculo self-service (openspec: vinculo-contas-colisao-telefone,
 * Bloco 1) contra Postgres REAL — a invariante de índice único só aparece com
 * banco de verdade (regra da casa; caso Edith 03-04/08).
 *
 * Cobre:
 *   1. REGRESSÃO Edith: merge MOVE phone(+ct)/whatsapp/ana_care_id absorvido→
 *      survivor limpando o casco antes — sem violar idx_workers_phone_unique /
 *      idx_workers_ana_care_id_unique (antes do fix, o phone ficava no casco).
 *   2. lgpd_consent_at herdado por coalesce (consent não fica preso no casco).
 *   3. Auditoria: fields_moved + rows_reparented (contagem de LINHAS por tabela).
 *   4. Round-trip undo: campos movidos voltam ao absorvido e saem do survivor
 *      (na ordem limpa-antes — o caminho inverso também não viola índice).
 *   5. resolveCanonicalWorkerId: corrente 1 salto, id inexistente e ciclo.
 *   6. findByAuthUid segue a corrente: login da conta absorvida cai na unificada.
 *   7. findByPhoneCandidates ignora soft-deleted (deleted_at IS NULL).
 *
 * Pré-requisito: Docker stack em pé (npm run test:e2e:stack:up).
 */

import { Pool, PoolClient } from 'pg';
import { WorkerPhoneMergeService } from '../../src/infrastructure/services/WorkerPhoneMergeService';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { discoverWorkerFkTables } from '../../src/infrastructure/services/WorkerPhoneMergeFkDiscovery';
import { resolveCanonicalWorkerId } from '../../src/shared/database/resolveCanonicalWorkerId';
import { findByAuthUid } from '../../src/modules/worker/infrastructure/WorkerAuthRepository';
import { WorkerRepository } from '../../src/modules/worker/infrastructure/WorkerRepository';
import { KMSEncryptionService } from '../../src/shared/security/KMSEncryptionService';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

const STAMP = `idmove_e2e_${Date.now()}`;

// Workers do cenário principal
const SURVIVOR_ID = `00000011-0001-0001-0001-${STAMP.slice(-12)}`;
const ABSORBED_ID = `00000011-0002-0002-0002-${STAMP.slice(-12)}`;
// Cenário ciclo
const CYCLE_A_ID = `00000012-0001-0001-0001-${STAMP.slice(-12)}`;
const CYCLE_B_ID = `00000012-0002-0002-0002-${STAMP.slice(-12)}`;
// Cenário soft-deleted
const DELETED_ID = `00000013-0001-0001-0001-${STAMP.slice(-12)}`;

const PHONE = `549770${STAMP.slice(-7)}`; // 13 dígitos, único por execução
const PHONE_DELETED = `549771${STAMP.slice(-7)}`;
const ANA_CARE_ID = `idm${STAMP.slice(-8)}`;

const ALL_IDS = [SURVIVOR_ID, ABSORBED_ID, CYCLE_A_ID, CYCLE_B_ID, DELETED_ID];

let pool: Pool;
let service: WorkerPhoneMergeService;
let mergeAuditId: number | null = null;

async function insertWorker(
  client: PoolClient,
  params: { id: string; auth_uid: string; email: string; phone?: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [params.id, params.auth_uid, params.email, params.phone ?? null],
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  const dbConn = DatabaseConnection.getInstance();
  (dbConn as unknown as { pool: Pool }).pool = pool;
  service = new WorkerPhoneMergeService();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Survivor SEM phone/whatsapp/ana_care/consent (o caso Edith: conta nova)
    await insertWorker(client, {
      id: SURVIVOR_ID,
      auth_uid: `FirebaseNew_${STAMP}`,
      email: `new_${STAMP}@example.com`,
      phone: null,
    });

    // Absorbed COM tudo (a conta antiga completa)
    await insertWorker(client, {
      id: ABSORBED_ID,
      auth_uid: `FirebaseOld_${STAMP}`,
      email: `old_${STAMP}@example.com`,
      phone: PHONE,
    });
    await client.query(
      `UPDATE workers
       SET phone_encrypted = $2,
           whatsapp_phone_encrypted = $3,
           ana_care_id = $4,
           lgpd_consent_at = NOW() - INTERVAL '10 days'
       WHERE id = $1::uuid`,
      [ABSORBED_ID, Buffer.from(PHONE).toString('base64'), Buffer.from(PHONE).toString('base64'), ANA_CARE_ID],
    );
    // Linha FK real pro rows_reparented contar (disponibilidade da conta antiga)
    await client.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1::uuid, 1, '09:00', '12:00', 'America/Argentina/Buenos_Aires')`,
      [ABSORBED_ID],
    );

    // Ciclo artificial A↔B (corrupção que o resolver não pode travar)
    await insertWorker(client, { id: CYCLE_A_ID, auth_uid: `cycA_${STAMP}`, email: `cyca_${STAMP}@example.com` });
    await insertWorker(client, { id: CYCLE_B_ID, auth_uid: `cycB_${STAMP}`, email: `cycb_${STAMP}@example.com` });
    await client.query(`UPDATE workers SET merged_into_id = $2::uuid WHERE id = $1::uuid`, [CYCLE_A_ID, CYCLE_B_ID]);
    await client.query(`UPDATE workers SET merged_into_id = $2::uuid WHERE id = $1::uuid`, [CYCLE_B_ID, CYCLE_A_ID]);

    // Soft-deleted dono de número (não pode bloquear candidatos)
    await insertWorker(client, {
      id: DELETED_ID,
      auth_uid: `deleted_${STAMP}`,
      email: `deleted_${STAMP}@example.com`,
      phone: PHONE_DELETED,
    });
    await client.query(`UPDATE workers SET deleted_at = NOW() WHERE id = $1::uuid`, [DELETED_ID]);

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
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM worker_merge_snapshots WHERE absorbed_worker_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM worker_merge_audit WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1)`, [ALL_IDS]);
    // quebra o ciclo antes do delete (FK self-ref)
    await client.query(`UPDATE workers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL_IDS]);
  } finally {
    client.release();
  }
  await pool.end();
});

// ─── 1. Merge move campos únicos (REGRESSÃO caso Edith) ───────────────────

describe('merge move phone/whatsapp/ana_care_id (regressão do caso Edith)', () => {
  beforeAll(async () => {
    // Cast via unknown: no estado PRÉ-fix executeSingleMerge devolve void — o
    // teste precisa compilar nos dois estados pra provar o vermelho→verde.
    const outcome = (await service.executeSingleMerge({
      survivorId: SURVIVOR_ID,
      absorbedId: ABSORBED_ID,
      phoneNormalized: PHONE,
      category: 'firebase',
      legalFieldExceptions: [],
      discoveredFks: await discoverWorkerFkTables(pool),
      audit: { source: 'manual' },
    })) as unknown as { auditId: bigint | number } | undefined;
    if (outcome?.auditId != null) {
      mergeAuditId = Number(outcome.auditId);
    } else {
      // fallback (estado pré-fix): pega o audit mais recente do par
      const res = await pool.query<{ id: number }>(
        `SELECT id FROM worker_merge_audit
         WHERE survivor_id = $1::uuid AND absorbed_id = $2::uuid
         ORDER BY created_at DESC LIMIT 1`,
        [SURVIVOR_ID, ABSORBED_ID],
      );
      mergeAuditId = res.rows.length > 0 ? Number(res.rows[0].id) : null;
    }
  });

  it('sobrevivente termina com phone + ciphertext + whatsapp + ana_care_id (sem violar índice único)', async () => {
    const res = await pool.query(
      `SELECT phone, phone_encrypted, whatsapp_phone_encrypted, ana_care_id, lgpd_consent_at
       FROM workers WHERE id = $1::uuid`,
      [SURVIVOR_ID],
    );
    const s = res.rows[0];
    expect(s.phone).toBe(PHONE);
    expect(s.phone_encrypted).toBe(Buffer.from(PHONE).toString('base64'));
    expect(s.whatsapp_phone_encrypted).toBe(Buffer.from(PHONE).toString('base64'));
    expect(s.ana_care_id).toBe(ANA_CARE_ID);
    // consent herdado por coalesce — não fica preso no casco
    expect(s.lgpd_consent_at).not.toBeNull();
  });

  it('casco fica limpo (phone/ana_care_id NULL) e mergeado', async () => {
    const res = await pool.query(
      `SELECT phone, phone_encrypted, whatsapp_phone_encrypted, ana_care_id, merged_into_id
       FROM workers WHERE id = $1::uuid`,
      [ABSORBED_ID],
    );
    const a = res.rows[0];
    expect(a.phone).toBeNull();
    expect(a.phone_encrypted).toBeNull();
    expect(a.whatsapp_phone_encrypted).toBeNull();
    expect(a.ana_care_id).toBeNull();
    expect(a.merged_into_id).toBe(SURVIVOR_ID);
  });

  it('exatamente 1 dono do phone e do ana_care_id no banco inteiro', async () => {
    const phoneOwners = await pool.query(`SELECT COUNT(*) AS cnt FROM workers WHERE phone = $1`, [PHONE]);
    const anaOwners = await pool.query(`SELECT COUNT(*) AS cnt FROM workers WHERE ana_care_id = $1`, [ANA_CARE_ID]);
    expect(Number(phoneOwners.rows[0].cnt)).toBe(1);
    expect(Number(anaOwners.rows[0].cnt)).toBe(1);
  });

  it('auditoria registra fields_moved e rows_reparented com contagem de LINHAS', async () => {
    const res = await pool.query(
      `SELECT fields_moved, rows_reparented FROM worker_merge_audit WHERE id = $1`,
      [mergeAuditId],
    );
    const audit = res.rows[0];
    expect(audit.fields_moved).toEqual(
      expect.arrayContaining(['phone', 'phone_encrypted', 'whatsapp_phone_encrypted', 'ana_care_id']),
    );
    // a disponibilidade semeada da conta antiga foi reparentada e CONTADA
    expect(audit.rows_reparented.worker_availability).toBeGreaterThanOrEqual(1);
  });
});

// ─── 2. findByAuthUid segue a corrente ────────────────────────────────────

describe('findByAuthUid segue merged_into_id', () => {
  it('login da conta absorvida resolve para a conta unificada (não o casco)', async () => {
    const result = await findByAuthUid(pool, new KMSEncryptionService(), `FirebaseOld_${STAMP}`);
    expect(result.isSuccess).toBe(true);
    const worker = result.getValue();
    expect(worker).not.toBeNull();
    expect(worker!.id).toBe(SURVIVOR_ID);
    expect(worker!.phone).toBe(PHONE);
  });

  it('login da conta sobrevivente continua normal', async () => {
    const result = await findByAuthUid(pool, new KMSEncryptionService(), `FirebaseNew_${STAMP}`);
    expect(result.getValue()!.id).toBe(SURVIVOR_ID);
  });
});

// ─── 3. resolveCanonicalWorkerId ──────────────────────────────────────────

describe('resolveCanonicalWorkerId', () => {
  it('corrente de 1 salto resolve pro survivor', async () => {
    await expect(resolveCanonicalWorkerId(pool, ABSORBED_ID)).resolves.toBe(SURVIVOR_ID);
  });

  it('id vivo devolve o próprio', async () => {
    await expect(resolveCanonicalWorkerId(pool, SURVIVOR_ID)).resolves.toBe(SURVIVOR_ID);
  });

  it('id inexistente devolve null', async () => {
    await expect(
      resolveCanonicalWorkerId(pool, '00000000-dead-beef-0000-000000000000'),
    ).resolves.toBeNull();
  });

  it('ciclo A↔B devolve null sem travar', async () => {
    await expect(resolveCanonicalWorkerId(pool, CYCLE_A_ID)).resolves.toBeNull();
  });
});

// ─── 4. findByPhoneCandidates ignora soft-deleted ─────────────────────────

describe('findByPhoneCandidates filtra deleted_at', () => {
  it('conta soft-deletada NÃO bloqueia o número', async () => {
    const repo = new WorkerRepository();
    const result = await repo.findByPhoneCandidates([PHONE_DELETED]);
    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toBeNull();
  });

  it('conta viva continua sendo encontrada', async () => {
    const repo = new WorkerRepository();
    const result = await repo.findByPhoneCandidates([PHONE]);
    expect(result.getValue()!.id).toBe(SURVIVOR_ID);
  });
});

// ─── 5. Round-trip: undo devolve os campos movidos ────────────────────────

describe('undo devolve campos movidos sem violar índice', () => {
  beforeAll(async () => {
    expect(mergeAuditId).not.toBeNull();
    await service.undoMerge(mergeAuditId!);
  });

  it('absorvido volta com phone/whatsapp/ana_care_id e sem merged_into_id', async () => {
    const res = await pool.query(
      `SELECT phone, whatsapp_phone_encrypted, ana_care_id, merged_into_id
       FROM workers WHERE id = $1::uuid`,
      [ABSORBED_ID],
    );
    const a = res.rows[0];
    expect(a.phone).toBe(PHONE);
    expect(a.whatsapp_phone_encrypted).toBe(Buffer.from(PHONE).toString('base64'));
    expect(a.ana_care_id).toBe(ANA_CARE_ID);
    expect(a.merged_into_id).toBeNull();
  });

  it('sobrevivente fica limpo dos campos que tinham vindo do move', async () => {
    const res = await pool.query(
      `SELECT phone, phone_encrypted, whatsapp_phone_encrypted, ana_care_id
       FROM workers WHERE id = $1::uuid`,
      [SURVIVOR_ID],
    );
    const s = res.rows[0];
    expect(s.phone).toBeNull();
    expect(s.phone_encrypted).toBeNull();
    expect(s.whatsapp_phone_encrypted).toBeNull();
    expect(s.ana_care_id).toBeNull();
  });

  it('de novo: exatamente 1 dono do phone e do ana_care_id', async () => {
    const phoneOwners = await pool.query(`SELECT COUNT(*) AS cnt FROM workers WHERE phone = $1`, [PHONE]);
    const anaOwners = await pool.query(`SELECT COUNT(*) AS cnt FROM workers WHERE ana_care_id = $1`, [ANA_CARE_ID]);
    expect(Number(phoneOwners.rows[0].cnt)).toBe(1);
    expect(Number(anaOwners.rows[0].cnt)).toBe(1);
  });
});
