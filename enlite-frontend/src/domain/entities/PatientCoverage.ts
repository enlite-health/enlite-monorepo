/**
 * Cobertura médica do paciente — spec 012, US-B3.
 * O catálogo (`insurance_providers`, migration 311) é lido do endpoint e é editável sem deploy;
 * o seed dos 33 códigos está em `patientEnums.ts` (só para a cobertura de i18n).
 */

/**
 * section = 'coverage' — mirrors coverageSectionSchema (backend).
 * IVA e tipo de contratação NÃO entram (lex C3.3 → bloco C).
 */
export interface PatientCoverageSectionPayload {
  healthInsuranceName?: string | null;
  affiliateId?: string | null;
  /** Códigos do catálogo `insurance_providers`. */
  insuranceVerifiedCodes?: string[];
  // `emergencyContacts` SAIU (spec 018, PR-1, ADR-1, SUP-37): a lista de contatos de emergência
  // da cobertura passou a ser escrita por LINHA — `AdminPatientContactRowsApiService`. Mandar o
  // campo aqui agora é 400 no backend (`.strict()`).
}

/**
 * Contatos de emergência da COBERTURA MÉDICA (migration 417; D301 — Ana Joulie 08/09/2026: "profissional
 * direto, ambulância, central de atendimento de emergência"). O familiar/responsável é outro campo
 * (`responsibles`). O telefone é PII cifrada no servidor; o profissional direto só chega ao cliente
 * quando o ator lê cobertura E equipe tratante (lex C3).
 */
/** Ampliado na migration 424 (spec 018, PR-2, SUP-17): legado AMBULANCE/EMERGENCY_CENTER → INSURANCE_EMERGENCY. */
export const COVERAGE_EMERGENCY_CONTACT_KINDS = [
  'DIRECT_PROFESSIONAL',
  'PUBLIC_EMERGENCY_SERVICE',
  'PRIVATE_AMBULANCE',
  'INSURANCE_EMERGENCY',
] as const;
export type CoverageEmergencyContactKind = (typeof COVERAGE_EMERGENCY_CONTACT_KINDS)[number];
export const COVERAGE_EMERGENCY_CONTACT_NAME_MAX = 200;
export const COVERAGE_EMERGENCY_CONTACT_PHONE_MAX = 40;
export const COVERAGE_EMERGENCY_CONTACTS_MAX = 20;

export interface PatientCoverageEmergencyContactInput {
  kind: CoverageEmergencyContactKind;
  name: string;
  phone: string;
}

export interface PatientCoverageEmergencyContact extends PatientCoverageEmergencyContactInput {
  id: string;
  sortOrder: number;
}

/**
 * PATCH parcial de UMA linha (spec 018, PR-1, ADR-1) — chave ausente não toca; nenhum campo
 * aceita `null` (as três colunas são NOT NULL no backend).
 */
export type PatientCoverageEmergencyContactPatch = Partial<PatientCoverageEmergencyContactInput>;

/** Uma opção do catálogo de coberturas (GET /api/admin/catalogs/insurance-providers). */
export interface InsuranceProvider {
  code: string;
  sortOrder: number;
}
