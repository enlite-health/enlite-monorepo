/**
 * PublicDiagnosisSelection — spec 042 (D473, 05/10/2026). Qual diagnóstico CID-11 a página
 * PÚBLICA da vaga mostra, e com que texto. Função pura, sem I/O.
 *
 * Regra (spec 042 §4):
 *  · 0 ativos            → nada
 *  · exatamente 1 ativo  → esse (mesmo que não seja principal)
 *  · 2+ ativos           → `PrimaryDiagnosisPolicy.winningPrimary` (a MESMA do painel, sem cópia);
 *                          sem nenhum principal ela devolve `null` — não adivinha.
 *
 * O idioma é checado DEPOIS de escolher: filtrar `es` antes faria um principal em outro idioma
 * ceder lugar a um secundário `es` que não é o principal.
 *
 * O retorno público é só `string | null` (o título): a função não tem como devolver código/URI.
 */
import { PrimaryDiagnosisPolicy, type DiagnosisForPolicy } from './PrimaryDiagnosisPolicy';

export interface DiagnosisForPublicLabel extends DiagnosisForPolicy {
  readonly conceptTitle: string;
  readonly conceptLanguage: string;
}

export function selectDisplayedDiagnosis<T extends DiagnosisForPolicy>(diagnoses: readonly T[]): T | null {
  const actives = diagnoses.filter((d) => d.active);
  if (actives.length === 0) return null;
  if (actives.length === 1) return actives[0];
  return PrimaryDiagnosisPolicy.winningPrimary(actives);
}

export function selectPublicDiagnosisLabel(diagnoses: readonly DiagnosisForPublicLabel[]): string | null {
  const chosen = selectDisplayedDiagnosis(diagnoses);
  if (chosen === null || chosen.conceptLanguage !== 'es') return null;
  return chosen.conceptTitle.trim() === '' ? null : chosen.conceptTitle;
}
