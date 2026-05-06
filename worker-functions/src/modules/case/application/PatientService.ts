import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PatientIdentityRepository, PatientIdentityUpsertInput } from '../infrastructure/PatientIdentityRepository';
import { PatientClinicalRepository } from '../infrastructure/PatientClinicalRepository';
import { PatientResponsibleRepository } from '../infrastructure/PatientResponsibleRepository';
import { geocodePatientAddressesBestEffort } from '../infrastructure/geocodePatientAddresses';
import { GeocodingService } from '../../../infrastructure/services/GeocodingService';
import {
  PatientResponsibleInput,
  validateContactChannel,
} from '../domain/PatientResponsible';
import { PatientAddress, PatientProfessional } from '../../../infrastructure/repositories/PatientRepository';
import type { DependencyLevel } from '../domain/enums/DependencyLevel';
import type { ClinicalSpecialty } from '../domain/enums/ClinicalSpecialty';
import type { AttentionReason } from '../domain/enums/AttentionReason';
import type { Profession } from '../../worker/domain/enums/Profession';

/** Strategy for handling missing contact channel during upsert. */
export type MissingContactStrategy = 'error' | 'flag';

export interface UpsertFromClickUpOptions {
  /**
   * How to behave when the patient has no phone/email AND the primary
   * responsible also has none:
   *   - 'error' (default): throw (enforces invariant for manual creation UX)
   *   - 'flag':  persist with needs_attention=true + attentionReasons=['MISSING_INFO']
   *              (used by legacy bulk imports where ops will review & complete)
   */
  onMissingContact?: MissingContactStrategy;
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
   * Cobertura médica informada (ClickUp: "Cobertura Informada").
   * Fill-only: persisted via COALESCE(existing, $new). Migration 147.
   */
  healthInsuranceName?: string | null;
  /**
   * Número de ID de afiliado (ClickUp: "Número ID Afiliado Paciente").
   * Fill-only: persisted via COALESCE(existing, $new). Migration 147.
   */
  healthInsuranceMemberId?: string | null;
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
  private geocoder: GeocodingService;

  constructor(geocoder?: GeocodingService) {
    this.identityRepo   = new PatientIdentityRepository();
    this.clinicalRepo   = new PatientClinicalRepository();
    this.responsibleRepo = new PatientResponsibleRepository();
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
  ): Promise<{ id: string; created: boolean; flagged: boolean }> {
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
      needsAttention:        (input.needsAttention ?? false) || flagged,
      attentionReasons:      Array.from(attentionReasons),
      healthInsuranceName:   input.healthInsuranceName,
      healthInsuranceMemberId: input.healthInsuranceMemberId,
    };

    const db = DatabaseConnection.getInstance();
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 1. Upsert identity fields
      const { id: patientId, created } = await this.identityRepo.upsert(identityInput, client);

      // 2. Upsert clinical fields
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

      // 3. Replace responsibles if provided
      if (input.responsibles !== undefined) {
        await this.responsibleRepo.replaceAll(patientId, input.responsibles, client);
      }

      // 4. Replace addresses if provided (delegate to pool — ok inside same connection)
      if (input.addresses !== undefined) {
        await this.replaceAddresses(patientId, input.addresses, client);
      }

      // 5. Replace professionals if provided
      if (input.professionals !== undefined) {
        await this.replaceProfessionals(patientId, input.professionals, client);
      }

      await client.query('COMMIT');
      return { id: patientId, created, flagged };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Private helpers (mirrors PatientRepository for addresses/professionals) ──

  private async replaceAddresses(
    patientId: string,
    addresses: PatientAddress[],
    client: import('pg').PoolClient,
  ): Promise<void> {
    await client.query(
      'DELETE FROM patient_addresses WHERE patient_id = $1',
      [patientId],
    );

    const valid = addresses.filter(a => a.addressFormatted || a.addressRaw);
    if (valid.length === 0) return;

    // Best-effort geocoding — never blocks the upsert. Failures persist
    // lat/lng=NULL so the backfill job can recover them later.
    const geocoded = await geocodePatientAddressesBestEffort(valid, this.geocoder, {
      delayMs: 0,
      timeoutMs: 8000,
    });

    const values: unknown[] = [];
    const placeholders = geocoded.map((g, i) => {
      const base = i * 10;
      const a = g.address;
      values.push(
        patientId,
        a.addressType,
        a.addressFormatted ?? null,
        a.addressRaw ?? null,
        a.displayOrder,
        a.state ?? null,
        a.city ?? null,
        a.neighborhood ?? null,
        g.lat,
        g.lng,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
    });

    await client.query(
      `INSERT INTO patient_addresses
         (patient_id, address_type, address_formatted, address_raw, display_order, state, city, neighborhood, lat, lng)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  private async replaceProfessionals(
    patientId: string,
    professionals: PatientProfessional[],
    client: import('pg').PoolClient,
  ): Promise<void> {
    const { KMSEncryptionService } = await import('@shared/security/KMSEncryptionService');
    const encryptionService = new KMSEncryptionService();

    await client.query(
      'DELETE FROM patient_professionals WHERE patient_id = $1',
      [patientId],
    );

    const valid = professionals.filter(p => p.name?.trim());
    if (valid.length === 0) return;

    const encrypted = await Promise.all(
      valid.map(async p => ({
        phoneEnc: await encryptionService.encrypt(p.phone ?? null),
        emailEnc: await encryptionService.encrypt(p.email ?? null),
      })),
    );

    const values: unknown[] = [];
    const placeholders = valid.map((p, i) => {
      const base = i * 6;
      values.push(patientId, p.name, encrypted[i].phoneEnc, encrypted[i].emailEnc, p.displayOrder, p.isTeam ?? false);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    await client.query(
      `INSERT INTO patient_professionals (patient_id, name, phone_encrypted, email_encrypted, display_order, is_team)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
}
