import { validateEnquadreSummaryShape } from '../domain/enquadreSummaryShape';
import { AdmissionSummaryError, type AdmissionSummaryInput, type AdmissionSummaryResult } from './ports/AdmissionImportPorts';

/**
 * Porta de forma do resumo do ENCUADRE (spec 052, T-36b): fora da forma, vira `AdmissionSummaryError` (`json_invalid` | `schema_invalid`)
 * e cai no mesmo caminho de `summary_failed` do serviço de importação — mesmo teto de 3, mesma trilha. Só NOMES de campo seguem no erro.
 * As `ref` dos convocados vêm da MESMA entrada que foi ao modelo.
 */
export function assertEnquadreSummaryShape(result: AdmissionSummaryResult, input: AdmissionSummaryInput): AdmissionSummaryResult {
  const verdict = validateEnquadreSummaryShape(result, (input.convocados ?? []).map((c) => c.ref));
  if (!verdict.ok) throw new AdmissionSummaryError(verdict.reason, verdict.fields);
  return result;
}
