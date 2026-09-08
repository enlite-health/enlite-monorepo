import * as functions from 'firebase-functions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  PatientIdentityRepository,
  PatientIdentityUpsertInput,
} from '../infrastructure/PatientIdentityRepository';
import { PatientClinicalRepository } from '../infrastructure/PatientClinicalRepository';
import { PatientResponsibleRepository } from '../infrastructure/PatientResponsibleRepository';
import { GeocodingService } from '../../../infrastructure/services/GeocodingService';
import { validateContactChannel } from '../domain/PatientResponsible';
import { upsertPatientRelated, type PatientRelatedUpsertDeps } from './PatientRelatedUpsert';
import { createNativePatient } from './PatientNativeCreator';
import { inPatientTransaction, CaseNumberConflictRetry, rethrowAsCaseNumberRetry } from './patientTransaction';
import type { AttentionReason } from '../domain/enums/AttentionReason';
import type { PatientStatus } from '../domain/enums/PatientStatus';
import {
  movePatientStatus,
  type MoveStatusOptions,
} from './PatientStatusWriter';
import { PatientDeviceTypeRepository } from '../infrastructure/PatientDeviceTypeRepository';
import { PatientInsuranceVerifiedRepository } from '../infrastructure/PatientInsuranceVerifiedRepository';
import { PatientCoverageEmergencyContactRepository } from '../infrastructure/PatientCoverageEmergencyContactRepository';


// ── Contrato de escrita ───────────────────────────────────────────────────────
// Os inputs moram em `PatientWriteInputs.ts` (teto de 400 linhas). Re-exportados aqui para que
// este arquivo continue sendo a porta pública deles — `export type` some na compilação.
import type {
  MissingContactStrategy,
  UpsertFromClickUpOptions,
  PatientServiceUpsertInput,
  PatientRelatedInput,
  CreateNativePatientInput,
  CreateNativePatientOptions,
} from './PatientWriteInputs';
export type {
  MissingContactStrategy,
  UpsertFromClickUpOptions,
  PatientServiceUpsertInput,
  PatientRelatedInput,
  CreateNativePatientInput,
  CreateNativePatientOptions,
} from './PatientWriteInputs';

// ── Edição por seção ──────────────────────────────────────────────────────────
// A escrita por seção mora em `PatientSectionWriter.ts` (teto de 400 linhas). Os shapes são
// re-exportados aqui para que este arquivo continue sendo a porta pública deles.
import {
  writePatientSection,
  type PatientSection,
  type PatientClinicalSectionData,
  type PatientCoverageSectionData,
  type PatientGeneralSectionData,
} from './PatientSectionWriter';
export type {
  PatientSection,
  PatientClinicalSectionData,
  PatientCoverageSectionData,
  PatientGeneralSectionData,
} from './PatientSectionWriter';

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
  // Preguiçosos (spec 012): só a seção clínica/de cobertura do painel os usa, e construir o de
  // cobertura abre pool — as suítes que dublam o banco não precisam saber deles.
  private deviceTypeRepoMemo?: PatientDeviceTypeRepository;
  private insuranceRepoMemo?: PatientInsuranceVerifiedRepository;
  private coverageContactRepoMemo?: PatientCoverageEmergencyContactRepository;

  private get deviceTypeRepo(): PatientDeviceTypeRepository {
    this.deviceTypeRepoMemo ??= new PatientDeviceTypeRepository();
    return this.deviceTypeRepoMemo;
  }

  private get insuranceRepo(): PatientInsuranceVerifiedRepository {
    this.insuranceRepoMemo ??= new PatientInsuranceVerifiedRepository();
    return this.insuranceRepoMemo;
  }

  private get coverageContactRepo(): PatientCoverageEmergencyContactRepository {
    this.coverageContactRepoMemo ??= new PatientCoverageEmergencyContactRepository();
    return this.coverageContactRepoMemo;
  }

  /** As dependências que a escrita das coleções auxiliares precisa (`PatientRelatedWriter`). */
  private relatedDeps(): PatientRelatedUpsertDeps {
    return {
      clinicalRepo:    this.clinicalRepo,
      responsibleRepo: this.responsibleRepo,
      geocoder:        this.geocoder,
    };
  }

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
    try {
      return await inPatientTransaction(async (client) => {
        let patientId: string;
        let created: boolean;
        try {
          ({ id: patientId, created } = await this.identityRepo.upsert(identityInput, client));
        } catch (err) {
          rethrowAsCaseNumberRetry(err);
        }
        await upsertPatientRelated(this.relatedDeps(), patientId, input, client);
        return { id: patientId, created, flagged };
      });
    } catch (err) {
      if (err instanceof CaseNumberConflictRetry) {
        functions.logger.warn('patient_service.case_number_conflict_retry', {
          clickupTaskId:       input.clickupTaskId,
          rejectedCaseNumber:  input.caseNumber ?? null,
          correlationId:       cid,
        });
        return this.retryWithoutCaseNumber(identityInput, input);
      }
      throw err;
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

    return inPatientTransaction(async (client) => {
      const { id: patientId, created } = await this.identityRepo.upsert(safeIdentityInput, client);
      await upsertPatientRelated(this.relatedDeps(), patientId, input, client);
      return { id: patientId, created, flagged: true, conflict: 'CASE_NUMBER_CONFLICT' as const };
    });
  }

  /**
   * Cria um paciente NATIVO (lead do formulário ou criação manual do admin). A implementação
   * vive em `PatientNativeCreator` (teto de 400 linhas); este método continua sendo a PORTA
   * que o `CreatePatientUseCase` conhece.
   */
  async createNativePatient(
    input: CreateNativePatientInput,
    opts: CreateNativePatientOptions,
  ): Promise<{ id: string; created: true }> {
    return createNativePatient(
      {
        identityRepo:      this.identityRepo,
        encryptionService: this.encryptionService,
        related:           this.relatedDeps(),
      },
      input, opts,
    );
  }

  /**
   * Edição parcial por SEÇÃO (os drawers do painel). A implementação vive em
   * `PatientSectionWriter` (teto de 400 linhas); este método continua sendo a PORTA que o
   * controller conhece, e é aqui que as dependências — inclusive a PREGUIÇA dos repositórios
   * de dispositivo e cobertura — são montadas.
   */
  async updatePatientSection(
    patientId: string,
    section: PatientSection,
    data: PatientGeneralSectionData | PatientClinicalSectionData | PatientCoverageSectionData | PatientRelatedInput,
    /** Quem está editando: uid do staff (autoria) e as células (417: decide o que a seção cobertura preserva). */
    actor?: { uid: string; cells?: readonly string[] | null },
  ): Promise<{ id: string; updated: true }> {
    return writePatientSection(
      {
        clinicalRepo:      this.clinicalRepo,
        responsibleRepo:   this.responsibleRepo,
        encryptionService: this.encryptionService,
        deviceTypeRepo:    () => this.deviceTypeRepo,
        insuranceRepo:     () => this.insuranceRepo,
        coverageContactRepo: () => this.coverageContactRepo,
      },
      patientId, section, data, actor,
    );
  }

  /**
   * Move de estado — v2 (spec 012, US-B7). A implementação vive em `PatientStatusWriter`
   * (teto de 400 linhas); este método continua sendo a PORTA que o controller e o Kanban
   * conhecem, e é aqui que mora o `changeSource` padrão.
   */
  async moveStatus(
    patientId: string,
    status: PatientStatus,
    opts: MoveStatusOptions = { changeSource: 'admin_panel' },
  ): Promise<{ id: string; status: PatientStatus }> {
    return movePatientStatus(patientId, status, opts);
  }
}
