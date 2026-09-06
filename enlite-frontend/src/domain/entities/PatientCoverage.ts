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
}

/** Uma opção do catálogo de coberturas (GET /api/admin/catalogs/insurance-providers). */
export interface InsuranceProvider {
  code: string;
  sortOrder: number;
}
