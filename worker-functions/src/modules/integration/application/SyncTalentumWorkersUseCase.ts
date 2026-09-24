/**
 * SyncTalentumWorkersUseCase
 *
 * Fetches all candidate profiles from the Talentum dashboard API and
 * upserts them into the Enlite workers table. Designed to compensate
 * for webhook failures — fills MISSING data only, never overwrites.
 *
 * Flow per profile:
 *   1. Lookup existing worker by email → phone → auth_uid
 *   2. If not found → create with INCOMPLETE_REGISTER status
 *   3. If found → fill NULL/empty fields (name, phone)
 *   4. Link to job_postings via case_number extracted from project titles
 *
 * application_funnel_stage is set to INVITED for new rows (worker detected in Talentum
 * dashboard project, but no evidence of WhatsApp entry yet). The canonical upgrade to
 * INITIATED+ is exclusive to the PRESCREENING_RESPONSE webhook.
 * ON CONFLICT DO NOTHING: webhook-set stage is preserved for existing rows.
 *
 * TD-035 (simplified): StageDecider removed — see docs/FOLLOWUPS.md
 */

import * as crypto from 'crypto';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import { logger, safeErrorFields } from '@shared/logging';
import { parseCaseTitleReference } from '@shared/utils/parseCaseTitleReference';
import type { TalentumDashboardProfile } from '../domain/ITalentumApiClient';

const TAG = '[SyncTalentumWorkers]';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface WorkerSyncReport {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  linked: number;
  /** Workers cujo linkToCases foi pulado porque status != REGISTERED (cadastro/docs incompletos) */
  skippedIncompleteRegistration: number;
  /**
   * T064 — projetos cujo título não casou NENHUM formato conhecido de referência de
   * caso (nem "CASO N[-M]" legado, nem "EN N#M" / "N#M" novo — ver `parseCaseTitleReference`).
   * Antes desse contador, esse `continue` era silencioso: a régua de sucesso do sync não
   * acusava título desconhecido, só quem lesse o log linha a linha percebia.
   */
  skippedUnknownTitleFormat: number;
  errors: Array<{ profileId: string; name: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class SyncTalentumWorkersUseCase {
  private db: Pool;
  private encryptionService: KMSEncryptionService;
  private blindIndexService: BlindIndexService;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
  }

  async execute(): Promise<WorkerSyncReport> {
    const report: WorkerSyncReport = {
      total: 0, created: 0, updated: 0, skipped: 0, linked: 0,
      skippedIncompleteRegistration: 0, skippedUnknownTitleFormat: 0, errors: [],
    };

    const talentumClient = await TalentumApiClient.create();
    const profiles = await talentumClient.listAllDashboardProfiles();
    report.total = profiles.length;
    logger.info({ msg: `${TAG} Fetched ${profiles.length} profiles from Talentum dashboard` });

    for (const profile of profiles) {
      try {
        await this.processProfile(profile, report);
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        // PII: nunca o nome no log — profile._id já é o id estável pra achar o registro;
        // `error`/`stack` do erro cru também não (podem carregar valor) — só errorName+SQLSTATE.
        logger.error({ msg: `${TAG} Error processing profile ${profile._id}`, ...safeErrorFields(err) });
        report.errors.push({ profileId: profile._id, name: profile.fullName, error: e.message });
      }
    }

    logger.info({
      msg: `${TAG} Done`,
      total: report.total, created: report.created,
      updated: report.updated, skipped: report.skipped, linked: report.linked,
      skippedIncompleteRegistration: report.skippedIncompleteRegistration,
      skippedUnknownTitleFormat: report.skippedUnknownTitleFormat,
      errors: report.errors.length,
    });
    return report;
  }

  // ── Profile processing ───────────────────────────────────────────

  private async processProfile(profile: TalentumDashboardProfile, report: WorkerSyncReport): Promise<void> {
    const email = profile.emails?.[0]?.value?.toLowerCase().trim() || null;
    const rawPhone = profile.phoneNumbers?.[0]?.value || null;
    const phone = rawPhone ? normalizePhoneAR(rawPhone) || null : null;

    if (!email && !phone) {
      report.skipped++;
      return;
    }

    const existingId = await this.findExistingWorker(email, phone, profile._id);

    if (existingId) {
      const didUpdate = await this.fillMissingData(existingId, profile, email, phone);
      if (didUpdate) { report.updated++; } else { report.skipped++; }
    } else {
      await this.createWorker(profile, email, phone);
      report.created++;
    }

    const workerId = existingId ?? await this.findExistingWorker(email, phone, profile._id);
    if (workerId && profile.projects?.length) {
      const linked = await this.linkToCases(workerId, profile, report);
      report.linked += linked;
    }
  }

  // ── Worker lookup ────────────────────────────────────────────────

  private async findExistingWorker(
    email: string | null, phone: string | null, talentumId: string,
  ): Promise<string | null> {
    if (email) {
      const r = await this.db.query('SELECT id FROM workers WHERE LOWER(email) = LOWER($1) AND merged_into_id IS NULL LIMIT 1', [email]);
      if (r.rows[0]) return r.rows[0].id;
    }
    if (phone) {
      const candidates = generatePhoneCandidates(phone);
      if (candidates.length > 0) {
        const r = await this.db.query(
          'SELECT id FROM workers WHERE phone = ANY($1::text[]) AND merged_into_id IS NULL LIMIT 1',
          [candidates],
        );
        if (r.rows[0]) return r.rows[0].id;
      }
    }
    const authUid = `talentum_${talentumId}`;
    const r = await this.db.query('SELECT id FROM workers WHERE auth_uid = $1 AND merged_into_id IS NULL LIMIT 1', [authUid]);
    return r.rows[0]?.id ?? null;
  }

  // ── Worker creation ──────────────────────────────────────────────

  private async createWorker(
    profile: TalentumDashboardProfile, email: string | null, phone: string | null,
  ): Promise<string> {
    const authUid = `talentum_${profile._id}`;
    const firstName = profile.firstName?.trim() || null;
    const lastName = profile.lastName?.trim() || null;

    const [firstNameEnc, lastNameEnc, nameBidxBuffers] = await Promise.all([
      firstName ? this.encryptionService.encrypt(firstName) : Promise.resolve(null),
      lastName ? this.encryptionService.encrypt(lastName) : Promise.resolve(null),
      this.blindIndexService.generateNameTrigramBidx(firstName, lastName),
    ]);
    const nameBidxLiteral = this.blindIndexService.serializeForPg(nameBidxBuffers);

    try {
      const result = await this.db.query(
        `INSERT INTO workers (auth_uid, email, phone, first_name_encrypted, last_name_encrypted, name_trgm_bidx, status, country)
         VALUES ($1, $2, $3, $4, $5, $6::bytea[], 'INCOMPLETE_REGISTER', 'AR')
         RETURNING id`,
        [authUid, email, phone, firstNameEnc, lastNameEnc, nameBidxLiteral],
      );
      return result.rows[0].id;
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if ((e as NodeJS.ErrnoException & { code?: string }).code === '23505') {
        // Unique violation — race condition, worker was created concurrently
        const existing = await this.db.query(
          'SELECT id FROM workers WHERE auth_uid = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
          [authUid, email],
        );
        if (existing.rows[0]) return existing.rows[0].id;
      }
      throw err;
    }
  }

  // ── Fill missing data ────────────────────────────────────────────

  private async fillMissingData(
    workerId: string, profile: TalentumDashboardProfile,
    email: string | null, phone: string | null,
  ): Promise<boolean> {
    // Read current state to decide what's missing
    const current = await this.db.query(
      `SELECT email, phone, first_name_encrypted, last_name_encrypted, auth_uid
       FROM workers WHERE id = $1`,
      [workerId],
    );
    const row = current.rows[0];
    if (!row) return false;

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    // Email — fill only if missing
    if (!row.email && email) {
      updates.push(`email = $${paramIdx++}`);
      values.push(email);
    }

    // Phone — fill only if missing
    if (!row.phone && phone) {
      updates.push(`phone = $${paramIdx++}`);
      values.push(phone);
    }

    // First name — fill only if missing/empty
    const firstName = profile.firstName?.trim() || null;
    const fillFirstName = (!row.first_name_encrypted || row.first_name_encrypted === '') && firstName !== null;
    if (fillFirstName) {
      const enc = await this.encryptionService.encrypt(firstName);
      updates.push(`first_name_encrypted = $${paramIdx++}`);
      values.push(enc);
    }

    // Last name — fill only if missing/empty
    const lastName = profile.lastName?.trim() || null;
    const fillLastName = (!row.last_name_encrypted || row.last_name_encrypted === '') && lastName !== null;
    if (fillLastName) {
      const enc = await this.encryptionService.encrypt(lastName);
      updates.push(`last_name_encrypted = $${paramIdx++}`);
      values.push(enc);
    }

    // Blind index: recalculate if either name is being written
    if (fillFirstName || fillLastName) {
      const [currentFirstName, currentLastName] = await Promise.all([
        row.first_name_encrypted
          ? this.encryptionService.decrypt(row.first_name_encrypted)
          : Promise.resolve(null),
        row.last_name_encrypted
          ? this.encryptionService.decrypt(row.last_name_encrypted)
          : Promise.resolve(null),
      ]);
      const finalFirstName = fillFirstName ? firstName : (currentFirstName ?? null);
      const finalLastName  = fillLastName  ? lastName  : (currentLastName  ?? null);
      const bidxBuffers = await this.blindIndexService.generateNameTrigramBidx(finalFirstName, finalLastName);
      const bidxLiteral = this.blindIndexService.serializeForPg(bidxBuffers);
      updates.push(`name_trgm_bidx = $${paramIdx++}::bytea[]`);
      values.push(bidxLiteral);
    }

    // auth_uid — fill if missing (worker was created from import, not Talentum)
    if (!row.auth_uid || !row.auth_uid.startsWith('talentum_')) {
      // Only set if it doesn't already have a real Firebase auth_uid
      if (!row.auth_uid) {
        updates.push(`auth_uid = $${paramIdx++}`);
        values.push(`talentum_${profile._id}`);
      }
    }

    if (updates.length === 0) return false;

    updates.push(`updated_at = NOW()`);
    values.push(workerId);
    await this.db.query(
      `UPDATE workers SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values,
    );
    return true;
  }

  // ── Case linking ─────────────────────────────────────────────────

  /**
   * Ensures WJA + encuadre bond for each (worker, project) pair.
   *
   * Sync sets application_funnel_stage = INVITED for new rows (worker detected in
   * Talentum dashboard, no evidence of WhatsApp entry yet). The canonical upgrade to
   * INITIATED+ is exclusive to the PRESCREENING_RESPONSE webhook.
   *
   * WJA INSERT uses ON CONFLICT DO NOTHING:
   *   - New row → INVITED (explicit, no default dependency)
   *   - Existing row → no mutation (webhook-set stage preserved)
   *
   * profile.status (global per-worker, not per-encuadre) is intentionally ignored.
   */
  private async linkToCases(
    workerId: string, profile: TalentumDashboardProfile, report: WorkerSyncReport,
  ): Promise<number> {
    let linked = 0;

    // Worker precisa estar com cadastro + documentos completos (status='REGISTERED')
    // pra ser linkado a casos. Sync de Talentum não cria application pra worker incompleto.
    const statusRow = await this.db.query<{ status: string }>(
      'SELECT status FROM workers WHERE id = $1',
      [workerId],
    );
    const workerStatus = statusRow.rows[0]?.status ?? null;
    if (workerStatus !== 'REGISTERED') {
      report.skippedIncompleteRegistration++;
      logger.warn({ msg: `${TAG} linkToCases: skipping worker`, workerId, workerStatus, reason: 'registration/documents incomplete' });
      return 0;
    }

    for (const project of profile.projects) {
      try {
        // T063: parser compartilhado — tolera "CASO N[-M]" (legado) e "EN N#M" / "N#M" (novo).
        const { caseNumber } = parseCaseTitleReference(project.title);
        if (caseNumber == null) {
          // T064: antes este continue era silencioso — a régua de sucesso do sync
          // não acusava título desconhecido em lugar nenhum.
          report.skippedUnknownTitleFormat++;
          continue;
        }

        const jp = await this.db.query(
          `SELECT id FROM job_postings WHERE case_number = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          [caseNumber],
        );
        if (!jp.rows[0]) continue;
        const jobPostingId: string = jp.rows[0].id;

        // Ensure WJA exists. Sync detected this worker is enrolled in a project on the
        // Talentum dashboard — apenas o vínculo, sem garantia de que entrou no WhatsApp.
        // Stage = INVITED. ON CONFLICT DO NOTHING: webhook canônico (INITIATED+) preserva.
        // F7.c (ADR-004): application_status removido.
        const wjaResult = await this.db.query(
          `INSERT INTO worker_job_applications
             (worker_id, job_posting_id, application_funnel_stage, source)
           VALUES ($1, $2, 'INVITED', 'talentum')
           ON CONFLICT (worker_id, job_posting_id) DO NOTHING
           RETURNING id`,
          [workerId, jobPostingId],
        );

        // encuadre — idempotent via dedup_hash
        const workerName = profile.fullName || `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim();
        const rawPhone = profile.phoneNumbers?.[0]?.value || null;
        const dedupHash = crypto.createHash('md5')
          .update(`dashboard|${profile._id}|${caseNumber}`)
          .digest('hex');

        await this.db.query(
          `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
           VALUES ($1, $2, $3, $4, 'Talentum', $5)
           ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
             worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
          [workerId, jobPostingId, workerName, rawPhone, dedupHash],
        );

        logger.info({ msg: `${TAG} ensured WJA + encuadre bond`, workerId, jobPostingId, caseNumber });

        if (wjaResult.rowCount && wjaResult.rowCount > 0) linked++;
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        logger.warn({ msg: `${TAG} linkToCases: failed for project`, title: project.title, error: e.message });
      }
    }

    return linked;
  }
}
