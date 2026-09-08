/**
 * Validação de UMA linha de contato de emergência da cobertura (417; D301.3b) — fora do componente
 * para o `react-refresh/only-export-components` do lint (arquivo de componente só exporta componente).
 */
import {
  COVERAGE_EMERGENCY_CONTACT_NAME_MAX,
  COVERAGE_EMERGENCY_CONTACT_PHONE_MAX,
  type PatientCoverageEmergencyContactInput,
} from '@domain/entities/PatientCoverage';

/** Os dois campos de UMA linha, julgados num lugar só: alimenta o `aria-invalid` da linha e a trava do Guardar. */
export function contactFieldErrors(c: PatientCoverageEmergencyContactInput): { name: boolean; phone: boolean } {
  const name = c.name.trim().length;
  const phone = c.phone.trim().length;
  return {
    name: name === 0 || name > COVERAGE_EMERGENCY_CONTACT_NAME_MAX,
    phone: phone === 0 || phone > COVERAGE_EMERGENCY_CONTACT_PHONE_MAX,
  };
}

/** Linha inválida = nome ou telefone vazio, ou acima do teto — o Guardar do drawer trava enquanto houver uma. */
export function invalidCoverageContacts(list: PatientCoverageEmergencyContactInput[]): boolean {
  return list.some((c) => { const e = contactFieldErrors(c); return e.name || e.phone; });
}
