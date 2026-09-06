import * as functions from 'firebase-functions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  PatientIdentityRepository,
  PatientIdentityNativeInsertInput,
} from '../infrastructure/PatientIdentityRepository';
import { validateContactChannel } from '../domain/PatientResponsible';
import { AttentionReason } from '../domain/enums/AttentionReason';
import { upsertPatientRelated, type PatientRelatedUpsertDeps } from './PatientRelatedUpsert';
import { inPatientTransaction, CaseNumberConflictRetry, rethrowAsCaseNumberRetry } from './patientTransaction';
import type {
  CreateNativePatientInput,
  CreateNativePatientOptions,
  PatientRelatedInput,
} from './PatientWriteInputs';

/**
 * PatientNativeCreator — o caminho de escrita do paciente NASCIDO na Enlite.
 *
 * Extraído de `PatientService` para manter aquele arquivo dentro do teto de 400 linhas — mesmo
 * molde de `PatientRelatedWriter`. O corte já estava DESENHADO no arquivo antigo: o banner
 * abaixo, preservado palavra por palavra, é o que separava as duas metades.
 *
 * `PatientService.createNativePatient` continua sendo a porta (é ela que o
 * `CreatePatientUseCase` conhece) e é ela que monta as dependências.
 */

/** O que a criação nativa precisa do serviço. */
export interface PatientNativeCreatorDeps {
  identityRepo: PatientIdentityRepository;
  encryptionService: KMSEncryptionService;
  related: PatientRelatedUpsertDeps;
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
export async function createNativePatient(
  deps: PatientNativeCreatorDeps,
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
  const contactEmailEncrypted = await deps.encryptionService.encrypt(opts.contactEmail ?? null);

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

  return runNativeCreateTransaction(deps, nativeInput, input);
}

async function runNativeCreateTransaction(
  deps: PatientNativeCreatorDeps,
  nativeInput: PatientIdentityNativeInsertInput,
  related: PatientRelatedInput,
): Promise<{ id: string; created: true }> {
  try {
    return await inPatientTransaction(async (client) => {
      let patientId: string;
      try {
        ({ id: patientId } = await deps.identityRepo.insertNative(nativeInput, client));
      } catch (err) {
        // Same conflict handling as the ClickUp path: abort and retry without
        // case_number, flagging the row for operational review.
        rethrowAsCaseNumberRetry(err);
      }
      await upsertPatientRelated(deps.related, patientId, related, client);
      return { id: patientId, created: true as const };
    });
  } catch (err) {
    if (err instanceof CaseNumberConflictRetry) {
      functions.logger.warn('patient_service.native_case_number_conflict_retry', {
        origin:             nativeInput.origin,
        rejectedCaseNumber: nativeInput.caseNumber ?? null,
      });
      return retryNativeWithoutCaseNumber(deps, nativeInput, related);
    }
    throw err;
  }
}

async function retryNativeWithoutCaseNumber(
  deps: PatientNativeCreatorDeps,
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

  return inPatientTransaction(async (client) => {
    const { id: patientId } = await deps.identityRepo.insertNative(safeInput, client);
    await upsertPatientRelated(deps.related, patientId, related, client);
    return { id: patientId, created: true as const };
  });
}
