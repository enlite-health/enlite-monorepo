import * as functions from 'firebase-functions';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  PatientIdentityRepository,
  PatientIdentityUpsertInput,
  PatientIdentityNativeInsertInput,
  NativePatientOrigin,
} from '../infrastructure/PatientIdentityRepository';
import { PatientClinicalRepository } from '../infrastructure/PatientClinicalRepository';
import { PatientResponsibleRepository } from '../infrastructure/PatientResponsibleRepository';
import { GeocodingService } from '../../../infrastructure/services/GeocodingService';
import {
  PatientResponsibleInput,
  validateContactChannel,
} from '../domain/PatientResponsible';
import { PatientAddress, PatientProfessional } from '../../../infrastructure/repositories/PatientRepository';
import { replacePatientAddresses, replacePatientProfessionals } from './PatientRelatedWriter';
import type { DependencyLevel } from '../domain/enums/DependencyLevel';
import type { PatientSourceLabelsRead } from '../infrastructure/PatientSourceLabelRepository';
import type { ClinicalSpecialty } from '../domain/enums/ClinicalSpecialty';
import type { AttentionReason } from '../domain/enums/AttentionReason';
import type { Profession } from '../../worker/domain/enums/Profession';
import { isPatientStatus, type PatientStatus } from '../domain/enums/PatientStatus';
import type { AdmissionCountry } from '../../matching/domain/admissionCountries';

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
  /**
   * A leitura da origem foi POSSÍVEL? `false` ⇒ `clinical_specialty` não é tocada no banco.
   * `null` com `true` é vazio legítimo e É gravado (D-E). Ver `PatientClinicalRepository`.
   */
  clinicalSpecialtyReadable?: boolean;
  /**
   * Task 3.2/3.3 — `Cobertura Verificada`, que o mapper nunca leu (F7): 345 de 349 pacientes
   * têm cobertura no ClickUp e o nosso banco tem ZERO.
   *
   * `insuranceVerified` (escalar) continua sendo o 1º rótulo, para quem já lê a coluna antiga.
   * `insuranceVerifiedLabels` é a lista inteira, destinada à tabela `patient_insurance_verified`.
   * `insuranceVerifiedReadable` é a MESMA distinção da D167 aplicada aqui: `null` com
   * `readable:true` é "a origem não marcou nada" e É gravado; `readable:false` é "não consegui
   * ler" e não escreve nada.
   */
  insuranceVerifiedReadable?: boolean;
  insuranceVerifiedLabels?: PatientSourceLabelsRead;
  /** @deprecated Use clinicalSpecialty + serviceType instead. Preserved for backward compat. */
  clinicalSegments?: string | null;
  /** Array of professional roles the patient requires. Was string | null before migration 139. */
  serviceType?: Profession[] | null;
  deviceType?: string | null;
  additionalComments?: string | null;
  emergencyInstructions?: string | null;
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
 * The auxiliary collections + clinical block attached to a patient, shared by
 * both the ClickUp upsert path and the native create path. Extracted so
 * upsertRelated can serve both without depending on clickupTaskId.
 */
export type PatientRelatedInput = Pick<
  PatientServiceUpsertInput,
  | 'diagnosis'
  | 'dependencyLevel'
  | 'clinicalSpecialty'
  | 'clinicalSegments'
  | 'serviceType'
  | 'deviceType'
  | 'additionalComments'
  | 'emergencyInstructions'
  | 'hasJudicialProtection'
  | 'hasCud'
  | 'hasConsent'
  | 'responsibles'
  | 'addresses'
  | 'professionals'
>;

/**
 * Input for native patient creation (migration 251). Same shape as the ClickUp
 * upsert input but WITHOUT clickupTaskId (native rows have none) — origin,
 * status and contactEmail are supplied via the `opts` arg, not here.
 * `country` required & narrowed — see publicLeadSchema (D108).
 */
export type CreateNativePatientInput = Omit<PatientServiceUpsertInput, 'clickupTaskId'> & {
  country: AdmissionCountry;
};

export interface CreateNativePatientOptions {
  origin: NativePatientOrigin;         // 'web_form' | 'admin_manual'
  status: PatientStatus;               // set directly — no vacancyStatusMap
  /** Plaintext contact email; encrypted with KMS before storage. */
  contactEmail?: string;
}

/** Section-scoped partial update of a native (or any) patient. */
export type PatientSection = 'general' | 'clinical' | 'support-network' | 'service';

/** Identity fields updatable via the 'general' section. */
export interface PatientGeneralSectionData {
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: Date | null;
  documentType?: PatientServiceUpsertInput['documentType'];
  documentNumber?: string | null;
  affiliateId?: string | null;
  sex?: PatientServiceUpsertInput['sex'];
  phoneWhatsapp?: string | null;
  healthInsuranceName?: string | null;
  healthInsuranceMemberId?: string | null;
  /** Plaintext; encrypted with KMS before storage. */
  contactEmail?: string | null;
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
  private encryptionService: KMSEncryptionService;

  constructor(geocoder?: GeocodingService) {
    this.identityRepo    = new PatientIdentityRepository();
    this.clinicalRepo    = new PatientClinicalRepository();
    this.responsibleRepo = new PatientResponsibleRepository();
    // Same KMS mechanism the responsibles use (email_encrypted). Passthrough
    // (base64) in test/local when USE_KMS_ENCRYPTION=false or NODE_ENV=test.
    this.encryptionService = new KMSEncryptionService();
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
      needsAttention:          (input.needsAttention ?? false) || flagged,
      attentionReasons:        Array.from(attentionReasons),
      healthInsuranceName:     input.healthInsuranceName,
      healthInsuranceMemberId: input.healthInsuranceMemberId,
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
    // identityInput.attentionReasons vem SEMPRE preenchido (Array.from acima); Set aceita undefined.
    const attentionReasons = new Set<AttentionReason>(identityInput.attentionReasons);
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
    input: PatientRelatedInput,
    client: import('pg').PoolClient,
  ): Promise<void> {
    await this.clinicalRepo.upsert(
      {
        patientId,
        diagnosis:             input.diagnosis,
        dependencyLevel:       input.dependencyLevel,
        clinicalSpecialty:     input.clinicalSpecialty,
        clinicalSpecialtyReadable: input.clinicalSpecialtyReadable,
        clinicalSegments:      input.clinicalSegments,
        serviceType:           input.serviceType,
        deviceType:            input.deviceType,
        additionalComments:    input.additionalComments,
        emergencyInstructions: input.emergencyInstructions,
        hasJudicialProtection: input.hasJudicialProtection,
        hasCud:                input.hasCud,
        hasConsent:            input.hasConsent,
      },
      client,
    );

    if (input.responsibles !== undefined) {
      // SYNC/criação: substitui SÓ as linhas 'clickup'. Familiar do painel
      // ('admin_manual') ou do formulário ('web_form') sobrevive ao próximo
      // taskUpdated — o mapper devolve [] e o replaceAll apagava tudo (QA 🔴1).
      // O drawer (updatePatientSection 'support-network') continua replaceAll.
      await this.responsibleRepo.replaceBySource(patientId, input.responsibles, 'clickup', client);
    }

    if (input.addresses !== undefined) {
      await replacePatientAddresses(patientId, input.addresses, client, this.geocoder);
    }

    if (input.professionals !== undefined) {
      await replacePatientProfessionals(patientId, input.professionals, client);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NATIVE write path (migration 251) — patient born inside Enlite, not synced
  // from ClickUp. Separate from upsertFromClickUp: inserts clickup_task_id NULL,
  // origin != 'clickup', status set directly (no vacancyStatusMap), no ON
  // CONFLICT. Enlite is the source of truth for these rows (decisão D2/D7).
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates a native patient (web-form lead or manual admin creation) inside a
   * single Postgres transaction. Reuses the contact-channel validation, the
   * case_number conflict handling, the KMS encryption of the responsibles, and
   * upsertRelated for clinical/responsibles/addresses/professionals.
   */
  async createNativePatient(
    input: CreateNativePatientInput,
    opts: CreateNativePatientOptions,
  ): Promise<{ id: string; created: true }> {
    // Contact-channel invariant (same validator as the ClickUp path). A native
    // patient's own contact email (new column, migration 251) is ALSO a valid
    // channel, so skip the responsible/phone check when it's present.
    const primary = input.responsibles?.find(r => r.isPrimary);
    if (!opts.contactEmail?.trim()) {
      validateContactChannel({
        patientPhoneWhatsapp: input.phoneWhatsapp,
        primaryResponsible:   primary,
      });
    }

    // Encrypt the contact email with the SAME KMSEncryptionService the
    // responsibles use for email_encrypted (base64 ciphertext, null when empty).
    const contactEmailEncrypted = await this.encryptionService.encrypt(opts.contactEmail ?? null);

    const nativeInput: PatientIdentityNativeInsertInput = {
      origin:                  opts.origin,
      status:                  opts.status,
      contactEmailEncrypted,
      firstName:               input.firstName,
      lastName:                input.lastName,
      birthDate:               input.birthDate,
      documentType:            input.documentType,
      documentNumber:          input.documentNumber,
      affiliateId:             input.affiliateId,
      sex:                     input.sex,
      phoneWhatsapp:           input.phoneWhatsapp,
      insuranceInformed:       input.insuranceInformed,
      insuranceVerified:       input.insuranceVerified,
      cityLocality:            input.cityLocality,
      province:                input.province,
      zoneNeighborhood:        input.zoneNeighborhood,
      country:                 input.country,
      needsAttention:          input.needsAttention,
      attentionReasons:        input.attentionReasons,
      healthInsuranceName:     input.healthInsuranceName,
      healthInsuranceMemberId: input.healthInsuranceMemberId,
      caseNumber:              input.caseNumber,
    };

    return this.runNativeCreateTransaction(nativeInput, input);
  }

  private async runNativeCreateTransaction(
    nativeInput: PatientIdentityNativeInsertInput,
    related: PatientRelatedInput,
  ): Promise<{ id: string; created: true }> {
    const db     = DatabaseConnection.getInstance();
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      let patientId: string;
      try {
        ({ id: patientId } = await this.identityRepo.insertNative(nativeInput, client));
      } catch (err) {
        if (isCaseNumberConflict(err)) {
          // Same conflict handling as the ClickUp path: rollback and retry
          // without case_number, flagging the row for operational review.
          await client.query('ROLLBACK');
          client.release();
          functions.logger.warn('patient_service.native_case_number_conflict_retry', {
            origin:             nativeInput.origin,
            rejectedCaseNumber: nativeInput.caseNumber ?? null,
          });
          return this.retryNativeWithoutCaseNumber(nativeInput, related);
        }
        throw err;
      }

      await this.upsertRelated(patientId, related, client);

      await client.query('COMMIT');
      return { id: patientId, created: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      try { client.release(); } catch { /* already released on conflict path */ }
    }
  }

  private async retryNativeWithoutCaseNumber(
    nativeInput: PatientIdentityNativeInsertInput,
    related: PatientRelatedInput,
  ): Promise<{ id: string; created: true }> {
    const attentionReasons = new Set<AttentionReason>(nativeInput.attentionReasons ?? []);
    attentionReasons.add('CASE_NUMBER_CONFLICT');

    const safeInput: PatientIdentityNativeInsertInput = {
      ...nativeInput,
      caseNumber:       null,
      needsAttention:   true,
      attentionReasons: Array.from(attentionReasons),
    };

    const db     = DatabaseConnection.getInstance();
    const client = await db.getClient();

    try {
      await client.query('BEGIN');
      const { id: patientId } = await this.identityRepo.insertNative(safeInput, client);
      await this.upsertRelated(patientId, related, client);
      await client.query('COMMIT');
      return { id: patientId, created: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Partial, section-scoped update of a patient (native or ClickUp-origin).
   *   - general:         identity fields (name, doc, phone, contact email…)
   *   - clinical:        the full PatientClinical block (reuses clinicalRepo)
   *   - support-network: responsibles (replaceAll — a lista inteira, é a intenção da tela)
   *   - service:         just service_type (targeted UPDATE — does NOT clobber
   *                      the rest of the clinical block)
   * Does NOT touch `origin`. Runs in a single transaction.
   */
  async updatePatientSection(
    patientId: string,
    section: PatientSection,
    data: PatientGeneralSectionData | PatientRelatedInput,
    /** Quem está editando (uid do staff) — hoje só a seção clínica usa (autoria de additional_comments). */
    actor?: { uid: string },
  ): Promise<{ id: string; updated: true }> {
    const db     = DatabaseConnection.getInstance();
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      switch (section) {
        case 'general':
          await this.updateGeneralSection(patientId, data as PatientGeneralSectionData, client);
          break;
        case 'clinical': {
          const c = data as PatientRelatedInput;
          await this.clinicalRepo.upsert(
            {
              patientId,
              diagnosis:             c.diagnosis,
              dependencyLevel:       c.dependencyLevel,
              clinicalSpecialty:     c.clinicalSpecialty,
              clinicalSegments:      c.clinicalSegments,
              serviceType:           c.serviceType,
              deviceType:            c.deviceType,
              additionalComments:    c.additionalComments,
              emergencyInstructions: c.emergencyInstructions,
              hasJudicialProtection: c.hasJudicialProtection,
              hasCud:                c.hasCud,
              hasConsent:            c.hasConsent,
              actorUid:              actor?.uid ?? null,
            },
            client,
          );
          break;
        }
        case 'support-network': {
          const responsibles = (data as PatientRelatedInput).responsibles ?? [];
          await this.responsibleRepo.replaceAll(patientId, responsibles, client);
          break;
        }
        case 'service': {
          // Targeted: only service_type. (Desde a D211.1 o clinicalRepo.upsert é
          // parcial — chave ausente não toca a coluna — mas este caminho
          // continua direto: uma coluna, uma query.)
          const serviceType = (data as PatientRelatedInput).serviceType;
          const value =
            serviceType !== undefined && serviceType !== null && serviceType.length > 0
              ? serviceType
              : null;
          await client.query(
            'UPDATE patients SET service_type = $2, updated_at = NOW() WHERE id = $1',
            [patientId, value],
          );
          break;
        }
      }

      await client.query('COMMIT');
      return { id: patientId, updated: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async updateGeneralSection(
    patientId: string,
    data: PatientGeneralSectionData,
    client: import('pg').PoolClient,
  ): Promise<void> {
    // Column whitelist — partial update: only columns present in `data` are set.
    const columnByKey: Record<string, string> = {
      firstName:               'first_name',
      lastName:                'last_name',
      birthDate:               'birth_date',
      documentType:            'document_type',
      documentNumber:          'document_number',
      affiliateId:             'affiliate_id',
      sex:                     'sex',
      phoneWhatsapp:           'phone_whatsapp',
      healthInsuranceName:     'health_insurance_name',
      healthInsuranceMemberId: 'health_insurance_member_id',
    };

    const sets: string[] = [];
    const values: unknown[] = [patientId];

    for (const [key, column] of Object.entries(columnByKey)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        values.push((data as Record<string, unknown>)[key] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }

    // Contact email is encrypted (KMS) before storage, like the responsibles.
    if (Object.prototype.hasOwnProperty.call(data, 'contactEmail')) {
      const enc = await this.encryptionService.encrypt(data.contactEmail ?? null);
      values.push(enc);
      sets.push(`contact_email_encrypted = $${values.length}`);
    }

    if (sets.length === 0) return; // nothing to update

    sets.push('updated_at = NOW()');
    await client.query(
      `UPDATE patients SET ${sets.join(', ')} WHERE id = $1`,
      values,
    );
  }

  /**
   * Moves a patient to a new lifecycle status. Validates the value is a known
   * PatientStatus. Never touches `origin` (a native patient stays native).
   */
  async moveStatus(
    patientId: string,
    status: PatientStatus,
  ): Promise<{ id: string; status: PatientStatus }> {
    if (!isPatientStatus(status)) {
      throw new Error(`Invalid patient status: ${String(status)}`);
    }

    const db     = DatabaseConnection.getInstance();
    const client = await db.getClient();

    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string }>(
        'UPDATE patients SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id',
        [patientId, status],
      );
      if ((res.rowCount ?? 0) === 0) {
        throw new Error(`Patient not found: ${patientId}`);
      }
      await client.query('COMMIT');
      return { id: patientId, status };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
