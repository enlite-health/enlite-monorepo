/**
 * job-posting-audit-repository.e2e.test.ts
 *
 * Entregável B — Teste de repositório com BANCO REAL.
 *
 * Substitui src/modules/matching/infrastructure/__tests__/JobPostingAuditRepository.test.ts
 * (mockado), que viola o CLAUDE.md ("Testes de repositório usam banco real — nunca mock").
 *
 * Cobertura:
 *   1. 5 event types: CREATED (before=null), UPDATED, STATUS_CHANGED,
 *      DRAFT_CHANGED (is_draft — não alcançável via HTTP), DELETED (after=null)
 *   2. 4 actor types: HUMAN (com actor_user_id FK válido), WEBHOOK (actor_user_id NULL),
 *      SYSTEM, CLI. Prova que CHECK constraint aceita os 4 e rejeita inválido.
 *   3. logFieldChanges multi-campo: 3 campos → 3 linhas, cada uma com event_type correto.
 *   4. Comportamento SAVEPOINT (logEventSafe): INSERT de audit com FK inválida NÃO
 *      aborta a transação principal — UPDATE na job_postings ainda commita.
 *   5. FK ON DELETE CASCADE: deletar job_posting remove as linhas de audit.
 */

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import {
  JobPostingAuditRepository,
} from '../../src/modules/matching/infrastructure/JobPostingAuditRepository';
import type { AuditActorType, AuditEventType } from '../../src/modules/matching/infrastructure/JobPostingAuditRepository';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  job_posting_id: string;
  event_type: string;
  field_name: string | null;
  changes: { before: unknown; after: unknown };
  actor_user_id: string | null;
  actor_type: string;
  actor_label: string | null;
  trace_id: string | null;
}

async function getAuditRows(pool: Pool, jobPostingId: string): Promise<AuditRow[]> {
  const res = await pool.query<AuditRow>(
    `SELECT id, job_posting_id, event_type, field_name, changes,
            actor_user_id, actor_type, actor_label, trace_id
     FROM job_posting_audit_log
     WHERE job_posting_id = $1
     ORDER BY created_at ASC`,
    [jobPostingId],
  );
  return res.rows;
}

/**
 * Cria uma job_posting mínima diretamente no banco (sem passar pela API HTTP)
 * para não depender de nenhuma outra camada.
 */
async function seedJobPosting(
  pool: Pool,
  patientId: string,
  caseNumber: number,
): Promise<string> {
  const vnRes = await pool.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn = vnRes.rows[0]!.vn;
  const title = `CASO ${caseNumber}-${vn}`;

  const res = await pool.query<{ id: string }>(
    `INSERT INTO job_postings
       (vacancy_number, case_number, title, status, country, patient_id)
     VALUES ($1, $2, $3, 'PENDING_ACTIVATION', 'AR', $4)
     RETURNING id`,
    [vn, caseNumber, title, patientId],
  );
  return res.rows[0]!.id;
}

async function seedUser(
  pool: Pool,
  uid: string,
  email: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO users (firebase_uid, email, display_name, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (firebase_uid) DO NOTHING`,
    [uid, email, 'Audit Repo E2E'],
  );
}

async function seedPatient(pool: Pool): Promise<string> {
  const clickupTaskId = `e2e-audit-repo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'Audit', 'Repo', 'AR', 'ACTIVE')
     RETURNING id`,
    [clickupTaskId],
  );
  return res.rows[0]!.id;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('JobPostingAuditRepository — banco real (Entregável B)', () => {
  let pool: Pool;
  let repo: JobPostingAuditRepository;

  // IDs criados e limpos no afterAll
  let patientId: string;
  const jobPostingIds: string[] = [];
  const VALID_USER_UID = 'audit-repo-e2e-user-001';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new JobPostingAuditRepository();

    await seedUser(pool, VALID_USER_UID, 'audit-repo-e2e@e2e.local');
    patientId = await seedPatient(pool);
  });

  afterAll(async () => {
    // Cascade via FK ON DELETE CASCADE remove audit rows automaticamente
    if (jobPostingIds.length > 0) {
      await pool
        .query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [jobPostingIds])
        .catch(() => {});
    }
    await pool
      .query(`DELETE FROM patients WHERE id = $1`, [patientId])
      .catch(() => {});
    await pool
      .query(`DELETE FROM users WHERE firebase_uid = $1`, [VALID_USER_UID])
      .catch(() => {});
    await pool.end();
  });

  // ── 1. 5 Event Types ────────────────────────────────────────────────────────

  describe('1. 5 event types via logEvent/logFieldChanges com banco real', () => {
    let jobPostingId: string;
    let client: PoolClient;

    beforeAll(async () => {
      jobPostingId = await seedJobPosting(pool, patientId, 91001);
      jobPostingIds.push(jobPostingId);
      client = await pool.connect();
    });

    afterAll(async () => {
      client.release();
    });

    it('CREATED — before=null, after=snapshot', async () => {
      await client.query('BEGIN');
      await repo.logEvent(client, {
        jobPostingId,
        eventType: 'CREATED',
        changes: { before: null, after: { id: jobPostingId, status: 'PENDING_ACTIVATION' } },
        actorUserId: VALID_USER_UID,
        actorType: 'HUMAN',
        actorLabel: 'admin_panel',
      });
      await client.query('COMMIT');

      const rows = await getAuditRows(pool, jobPostingId);
      const row = rows.find(r => r.event_type === 'CREATED');
      expect(row).toBeDefined();
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBeTruthy();
      expect((row!.changes.after as Record<string, unknown>).id).toBe(jobPostingId);
      expect(row!.actor_user_id).toBe(VALID_USER_UID);
      expect(row!.actor_type).toBe('HUMAN');
    });

    it('UPDATED — via logFieldChanges com field genérico', async () => {
      await client.query('BEGIN');
      await repo.logFieldChanges(client, {
        jobPostingId,
        fields: [{ field: 'salary_text', before: 'A convenir', after: 'ARS 1500/hora' }],
        actorUserId: VALID_USER_UID,
        actorType: 'HUMAN',
        actorLabel: 'admin_panel',
      });
      await client.query('COMMIT');

      const rows = await getAuditRows(pool, jobPostingId);
      const row = rows.find(
        r => r.event_type === 'UPDATED' && r.field_name === 'salary_text',
      );
      expect(row).toBeDefined();
      expect(row!.changes.before).toBe('A convenir');
      expect(row!.changes.after).toBe('ARS 1500/hora');
    });

    it('STATUS_CHANGED — via logFieldChanges com field=status', async () => {
      await client.query('BEGIN');
      await repo.logFieldChanges(client, {
        jobPostingId,
        fields: [{ field: 'status', before: 'PENDING_ACTIVATION', after: 'SEARCHING' }],
        actorUserId: VALID_USER_UID,
        actorType: 'HUMAN',
        actorLabel: 'admin_panel',
      });
      await client.query('COMMIT');

      const rows = await getAuditRows(pool, jobPostingId);
      const row = rows.find(
        r => r.event_type === 'STATUS_CHANGED' && r.field_name === 'status',
      );
      expect(row).toBeDefined();
      expect(row!.changes.before).toBe('PENDING_ACTIVATION');
      expect(row!.changes.after).toBe('SEARCHING');
    });

    it('DRAFT_CHANGED — via logFieldChanges com field=is_draft (não alcançável via HTTP)', async () => {
      await client.query('BEGIN');
      await repo.logFieldChanges(client, {
        jobPostingId,
        fields: [{ field: 'is_draft', before: true, after: false }],
        actorUserId: VALID_USER_UID,
        actorType: 'HUMAN',
        actorLabel: 'publish_flow',
      });
      await client.query('COMMIT');

      const rows = await getAuditRows(pool, jobPostingId);
      const row = rows.find(
        r => r.event_type === 'DRAFT_CHANGED' && r.field_name === 'is_draft',
      );
      expect(row).toBeDefined();
      expect(row!.changes.before).toBe(true);
      expect(row!.changes.after).toBe(false);
    });

    it('DELETED — after=null, before=snapshot', async () => {
      await client.query('BEGIN');
      await repo.logEvent(client, {
        jobPostingId,
        eventType: 'DELETED',
        changes: { before: { id: jobPostingId, status: 'SEARCHING' }, after: null },
        actorUserId: VALID_USER_UID,
        actorType: 'HUMAN',
        actorLabel: 'admin_panel',
      });
      await client.query('COMMIT');

      const rows = await getAuditRows(pool, jobPostingId);
      const row = rows.find(r => r.event_type === 'DELETED');
      expect(row).toBeDefined();
      expect(row!.changes.after).toBeNull();
      expect((row!.changes.before as Record<string, unknown>).id).toBe(jobPostingId);
    });
  });

  // ── 2. 4 Actor Types + CHECK constraint ─────────────────────────────────────

  describe('2. 4 actor types: CHECK constraint aceita todos; rejeita inválido', () => {
    let jobPostingId: string;

    beforeAll(async () => {
      jobPostingId = await seedJobPosting(pool, patientId, 91002);
      jobPostingIds.push(jobPostingId);
    });

    const validActors: Array<{
      actorType: AuditActorType;
      actorUserId: string | null;
      actorLabel: string | null;
    }> = [
      {
        actorType: 'HUMAN',
        actorUserId: VALID_USER_UID,
        actorLabel: 'admin_panel',
      },
      {
        actorType: 'WEBHOOK',
        actorUserId: null,
        actorLabel: 'talentum_webhook',
      },
      {
        actorType: 'SYSTEM',
        actorUserId: null,
        actorLabel: 'clickup-sync',
      },
      {
        actorType: 'CLI',
        actorUserId: null,
        actorLabel: 'backfill-script',
      },
    ];

    it.each(validActors)(
      'actor_type=$actorType é aceito pelo CHECK constraint',
      async ({ actorType, actorUserId, actorLabel }) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await repo.logEvent(client, {
            jobPostingId,
            eventType: 'UPDATED',
            fieldName: 'daily_obs',
            changes: { before: null, after: `teste actor ${actorType}` },
            actorUserId,
            actorType,
            actorLabel,
          });
          await client.query('COMMIT');
        } finally {
          client.release();
        }

        const rows = await getAuditRows(pool, jobPostingId);
        const row = rows.find(
          r =>
            r.actor_type === actorType &&
            (r.changes.after as string) === `teste actor ${actorType}`,
        );
        expect(row).toBeDefined();
        expect(row!.actor_type).toBe(actorType);
        if (actorType === 'HUMAN') {
          expect(row!.actor_user_id).toBe(VALID_USER_UID);
        } else {
          expect(row!.actor_user_id).toBeNull();
          expect(row!.actor_label).toBe(actorLabel);
        }
      },
    );

    it('actor_type inválido é rejeitado pelo CHECK constraint com erro de banco', async () => {
      const client = await pool.connect();
      let threw = false;
      try {
        await client.query('BEGIN');
        // Insere diretamente contornando a tipagem TypeScript — força valor inválido
        await client.query(
          `INSERT INTO job_posting_audit_log
             (job_posting_id, event_type, changes, actor_type)
           VALUES ($1, 'UPDATED', '{"before":null,"after":"x"}'::jsonb, $2)`,
          [jobPostingId, 'INVALID_ACTOR'],
        );
        await client.query('COMMIT');
      } catch {
        threw = true;
        await client.query('ROLLBACK').catch(() => {});
      } finally {
        client.release();
      }

      expect(threw).toBe(true); // CHECK constraint disparou
    });
  });

  // ── 3. logFieldChanges multi-campo ──────────────────────────────────────────

  describe('3. logFieldChanges multi-campo: 3 campos → 3 linhas com event_types corretos', () => {
    let jobPostingId: string;

    beforeAll(async () => {
      jobPostingId = await seedJobPosting(pool, patientId, 91003);
      jobPostingIds.push(jobPostingId);
    });

    it('3 campos geram 3 linhas de audit com event_type via resolveEventType', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await repo.logFieldChanges(client, {
          jobPostingId,
          fields: [
            { field: 'title', before: 'CASO 91003-OLD', after: 'CASO 91003-NEW' },
            { field: 'status', before: 'PENDING_ACTIVATION', after: 'SEARCHING' },
            { field: 'is_draft', before: true, after: false },
          ],
          actorUserId: VALID_USER_UID,
          actorType: 'HUMAN',
          actorLabel: 'multi_field_test',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const rows = await getAuditRows(pool, jobPostingId);

      const titleRow = rows.find(r => r.field_name === 'title');
      const statusRow = rows.find(r => r.field_name === 'status');
      const draftRow = rows.find(r => r.field_name === 'is_draft');

      expect(rows.length).toBeGreaterThanOrEqual(3);

      expect(titleRow).toBeDefined();
      expect(titleRow!.event_type).toBe('UPDATED');
      expect(titleRow!.changes.before).toBe('CASO 91003-OLD');
      expect(titleRow!.changes.after).toBe('CASO 91003-NEW');

      expect(statusRow).toBeDefined();
      expect(statusRow!.event_type).toBe('STATUS_CHANGED');
      expect(statusRow!.changes.before).toBe('PENDING_ACTIVATION');
      expect(statusRow!.changes.after).toBe('SEARCHING');

      expect(draftRow).toBeDefined();
      expect(draftRow!.event_type).toBe('DRAFT_CHANGED');
      expect(draftRow!.changes.before).toBe(true);
      expect(draftRow!.changes.after).toBe(false);
    });
  });

  // ── 4. SAVEPOINT (logEventSafe) — audit failure não aborta a tx principal ───

  describe('4. SAVEPOINT: logEventSafe engole FK inválida, UPDATE principal commita', () => {
    let jobPostingId: string;

    beforeAll(async () => {
      jobPostingId = await seedJobPosting(pool, patientId, 91004);
      jobPostingIds.push(jobPostingId);
    });

    it('UPDATE job_postings commita mesmo quando logEventSafe tem FK inválida', async () => {
      const INVALID_USER_UID = `nonexistent-user-${randomUUID()}`;
      const NEW_DAILY_OBS = `savepoint-test-${Date.now()}`;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1. UPDATE legítimo na job_posting
        await client.query(
          `UPDATE job_postings SET daily_obs = $1, updated_at = NOW() WHERE id = $2`,
          [NEW_DAILY_OBS, jobPostingId],
        );

        // 2. logEventSafe com actor_user_id que não existe em users
        //    → FK violation, mas SAVEPOINT deve absorver sem abortar a tx
        await repo.logEventSafe(client, {
          jobPostingId,
          eventType: 'UPDATED',
          fieldName: 'daily_obs',
          changes: { before: null, after: NEW_DAILY_OBS },
          actorUserId: INVALID_USER_UID, // FK inválida
          actorType: 'HUMAN',
          actorLabel: 'savepoint_test',
        });

        // 3. COMMIT deve funcionar — o UPDATE persiste
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      // Confirma que o UPDATE persistiu
      const updatedRes = await pool.query<{ daily_obs: string | null }>(
        `SELECT daily_obs FROM job_postings WHERE id = $1`,
        [jobPostingId],
      );
      expect(updatedRes.rows[0]?.daily_obs).toBe(NEW_DAILY_OBS);

      // Confirma que NENHUMA linha de audit foi gravada (SAVEPOINT rolou back o INSERT)
      const auditRows = await getAuditRows(pool, jobPostingId);
      const auditRow = auditRows.find(
        r => r.field_name === 'daily_obs' && r.actor_type === 'HUMAN',
      );
      expect(auditRow).toBeUndefined();
    });
  });

  // ── 5. FK ON DELETE CASCADE ──────────────────────────────────────────────────

  describe('5. FK ON DELETE CASCADE: deletar job_posting remove audit rows', () => {
    it('audit rows são removidas em cascata ao deletar job_posting', async () => {
      // Cria job_posting isolada para este teste
      const cascadeJobId = await seedJobPosting(pool, patientId, 91005);
      // jobPostingIds NÃO recebe este id — será deletado manualmente aqui

      // Insere audit rows
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await repo.logEvent(client, {
          jobPostingId: cascadeJobId,
          eventType: 'CREATED',
          changes: { before: null, after: { id: cascadeJobId } },
          actorUserId: VALID_USER_UID,
          actorType: 'HUMAN',
        });
        await repo.logFieldChanges(client, {
          jobPostingId: cascadeJobId,
          fields: [
            { field: 'title', before: 'OLD', after: 'NEW' },
            { field: 'status', before: 'PENDING_ACTIVATION', after: 'SEARCHING' },
          ],
          actorType: 'SYSTEM',
          actorLabel: 'cascade-test',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      // Confirma que linhas existem antes do delete
      const rowsBefore = await getAuditRows(pool, cascadeJobId);
      expect(rowsBefore.length).toBeGreaterThanOrEqual(3);

      // Deleta a job_posting
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [cascadeJobId]);

      // Confirma que as audit rows foram removidas em cascata
      const rowsAfter = await getAuditRows(pool, cascadeJobId);
      expect(rowsAfter).toHaveLength(0);
    });
  });

  // ── 6. logFieldChanges com array vazio → nenhuma inserção ───────────────────

  describe('6. logFieldChanges com array vazio → nenhuma linha inserida', () => {
    let jobPostingId: string;

    beforeAll(async () => {
      jobPostingId = await seedJobPosting(pool, patientId, 91006);
      jobPostingIds.push(jobPostingId);
    });

    it('fields=[] não insere linhas de audit', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await repo.logFieldChanges(client, {
          jobPostingId,
          fields: [],
          actorType: 'SYSTEM',
          actorLabel: 'empty-test',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const rows = await getAuditRows(pool, jobPostingId);
      expect(rows).toHaveLength(0);
    });
  });

  // ── 7. trace_id e actor_label propagados corretamente ────────────────────────

  describe('7. trace_id e actor_label propagados para o banco', () => {
    let jobPostingId: string;
    const TRACE = `trace-${randomUUID()}`;

    beforeAll(async () => {
      jobPostingId = await seedJobPosting(pool, patientId, 91007);
      jobPostingIds.push(jobPostingId);
    });

    it('trace_id e actor_label chegam na tabela intactos', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await repo.logEvent(client, {
          jobPostingId,
          eventType: 'UPDATED',
          fieldName: 'daily_obs',
          changes: { before: null, after: 'obs de trace' },
          actorType: 'CLI',
          actorLabel: 'backfill-v2',
          traceId: TRACE,
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const rows = await getAuditRows(pool, jobPostingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.trace_id).toBe(TRACE);
      expect(rows[0]!.actor_label).toBe('backfill-v2');
      expect(rows[0]!.actor_type).toBe('CLI');
    });
  });
});
