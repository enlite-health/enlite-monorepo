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
 */

import * as crypto from 'crypto';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
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
      total: 0, created: 0, updated: 0, skipped: 0, linked: 0, errors: [],
    };

    const talentumClient = await TalentumApiClient.create();
    const profiles = await talentumClient.listAllDashboardProfiles();
    report.total = profiles.length;
    console.log(`${TAG} Fetched ${profiles.length} profiles from Talentum dashboard`);

    for (const profile of profiles) {
      try {
        await this.processProfile(profile, report);
      } catch (err: any) {
        console.error(`${TAG} Error processing profile ${profile._id} (${profile.fullName}):`, err.message);
        report.errors.push({ profileId: profile._id, name: profile.fullName, error: err.message });
      }
    }

    console.log(
      `${TAG} Done: total=${report.total} created=${report.created} ` +
      `updated=${report.updated} skipped=${report.skipped} linked=${report.linked} ` +
      `errors=${report.errors.length}`,
    );
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
      const linked = await this.linkToCases(workerId, profile);
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
    } catch (err: any) {
      if (err.code === '23505') {
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

  private async linkToCases(workerId: string, profile: TalentumDashboardProfile): Promise<number> {
    let linked = 0;

    for (const project of profile.projects) {
      try {
        const caseNumber = this.extractCaseNumber(project.title);
        if (caseNumber == null) continue;

        const jp = await this.db.query(
          `SELECT id FROM job_postings WHERE case_number = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          [caseNumber],
        );
        if (!jp.rows[0]) continue;
        const jobPostingId = jp.rows[0].id;

        // worker_job_application — INSERT only if not exists, let DB default (INITIATED)
        // We don't set funnel stage because the dashboard status is per-profile, not per-case
        const wjaResult = await this.db.query(
          `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_status, source)
           VALUES ($1, $2, 'applied', 'talentum')
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
          `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, origen, dedup_hash)
           VALUES ($1, $2, $3, $4, 'Talentum', $5)
           ON CONFLICT (dedup_hash) DO UPDATE SET
             worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
          [workerId, jobPostingId, workerName, rawPhone, dedupHash],
        );

        if (wjaResult.rowCount && wjaResult.rowCount > 0) linked++;
      } catch (err: any) {
        console.warn(`${TAG} linkToCases: failed for project "${project.title}":`, err.message);
      }
    }

    return linked;
  }

  private extractCaseNumber(title: string): number | null {
    const match = title.match(/CASO\s+(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }
}
