import { validateSummaryShape } from '../domain/admissionSummaryShape';
import { AdmissionSummaryError, type AdmissionSummaryResult } from './ports/AdmissionImportPorts';

/**
 * Porta de forma do resumo (spec 050 F6): fora da forma, vira `AdmissionSummaryError` (`json_invalid` | `schema_invalid`) e cai no
 * mesmo caminho de `summary_failed` do serviço — mesmo teto de 3, mesma trilha. Só NOMES de campo seguem no erro, nunca valor.
 */
export function assertSummaryShape(result: AdmissionSummaryResult): AdmissionSummaryResult {
  const verdict = validateSummaryShape(result);
  if (!verdict.ok) throw new AdmissionSummaryError(verdict.reason, verdict.fields);
  return result;
}
