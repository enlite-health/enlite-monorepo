/**
 * worker-merge-audit-trail.e2e.test.ts
 *
 * Integração contra Postgres REAL (Docker). Prova que o rastro de auditoria
 * (quem/de onde/como) é DE FATO persistido — não só o wiring mockado.
 *
 * Cobre, end-to-end (use case de produção → banco real):
 *   1. Merge admin grava executed_by + email (resolvido de users), source,
 *      confirmed_same_person, ip/user_agent/request_id, field_choices,
 *      applied_overrides (campo sobrescrito + de qual conta), survivor/absorbed email.
 *   2. O override REALMENTE aconteceu (first_name_encrypted do absorvido → survivor).
 *   3. Undo grava undone_by + email + undone_at + undo ip/ua/request_id e reativa o absorvido.
 *   4. Merge automático (sem ator) cai em executed_by='system' / source='auto_batch'.
 *
 * Pré-requisito: Docker stack de pé + migrations aplicadas (inclui 227).
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { ExecuteAdminMergeUseCase } from '../../src/application/dedup/ExecuteAdminMergeUseCase';
import { UndoMergeUseCase } from '../../src/application/dedup/UndoMergeUseCase';
import { WorkerPhoneMergeService } from '../../src/infrastructure/services/WorkerPhoneMergeService';

const STAMP = `audit_e2e_${Date.now()}`;
const ADMIN_UID = `${STAMP}_admin_uid`;
const ADMIN_EMAIL = `${STAMP}@enlite.health`;

// UUIDs determinísticos por execução (prefixo fixo + sufixo do stamp curto)
const SUF = String(Date.now()).slice(-8); // 8 dígitos → último segmento UUID = "0000"+8 = 12 chars
const SURVIVOR_ID = `cafe0000-0000-4000-8000-0000${SUF}`;
const ABSORBED_ID = `cafe0001-0000-4000-8000-0000${SUF}`;
const ABSORBED2_ID = `cafe0002-0000-4000-8000-0000${SUF}`;

let pool: Pool;

beforeAll(async () => {
  pool = DatabaseConnection.getInstance().getPool();

  // Admin no users (pra resolveAdminEmail achar o email)
  await pool.query(
    `INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email`,
    [ADMIN_UID, ADMIN_EMAIL],
  );

  // Survivor + 2 absorbidos (mesmo telefone). Absorbido com first_name_encrypted
  // pra provar o override; survivor sem (NULL) pra ver a sobrescrita.
  // Telefones distintos e globalmente únicos (índice único em workers.phone).
  // O merge admin é por ids explícitos, não exige telefone igual.
  const rows: Array<[string, string, string]> = [
    [SURVIVOR_ID, `${STAMP}_surv@x.com`, `+54911${SUF}1`],
    [ABSORBED_ID, `${STAMP}_abs@x.com`, `+54911${SUF}2`],
    [ABSORBED2_ID, `${STAMP}_abs2@x.com`, `+54911${SUF}3`],
  ];
  for (const [id, email, phone] of rows) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
      [id, `${STAMP}_${id}`, email, phone],
    );
  }
  await pool.query(
    `UPDATE workers SET first_name_encrypted = 'CIPHER_ABS_NAME' WHERE id = $1::uuid`,
    [ABSORBED_ID],
  );
});

afterAll(async () => {
  const ids = [SURVIVOR_ID, ABSORBED_ID, ABSORBED2_ID];
  await pool.query(`DELETE FROM worker_merge_snapshots WHERE absorbed_worker_id = ANY($1::uuid[])`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM worker_merge_audit WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [ADMIN_UID]).catch(() => {});
});

describe('Merge audit trail — Postgres real', () => {
  let auditId: number;

  it('persiste QUEM/DE ONDE/COMO + aplica o override de campo', async () => {
    const useCase = new ExecuteAdminMergeUseCase(pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
      fieldChoices: { first_name_encrypted: ABSORBED_ID },
      audit: {
        executedBy: ADMIN_UID,
        source: 'manual',
        confirmedSamePerson: true,
        ipAddress: '203.0.113.42',
        userAgent: 'e2e-agent/1.0',
        requestId: 'req-e2e-merge',
      },
    });

    expect(result.audit_ids.length).toBe(1);
    auditId = result.audit_ids[0];

    const { rows } = await pool.query(
      `SELECT executed_by, executed_by_email, source, confirmed_same_person,
              ip_address, user_agent, request_id, field_choices, applied_overrides,
              survivor_email, absorbed_email
         FROM worker_merge_audit WHERE id = $1`,
      [auditId],
    );
    expect(rows.length).toBe(1);
    const a = rows[0];

    // QUEM
    expect(a.executed_by).toBe(ADMIN_UID);
    expect(a.executed_by_email).toBe(ADMIN_EMAIL); // resolvido de users
    // DE ONDE
    expect(a.source).toBe('manual');
    expect(a.confirmed_same_person).toBe(true);
    expect(a.ip_address).toBe('203.0.113.42');
    expect(a.user_agent).toBe('e2e-agent/1.0');
    expect(a.request_id).toBe('req-e2e-merge');
    // COMO — override registrado (campo + de qual conta)
    expect(a.applied_overrides).toEqual([
      { field: 'first_name_encrypted', from_account_id: ABSORBED_ID },
    ]);
    expect(a.field_choices).toEqual({ first_name_encrypted: ABSORBED_ID });
    // Emails denormalizados das duas contas
    expect(a.survivor_email).toContain('_surv@x.com');
    expect(a.absorbed_email).toContain('_abs@x.com');

    // O override REALMENTE aconteceu no banco
    const surv = await pool.query(`SELECT first_name_encrypted, merged_into_id FROM workers WHERE id = $1::uuid`, [SURVIVOR_ID]);
    expect(surv.rows[0].first_name_encrypted).toBe('CIPHER_ABS_NAME');
    expect(surv.rows[0].merged_into_id).toBeNull();
    const abs = await pool.query(`SELECT merged_into_id FROM workers WHERE id = $1::uuid`, [ABSORBED_ID]);
    expect(abs.rows[0].merged_into_id).toBe(SURVIVOR_ID); // absorvido marcado
  });

  it('persiste QUEM desfez (undo) e reativa o absorvido', async () => {
    const useCase = new UndoMergeUseCase(pool);
    const res = await useCase.execute(auditId, {
      undoneBy: ADMIN_UID,
      ipAddress: '198.51.100.7',
      userAgent: 'e2e-agent-undo/1.0',
      requestId: 'req-e2e-undo',
    });
    expect(res.alreadyUndone).toBe(false);

    const { rows } = await pool.query(
      `SELECT undone_by, undone_by_email, undone_at, undo_ip_address, undo_user_agent, undo_request_id
         FROM worker_merge_audit WHERE id = $1`,
      [auditId],
    );
    const a = rows[0];
    expect(a.undone_by).toBe(ADMIN_UID);
    expect(a.undone_by_email).toBe(ADMIN_EMAIL);
    expect(a.undone_at).not.toBeNull();
    expect(a.undo_ip_address).toBe('198.51.100.7');
    expect(a.undo_user_agent).toBe('e2e-agent-undo/1.0');
    expect(a.undo_request_id).toBe('req-e2e-undo');

    // Absorvido reativado
    const abs = await pool.query(`SELECT merged_into_id FROM workers WHERE id = $1::uuid`, [ABSORBED_ID]);
    expect(abs.rows[0].merged_into_id).toBeNull();
  });

  it('merge automático (sem ator) → executed_by=system / source=auto_batch', async () => {
    const service = new WorkerPhoneMergeService();
    await service.executeSingleMerge({
      survivorId: SURVIVOR_ID,
      absorbedId: ABSORBED2_ID,
      phoneNormalized: '5491155550000',
      category: 'ghost',
      legalFieldExceptions: [],
      // sem audit → defaults de sistema
    });

    const { rows } = await pool.query(
      `SELECT executed_by, source FROM worker_merge_audit
        WHERE survivor_id = $1::uuid AND absorbed_id = $2::uuid
        ORDER BY created_at DESC LIMIT 1`,
      [SURVIVOR_ID, ABSORBED2_ID],
    );
    expect(rows[0].executed_by).toBe('system');
    expect(rows[0].source).toBe('auto_batch');
  });
});
