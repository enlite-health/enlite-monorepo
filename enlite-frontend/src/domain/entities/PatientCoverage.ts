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
  /** 417 (D301): a lista INTEIRA dos contatos de emergência da cobertura; chave ausente = não toca. */
  emergencyContacts?: PatientCoverageEmergencyContactInput[];
}

/**
 * Contatos de emergência da COBERTURA MÉDICA (migration 417; D301 — Ana Joulie 08/09/2026: "profissional
 * direto, ambulância, central de atendimento de emergência"). O familiar/responsável é outro campo
 * (`responsibles`). O telefone é PII cifrada no servidor; o profissional direto só chega ao cliente
 * quando o ator lê cobertura E equipe tratante (lex C3).
 */
export const COVERAGE_EMERGENCY_CONTACT_KINDS = ['DIRECT_PROFESSIONAL', 'AMBULANCE', 'EMERGENCY_CENTER'] as const;
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

/** Uma opção do catálogo de coberturas (GET /api/admin/catalogs/insurance-providers). */
export interface InsuranceProvider {
  code: string;
  sortOrder: number;
}
