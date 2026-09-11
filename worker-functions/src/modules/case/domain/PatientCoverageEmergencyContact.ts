/**
 * Contatos de emergência da COBERTURA MÉDICA do paciente (migration 417; D301; Ana Joulie 08/09/2026:
 * "Emergencia da cobertura médica — nesse pode ter varios contatos: profissional direto, ambulancia,
 * central de atendimento de emergencia"). O OUTRO contato de emergência do PDF — familiar/pessoa
 * responsável — já é `PatientResponsible`.
 *
 * Vive na seção "cobertura" da ficha (container `patient_coverage`): a tela edita a lista inteira e
 * manda a lista inteira (`replaceAll`, como os responsáveis). O telefone é PII cifrada via KMS.
 */
export const COVERAGE_EMERGENCY_CONTACT_KINDS = ['DIRECT_PROFESSIONAL', 'AMBULANCE', 'EMERGENCY_CENTER'] as const;
export type CoverageEmergencyContactKind = (typeof COVERAGE_EMERGENCY_CONTACT_KINDS)[number];

export const COVERAGE_EMERGENCY_CONTACT_NAME_MAX = 200;
export const COVERAGE_EMERGENCY_CONTACT_PHONE_MAX = 40;
export const COVERAGE_EMERGENCY_CONTACTS_MAX = 20;

/** O que a seção "cobertura" manda — a lista inteira, na ordem da tela. */
export interface PatientCoverageEmergencyContactInput {
  kind: CoverageEmergencyContactKind;
  name: string;
  phone: string;
}

/** O que a ficha lê (telefone já decifrado — só quando o ator tem `patient_coverage:read`). */
export interface PatientCoverageEmergencyContactDetail extends PatientCoverageEmergencyContactInput {
  id: string;
  sortOrder: number;
}

/**
 * PATCH parcial de uma linha — escrita por linha (spec 018 PR-1, ADR-1). RFC 7396: chave
 * ausente não toca a coluna. `kind`/`name`/`phone` não aceitam `null` (colunas NOT NULL).
 */
export interface PatientCoverageEmergencyContactPatch {
  kind?: CoverageEmergencyContactKind;
  name?: string;
  phone?: string;
}
