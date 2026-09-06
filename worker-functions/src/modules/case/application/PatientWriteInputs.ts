import type {
  PatientIdentityUpsertInput,
  NativePatientOrigin,
} from '../infrastructure/PatientIdentityRepository';
import type { PatientResponsibleInput } from '../domain/PatientResponsible';
import type { PatientAddress, PatientProfessional } from '../../../infrastructure/repositories/PatientRepository';
import type { DependencyLevel } from '../domain/enums/DependencyLevel';
import type { PatientSourceLabelsRead } from '../infrastructure/PatientSourceLabelRepository';
import type { ClinicalSpecialty } from '../domain/enums/ClinicalSpecialty';
import type { Profession } from '../../worker/domain/enums/Profession';
import type { PatientStatus } from '../domain/enums/PatientStatus';
import type { AdmissionCountry } from '../../matching/domain/admissionCountries';

/**
 * PatientWriteInputs — o CONTRATO DE ESCRITA do paciente: o que o espelho do ClickUp e o
 * cadastro nativo entregam ao `PatientService`.
 *
 * Extraído de `PatientService` para manter aquele arquivo dentro do teto de 400 linhas (mesmo
 * molde de `PatientRelatedWriter`). São só tipos — nenhuma linha de execução mudou de lugar, e
 * `PatientService` continua re-exportando todos eles (`export type`, que a compilação apaga),
 * então nenhum chamador precisou trocar de import.
 */

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
  /** Propagated from the upstream event (webhook request-id or batch correlation). */
  correlationId?: string;
}

export interface PatientServiceUpsertInput extends PatientIdentityUpsertInput {
  // Clinical
  diagnosis?: string | null;
  dependencyLevel?: DependencyLevel | null;
  /**
   * A leitura da origem foi POSSÍVEL? `false` ⇒ `dependency_level` não é tocada no banco (I2).
   * Ver `PatientClinicalRepository`; ausente = `true`.
   */
  dependencyLevelReadable?: boolean;
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
  /**
   * Task 4.2 — a lista de `Tipo de Dispositivo`, destinada a `patient_device_types`.
   *
   * Não há campo escalar irmão, diferente da cobertura: `patients.device_type` é derivado
   * por trigger a partir desta tabela (migration 310). Ver F64 — o escalar co-escrito era
   * apagado a cada webhook, porque o mapper nunca produzia o valor e a escrita era
   * incondicional.
   */
  deviceTypeLabels?: PatientSourceLabelsRead;
  /** @deprecated Use clinicalSpecialty + serviceType instead. Preserved for backward compat. */
  clinicalSegments?: string | null;
  /** Array of professional roles the patient requires. Was string | null before migration 139. */
  serviceType?: Profession[] | null;
  /**
   * A leitura da origem foi POSSÍVEL? `false` ⇒ `service_type` não é tocada no banco (I2).
   * Ver `PatientClinicalRepository`; ausente = `true`.
   */
  serviceTypeReadable?: boolean;
  // `deviceType` SAIU (spec 012, US-B4): o conjunto vive em `patient_device_types` e o escalar
  // `patients.device_type` é derivado por trigger (310). O drawer clínico manda `deviceTypes`
  // (códigos) em PatientClinicalSectionData; o sync emite `deviceTypeLabels`.
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
  // I2: as duas bandeiras irmãs de `clinicalSpecialtyReadable`, pelo mesmo motivo.
  | 'dependencyLevelReadable'
  | 'serviceTypeReadable'
  | 'clinicalSpecialty'
  // Task 2.2/rodada 4: a bandeira "leitura possível?" viaja junto do derivado (só o sync a emite;
  // o drawer não a manda e o repositório assume `true`).
  | 'clinicalSpecialtyReadable'
  | 'clinicalSegments'
  | 'serviceType'
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
