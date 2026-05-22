import * as functions from 'firebase-functions';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PatientIdentityRepository, PatientIdentityUpsertInput } from '../infrastructure/PatientIdentityRepository';
import { PatientClinicalRepository } from '../infrastructure/PatientClinicalRepository';
import { PatientResponsibleRepository } from '../infrastructure/PatientResponsibleRepository';
import { PatientHealthInsuranceRepository } from '../infrastructure/PatientHealthInsuranceRepository';
import { GeocodingService } from '../../../infrastructure/services/GeocodingService';
import {
  PatientResponsibleInput,
  validateContactChannel,
} from '../domain/PatientResponsible';
import { PatientAddress, PatientProfessional } from '../../../infrastructure/repositories/PatientRepository';
import { replacePatientAddresses, replacePatientProfessionals } from './PatientRelatedWriter';
import type { DependencyLevel } from '../domain/enums/DependencyLevel';
import type { ClinicalSpecialty } from '../domain/enums/ClinicalSpecialty';
import type { AttentionReason } from '../domain/enums/AttentionReason';
import type { Profession } from '../../worker/domain/enums/Profession';

/** Strategy for handling missing contact channel during upsert. */
export type MissingContactStrategy = 'error' | 'flag';

function isCaseNumberConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'patients_case_number_active_unique';
}

export interface UpsertFromClickUpOptions {
  /**
   * How to behave when the patient has no phone/email AND the primary
   * responsible also has none:
   *   - 'error' (default): throw (enforces invariant for manual creation UX)
   *   - 'flag':  persist with needs_attention=true + attentionReasons=['MISSING_INFO']
   *              (used by legacy bulk imports where ops will review & complete)
   */
  onMissingContact?: MissingContactStrategy;
  /** Propagated from the upstream event (webhook request-id or batch correlation). */
  correlationId?: string;
}

export interface PatientServiceUpsertInput extends PatientIdentityUpsertInput {
  // Clinical
  diagnosis?: string | null;
  dependencyLevel?: DependencyLevel | null;
  clinicalSpecialty?: ClinicalSpecialty | null;
  /** @deprecated Use clinicalSpecialty + serviceType instead. Preserved for backward compat. */
  clinicalSegments?: string | null;
  /** Array of professional roles the patient requires. Was string | null before migration 139. */
  serviceType?: Profession[] | null;
  deviceType?: string | null;
  additionalComments?: string | null;
  hasJudicialProtection?: boolean | null;
  hasCud?: boolean | null;
  hasConsent?: boolean | null;
  /**
   * Health insurance coverage sourced from ClickUp sync.
   * Persisted to patient_health_insurance (migration 184) within the transaction.
   * Fill-only semantics for providerName and memberId (COALESCE in repo).
   * plan and emergencyNumbers are NOT accepted here — those are UI-only (source='manual').
   * Skipped entirely when undefined or both providerName and memberId are falsy.
   */
  healthInsurance?: {
    providerName?: string | null;
    memberId?: string | null;
  };
  // Responsibles (replaces legacy responsible_* columns)
  responsibles?: PatientResponsibleInput[];
  // Related records (unchanged from existing PatientRepository contract)
  addresses?: PatientAddress[];
  professionals?: PatientProfessional[];
}

/**
 * PatientService — orchestrates Identity, Clinical, and Responsible repositories.
 * All writes happen inside a single Postgres transaction.
 * Enforces cross-domain invariants (e.g. contact channel validation).
 * Does NOT know about workers, job_postings, or any domain outside patient.
 */
export class PatientService {
  private identityRepo: PatientIdentityRepository;
  private clinicalRepo: PatientClinicalRepository;
  private responsibleRepo: PatientResponsibleRepository;
  private phiRepo: PatientHealthInsuranceRepository;
  private geocoder: GeocodingService;

  constructor(geocoder?: GeocodingService) {
    this.identityRepo    = new PatientIdentityRepository();
    this.clinicalRepo    = new PatientClinicalRepository();
    this.responsibleRepo = new PatientResponsibleRepository();
    this.phiRepo         = new PatientHealthInsuranceRepository();
    // Injected for tests; defaults to a real instance that no-ops when
    // GOOGLE_MAPS_API_KEY is missing (see GeocodingService.geocode).
    this.geocoder = geocoder ?? new GeocodingService();
  }

  /**
   * Upserts a patient from ClickUp data within a single Postgres transaction.
   * Replaces responsibles, addresses, and professionals when provided.
   *
   * Contact-channel invariant: when opts.onMissingContact='error' (default),
   * throws if neither patient nor primary responsible has phone/email.
   * When 'flag', persists the record with needs_attention=true +
   * attentionReasons=['MISSING_INFO'] for later operational review.
   */
  async upsertFromClickUp(
    input: PatientServiceUpsertInput,
    opts: UpsertFromClickUpOptions = {},
  ): Promise<{ id: string; created: boolean; flagged: boolean; conflict?: 'CASE_NUMBER_CONFLICT' }> {
    const cid     = opts.correlationId;
    const startMs = Date.now();

    functions.logger.info('patient_service.upsert.start', {
      clickupTaskId: input.clickupTaskId,
      caseNumber:    input.caseNumber ?? null,
      correlationId: cid,
    });

    const strategy: MissingContactStrategy = opts.onMissingContact ?? 'error';
    let flagged = false;
    const attentionReasons = new Set<AttentionReason>(input.attentionReasons ?? []);

    // Validate contact channel invariant before hitting the DB
    if (input.responsibles !== undefined) {
      const primary = input.responsibles.find(r => r.isPrimary);
      try {
        validateContactChannel({
          patientPhoneWhatsapp: input.phoneWhatsapp,
          primaryResponsible:   primary,
        });
      } catch (err) {
        if (strategy === 'flag') {
          flagged = true;
          attentionReasons.add('MISSING_INFO');
        } else {
          throw err;
        }
      }
    }

    const identityInput: PatientIdentityUpsertInput = {
      ...input,
      needsAttention:   (input.needsAttention ?? false) || flagged,
      attentionReasons: Array.from(attentionReasons),
    };

    try {
      const result = await this.runUpsertTransaction(identityInput, input, flagged, cid);

      if (result.conflict === 'CASE_NUMBER_CONFLICT') {
        return result;
      }

      functions.logger.info('patient_service.upsert.completed', {
        clickupTaskId: input.clickupTaskId,
        patientId:     result.id,
        created:       result.created,
        flagged,
        durationMs:    Date.now() - startMs,
        correlationId: cid,
      });

      return { id: result.id, created: result.created, flagged };
    } catch (err) {
      functions.logger.error('patient_service.upsert.failed', {
        clickupTaskId: input.clickupTaskId,
        error:         err instanceof Error ? err.message : String(err),
        stack:         err instanceof Error ? err.stack   : undefined,
        durationMs:    Date.now() - startMs,
        correlationId: cid,
      });
      throw err;
    }
  }

  private async runUpsertTransaction(
    identityInput: PatientIdentityUpsertInput,
    input: PatientServiceUpsertInput,
    flagged: boolean,
    cid: string | undefined,
  ): Promise<{ id: string; created: boolean; flagged: boolean; conflict?: 'CASE_NUMBER_CONFLICT' }> {
    const db     = DatabaseConnection.getInstance();
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      let patientId: string;
      let created: boolean;
      let conflict: 'CASE_NUMBER_CONFLICT' | undefined;

      try {
        ({ id: patientId, created } = await this.identityRepo.upsert(identityInput, client));
      } catch (err) {
        if (isCaseNumberConflict(err)) {
          // Constraint blocks the write — rollback this attempt and retry without case_number.
          await client.query('ROLLBACK');
          client.release();
          functions.logger.warn('patient_service.case_number_conflict_retry', {
            clickupTaskId:       input.clickupTaskId,
            rejectedCaseNumber:  input.caseNumber ?? null,
            correlationId:       cid,
          });
          return this.retryWithoutCaseNumber(identityInput, input);
        }
        throw err;
      }

      await this.upsertRelated(patientId, input, client);

      await client.query('COMMIT');
      return { id: patientId, created, flagged, conflict };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      // Only release if client hasn't been released already (conflict path releases early).
      try { client.release(); } catch { /* already released */ }
    }
  }

  private async retryWithoutCaseNumber(
    identityInput: PatientIdentityUpsertInput,
    input: PatientServiceUpsertInput,
  ): Promise<{ id: string; created: boolean; flagged: boolean; conflict: 'CASE_NUMBER_CONFLICT' }> {
    const attentionReasons = new Set<AttentionReason>(identityInput.attentionReasons ?? []);
    attentionReasons.add('CASE_NUMBER_CONFLICT');

    const safeIdentityInput: PatientIdentityUpsertInput = {
      ...identityInput,
      caseNumber:       null,
      needsAttention:   true,
      attentionReasons: Array.from(attentionReasons),
    };

    const db     = DatabaseConnection.getInstance();
    const client = await db.getClient();

    try {
      await client.query('BEGIN');
      const { id: patientId, created } = await this.identityRepo.upsert(safeIdentityInput, client);
      await this.upsertRelated(patientId, input, client);
      await client.query('COMMIT');
      return { id: patientId, created, flagged: true, conflict: 'CASE_NUMBER_CONFLICT' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsertRelated(
    patientId: string,
    input: PatientServiceUpsertInput,
    client: import('pg').PoolClient,
  ): Promise<void> {
    // Health insurance — only when provided and at least one field has a value
    if (
      input.healthInsurance !== undefined &&
      (input.healthInsurance.providerName || input.healthInsurance.memberId)
    ) {
      await this.phiRepo.upsert(
        {
          patientId,
          providerName: input.healthInsurance.providerName,
          memberId:     input.healthInsurance.memberId,
          source:       'clickup',
        },
        client,
      );
    }

    await this.clinicalRepo.upsert(
      {
        patientId,
        diagnosis:             input.diagnosis,
        dependencyLevel:       input.dependencyLevel,
        clinicalSpecialty:     input.clinicalSpecialty,
        clinicalSegments:      input.clinicalSegments,
        serviceType:           input.serviceType,
        deviceType:            input.deviceType,
        additionalComments:    input.additionalComments,
        hasJudicialProtection: input.hasJudicialProtection,
        hasCud:                input.hasCud,
        hasConsent:            input.hasConsent,
      },
      client,
    );

    if (input.responsibles !== undefined) {
      await this.responsibleRepo.replaceAll(patientId, input.responsibles, client);
    }

    if (input.addresses !== undefined) {
      await replacePatientAddresses(patientId, input.addresses, client, this.geocoder);
    }

    if (input.professionals !== undefined) {
      await replacePatientProfessionals(patientId, input.professionals, client);
    }
  }
}
