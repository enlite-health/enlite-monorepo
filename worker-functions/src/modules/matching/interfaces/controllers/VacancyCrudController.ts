import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  authorizeVacancyUpdate,
  buildInsertQuery,
  buildInsertParams,
  FULL_ALLOWED_UPDATE_FIELDS,
  OPERATIONAL_EDITABLE_FIELDS,
} from './vacancyCrudHelpers';
import {
  auditVacancyCreated,
  auditVacancyUpdated,
  auditVacancyDeleted,
  createWithPatientUpdate,
  type HumanActor,
} from './vacancyCrudAuditHelpers';
import { EnsureVacancyShortLinkUseCase } from '../../application/EnsureVacancyShortLinkUseCase';
import { PurgeVacancyShortLinksUseCase } from '../../application/PurgeVacancyShortLinksUseCase';
import { ShortLinkService } from '../../infrastructure/shortlinks/ShortLinkService';
import { reportError, loggingAls } from '@shared/logging';
import { withSystemDbContext } from '@shared/database/requestDbSession';

const PUBLIC_STATUSES = new Set([
  'ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE',
]);

// Inactive statuses whose short links should be purged from Short.io to free quota.
const INACTIVE_STATUSES = new Set(['CLOSED', 'SUSPENDED']);

// Guarda de vaga de teste/QA (migration 248) e is_draft de criação (só válido
// junto com is_test=true, ver createVacancy). Opcional no body, default false
// quando ausente/inválido — never blocks vacancy creation on a bad value.
const OptionalBooleanSchema = z.boolean().optional();

export async function tryEnsureShortLink(
  pool: Pool,
  vacancyId: string,
  status: string | null | undefined,
  isTest: boolean,
): Promise<void> {
  // Vaga is_test=true (fixture E2E/QA) NUNCA cria short link real: Short.io é
  // terceiro sem teardown — o cleanup de fixtures apaga a vaga, mas o link
  // órfão fica lá. Mesmo guard de PublicJobsQueryBuilder.ts (`jp.is_test = false`).
  if (isTest) return;
  if (!status || !PUBLIC_STATUSES.has(status)) return;
  const svc = ShortLinkService.fromEnv();
  if (!svc) {
    return;
  }
  try {
    const uc = new EnsureVacancyShortLinkUseCase(pool, svc);
    await uc.execute(vacancyId, 'site');
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), { source: 'tryEnsureShortLink', vacancyId });
  }
}

// Frees Short.io quota when a vacancy goes inactive. Fire-and-forget; errors are reported, never thrown.
async function tryPurgeShortLinks(pool: Pool, vacancyId: string): Promise<void> {
  const svc = ShortLinkService.fromEnv();
  if (!svc) return;
  try {
    const uc = new PurgeVacancyShortLinksUseCase(pool, svc);
    await uc.execute(vacancyId);
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), { source: 'tryPurgeShortLinks', vacancyId });
  }
}

/** Extracts the HumanActor from an authenticated admin request. */
function extractHumanActor(req: Request): HumanActor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (req as any).user as { uid?: string } | undefined;
  return {
    actorUserId: user?.uid ?? null,
    actorType: 'HUMAN',
    actorLabel: 'admin_panel',
    traceId: loggingAls.getStore()?.traceId ?? null,
  };
}

/**
 * VacancyCrudController
 *
 * Write endpoints: create, update, delete vacancies.
 * Split from VacanciesController to respect the 400-line limit.
 * Audit instrumentation delegated to vacancyCrudAuditHelpers.ts (Onda B).
 */
export class VacancyCrudController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async createVacancy(req: Request, res: Response): Promise<void> {
    try {
      const {
        case_number, patient_id, required_professions, required_sex,
        age_range_min, age_range_max, worker_profile_sought, required_experience,
        worker_attributes, schedule, work_schedule, providers_needed,
        salary_text, payment_day, daily_obs, patient_address_id,
        status: bodyStatus, published_at, closes_at, updatePatient,
        is_test: bodyIsTest, is_draft: bodyIsDraft,
      } = req.body;

      const isTestParse = OptionalBooleanSchema.safeParse(bodyIsTest);
      if (!isTestParse.success) {
        res.status(400).json({
          success: false,
          error: 'is_test must be a boolean when provided',
          details: isTestParse.error.flatten().formErrors,
        });
        return;
      }
      const isTest = isTestParse.data ?? false;

      // is_draft no payload de criação só é honrado quando is_test=true
      // (ver buildInsertParams) — declarado aqui só pra validar o tipo cedo.
      const isDraftParse = OptionalBooleanSchema.safeParse(bodyIsDraft);
      if (!isDraftParse.success) {
        res.status(400).json({
          success: false,
          error: 'is_draft must be a boolean when provided',
          details: isDraftParse.error.flatten().formErrors,
        });
        return;
      }

      if (!patient_id || typeof patient_id !== 'string') {
        res.status(400).json({
          success: false,
          error: 'patient_id é obrigatório. Cadastre o paciente no ClickUp antes de criar a vaga.',
        });
        return;
      }

      const patientCheck = await this.db.query<{ id: string }>(
        'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
        [patient_id],
      );
      if (patientCheck.rows.length === 0) {
        res.status(400).json({ success: false, error: 'patient_id inválido — paciente não encontrado ou foi removido.' });
        return;
      }

      if (patient_address_id && patient_id) {
        const ownerCheck = await this.db.query(
          `SELECT 1 FROM patient_addresses pa
           WHERE pa.id = $1 AND pa.patient_id = $2 AND pa.archived_at IS NULL`,
          [patient_address_id, patient_id],
        );
        if (ownerCheck.rows.length === 0) {
          res.status(400).json({ success: false, error: 'patient_address_id não pertence ao patient_id informado ou foi arquivado' });
          return;
        }
      }

      const vnResult = await this.db.query("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
      const vacancyNumber = parseInt(vnResult.rows[0].vn);
      const computedTitle = `CASO ${case_number}-${vacancyNumber}`;

      const hasUpdate =
        updatePatient && typeof updatePatient === 'object' && Object.keys(updatePatient).length > 0;

      const insertArgs = {
        vacancyNumber, case_number, computedTitle, patient_id,
        required_professions, required_sex, age_range_min, age_range_max,
        worker_profile_sought, required_experience, worker_attributes,
        schedule, work_schedule, providers_needed, salary_text, payment_day,
        daily_obs, patient_address_id,
        status: bodyStatus || undefined,
        published_at: published_at ?? null,
        closes_at: closes_at ?? null,
        is_test: isTest,
        is_draft: isDraftParse.data,
      };

      const actor = extractHumanActor(req);
      let newVacancy: Record<string, unknown>;

      if (hasUpdate) {
        newVacancy = await createWithPatientUpdate(this.db, case_number, updatePatient, insertArgs, actor);
      } else {
        // Non-transactional path: insert, then best-effort audit in separate transaction
        const result = await this.db.query(buildInsertQuery(), buildInsertParams(insertArgs));
        newVacancy = result.rows[0] as Record<string, unknown>;
        // Best-effort audit: acquire a throwaway client, do the insert, release.
        // Audit failure MUST NOT affect the 201 response already committed above.
        const auditClient = await this.db.connect();
        try {
          await auditClient.query('BEGIN');
          await auditVacancyCreated(auditClient, newVacancy.id as string, newVacancy, actor);
          await auditClient.query('COMMIT');
        } catch {
          await auditClient.query('ROLLBACK').catch(() => {});
        } finally {
          auditClient.release();
        }
      }

      // Pós-commit fora da resposta. `withSystemDbContext` (MEDIUM 14/08): o
      // setImmediate herda o ALS da request, que a esta altura pode já estar
      // ENCERRADA — a query sairia pelo pool cru, sem contexto (zero linha sob
      // RLS) e invisível ao modo relatório. Escopo de sistema próprio resolve.
      setImmediate(() => {
        const traceId = loggingAls.getStore()?.traceId ?? null;
        void withSystemDbContext('job:vacancy-postcreate', async () => {
          await this.db.query(
            `INSERT INTO domain_events (event, payload, trace_id) VALUES ('vacancy.created', $1::jsonb, $2)`,
            [JSON.stringify({ jobPostingId: newVacancy.id }), traceId],
          ).catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            reportError(error, { source: 'VacancyCrudController:domainEvent', jobPostingId: newVacancy.id });
          });

          // try* nunca rejeita (auto-captura e reporta) — sem catch aqui.
          await tryEnsureShortLink(this.db, newVacancy.id as string, newVacancy.status as string | undefined, newVacancy.is_test === true);
        });
      });

      res.status(201).json({ success: true, data: newVacancy });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyCrudController:createVacancy' });
      res.status(500).json({ success: false, error: 'Failed to create vacancy', details: msg });
    }
  }

  async updateVacancy(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body as Record<string, unknown>;

      const auth = await authorizeVacancyUpdate(this.db, id, updates);
      if (auth.kind === 'error') {
        res.status(auth.status).json({ success: false, error: auth.error });
        return;
      }
      const allowedFields = auth.isDraft
        ? FULL_ALLOWED_UPDATE_FIELDS
        : FULL_ALLOWED_UPDATE_FIELDS.filter(f => OPERATIONAL_EDITABLE_FIELDS.has(f));

      const jsonbFields = new Set(['schedule']);
      const setClause: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      Object.keys(updates).forEach(key => {
        if (allowedFields.includes(key)) {
          let value: unknown = updates[key];
          if (jsonbFields.has(key) && typeof value === 'object' && value !== null) {
            value = JSON.stringify(value);
          }
          setClause.push(`${key} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      });

      if (setClause.length === 0) {
        res.status(400).json({ success: false, error: 'No valid fields to update' });
        return;
      }

      const actor = extractHumanActor(req);

      // Wrap UPDATE + audit in a transaction to guarantee atomicity.
      // If audit INSERT fails, ROLLBACK the UPDATE too (preserves consistency).
      const client = await this.db.connect();
      let updated: Record<string, unknown> | undefined;
      try {
        await client.query('BEGIN');

        // Snapshot before
        const beforeResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM job_postings WHERE id = $1`,
          [id],
        );
        if (beforeResult.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'Vacancy not found' });
          return;
        }
        const before = beforeResult.rows[0];

        values.push(id);
        const result = await client.query<Record<string, unknown>>(
          `UPDATE job_postings SET ${setClause.join(', ')}, updated_at = NOW()
           WHERE id = $${paramIndex} RETURNING *`,
          values,
        );
        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'Vacancy not found' });
          return;
        }
        updated = result.rows[0];

        // auditVacancyUpdated uses logFieldChangesSafe (SAVEPOINT) — FK failure
        // cannot abort this transaction; the UPDATE always commits.
        await auditVacancyUpdated(client, id, before, updated, actor);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (updated) {
        setImmediate(() => {
          void withSystemDbContext('job:vacancy-postupdate', async () => {
            if (INACTIVE_STATUSES.has(updated!.status as string)) {
              await tryPurgeShortLinks(this.db, id);
            } else {
              // try* nunca rejeita (auto-captura e reporta) — sem catch aqui.
              await tryEnsureShortLink(this.db, id, updated!.status as string, updated!.is_test === true);
            }
          });
        });
        res.status(200).json({ success: true, data: updated });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyCrudController:updateVacancy', vacancyId: req.params.id });
      res.status(500).json({ success: false, error: 'Failed to update vacancy', details: msg });
    }
  }

  async deleteVacancy(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const actor = extractHumanActor(req);

      const client = await this.db.connect();
      try {
        await client.query('BEGIN');

        // Snapshot before soft-delete
        const beforeResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        if (beforeResult.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'Vacancy not found' });
          return;
        }
        const before = beforeResult.rows[0];

        const result = await client.query<{ id: string }>(
          `UPDATE job_postings SET status = 'CLOSED', deleted_at = NOW(), updated_at = NOW()
           WHERE id = $1 RETURNING id`,
          [id],
        );
        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'Vacancy not found' });
          return;
        }

        // auditVacancyDeleted uses logEventSafe (SAVEPOINT) — FK failure cannot
        // abort this transaction; the soft-delete always commits.
        await auditVacancyDeleted(client, id, before, actor);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Free Short.io quota — the deleted vacancy's links will never be shared again.
      setImmediate(() => {
        void withSystemDbContext('job:vacancy-postdelete', () => tryPurgeShortLinks(this.db, id));
      });

      res.status(200).json({ success: true, message: 'Vacancy deleted successfully' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyCrudController:deleteVacancy', vacancyId: req.params.id });
      res.status(500).json({ success: false, error: 'Failed to delete vacancy', details: msg });
    }
  }
}
