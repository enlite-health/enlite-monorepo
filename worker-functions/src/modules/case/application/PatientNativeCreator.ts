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
  // Carrega o input REALMENTE tentado (com o case_number preenchido, se coube
  // aqui) para fora do try — o catch de conflito precisa dele para logar o
  // número certo e para alimentar o retry (T012).
  let attemptedInput = nativeInput;
  try {
    return await inPatientTransaction(async (client) => {
      let patientId: string;
      // T012: paciente nativo sem case_number pedido pelo chamador recebe um
      // AQUI, antes do insert — nunca mais fica NULL por omissão do chamador
      // (o NULL intencional continua existindo, mas só pelo retry esgotado
      // abaixo, que é o caminho de EXCEÇÃO, não o feliz).
      attemptedInput = nativeInput.caseNumber == null
        ? { ...nativeInput, caseNumber: await deps.identityRepo.nextCaseNumber(client) }
        : nativeInput;
      try {
        ({ id: patientId } = await deps.identityRepo.insertNative(attemptedInput, client));
      } catch (err) {
        // Same conflict handling as the ClickUp path: abort and retry with a
        // FRESH number (T013) — only after MAX_CASE_NUMBER_RETRY_ATTEMPTS
        // does it fall back to the old null+flag behavior.
        rethrowAsCaseNumberRetry(err);
      }
      await upsertPatientRelated(deps.related, patientId, related, client);
      return { id: patientId, created: true as const };
    });
  } catch (err) {
    if (err instanceof CaseNumberConflictRetry) {
      functions.logger.warn('patient_service.native_case_number_conflict_retry', {
        origin:             nativeInput.origin,
        // SEM `?? null`: T012 garante que `attemptedInput.caseNumber` já está
        // preenchido (do chamador OU do nextval) ANTES de qualquer insertNative
        // ser tentado — não existe mais o caminho onde ele chega aqui nulo.
        rejectedCaseNumber: attemptedInput.caseNumber,
      });
      return retryNativeWithNewCaseNumber(deps, attemptedInput, related, 0);
    }
    throw err;
  }
}

/**
 * Teto de tentativas com número NOVO antes de cair no fallback antigo
 * (sem número + `CASE_NUMBER_CONFLICT`). Medido em produção (T013): 5
 * pacientes perderam o número pelo fallback antigo disparando na PRIMEIRA
 * colisão — um `nextval` novo resolve a esmagadora maioria dos casos, já que
 * a colisão só acontece quando o `case_number` veio pedido explicitamente
 * (ex.: reconciliação) e não por concorrência na SEQUENCE em si.
 */
const MAX_CASE_NUMBER_RETRY_ATTEMPTS = 3;

/**
 * Retry de conflito de `case_number` — T013 (spec 027).
 *
 * Cada tentativa pede um `nextval` NOVO e refaz o insert COM número, em uma
 * transação NOVA (a anterior já abortou no Postgres). Só depois de
 * `MAX_CASE_NUMBER_RETRY_ATTEMPTS` tentativas esgotadas é que cai no
 * comportamento antigo (`retryNativeWithoutCaseNumber`): paciente criado SEM
 * número e sinalizado para revisão operacional. Isso é a EXCEÇÃO agora, não
 * o caminho normal do conflito.
 */
async function retryNativeWithNewCaseNumber(
  deps: PatientNativeCreatorDeps,
  nativeInput: PatientIdentityNativeInsertInput,
  related: PatientRelatedInput,
  attempt: number,
): Promise<{ id: string; created: true }> {
  if (attempt >= MAX_CASE_NUMBER_RETRY_ATTEMPTS) {
    return retryNativeWithoutCaseNumber(deps, nativeInput, related);
  }

  try {
    return await inPatientTransaction(async (client) => {
      const freshCaseNumber = await deps.identityRepo.nextCaseNumber(client);
      const attemptInput: PatientIdentityNativeInsertInput = {
        ...nativeInput,
        caseNumber: freshCaseNumber,
      };
      let patientId: string;
      try {
        ({ id: patientId } = await deps.identityRepo.insertNative(attemptInput, client));
      } catch (err) {
        rethrowAsCaseNumberRetry(err);
      }
      await upsertPatientRelated(deps.related, patientId, related, client);
      return { id: patientId, created: true as const };
    });
  } catch (err) {
    if (err instanceof CaseNumberConflictRetry) {
      return retryNativeWithNewCaseNumber(deps, nativeInput, related, attempt + 1);
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
