/**
 * sortDiagnosesForCard — ordena os diagnósticos ATIVOS para a ficha (spec 016 F3).
 *
 * NÃO decide qual principal "vence" quando origens diferentes discordam — isso é
 * `PrimaryDiagnosisPolicy` (backend, `domain/`), que nunca chega ao cliente. Aqui só ordena o
 * que a API já mandou: principal primeiro (por ordem de precedência de ORIGEM, D263: PANEL >
 * CLICKUP > BACKFILL, mesma ordem de `DiagnosisSource.ts`), depois o resto por título.
 */
import type { PatientDiagnosisDetail } from './PatientDetail';

const SOURCE_PRECEDENCE: Record<string, number> = { PANEL: 0, CLICKUP: 1, BACKFILL: 2 };

function sourceRank(source: string): number {
  return SOURCE_PRECEDENCE[source] ?? Number.MAX_SAFE_INTEGER;
}

export function sortDiagnosesForCard(diagnoses: PatientDiagnosisDetail[]): PatientDiagnosisDetail[] {
  return diagnoses
    .filter((d) => d.active)
    .slice()
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.isPrimary && b.isPrimary) {
        const rankDiff = sourceRank(a.source) - sourceRank(b.source);
        if (rankDiff !== 0) return rankDiff;
      }
      return a.title.localeCompare(b.title);
    });
}

/**
 * diagnosisDisplayState — a MESMA decisão de estado (spec cid-na-vacante), reusada pelos 3
 * pontos que passaram a mostrar patología na vaga/caso (`VacancyFormLeftColumn`,
 * `VacancyProfessionCard`, `CaseDetailsModal`). Cada chamador mantém seu próprio markup/i18n —
 * isto só decide QUAL estado é, não como ele se desenha.
 *
 * `null` = ator sem permissão clínica (a API projetou o dado fora, D113): NUNCA vira "vazio".
 * `diagnosesUnavailable` tem precedência — é falha de leitura do catálogo (bulkhead C4), distinta
 * de "sem diagnóstico" (`[]`) e de "sem permissão" (`null`).
 */
export type DiagnosisDisplayState =
  | { kind: 'unavailable' }
  | { kind: 'noPermission' }
  | { kind: 'empty' }
  | { kind: 'list'; diagnoses: PatientDiagnosisDetail[] };

export function diagnosisDisplayState(
  diagnoses: readonly PatientDiagnosisDetail[] | null | undefined,
  diagnosesUnavailable: boolean,
): DiagnosisDisplayState {
  if (diagnosesUnavailable) return { kind: 'unavailable' };
  // `== null` cobre null E undefined de propósito: `null` é "sem a célula clínica", e `undefined`
  // é "o campo nem veio no payload" (contrato mais velho, fixture antiga). Os dois caem no lado
  // SEGURO — nunca em `empty`, que afirmaria "este paciente não tem diagnóstico". Tratar ausência
  // como vazio é exatamente a mentira que este helper existe para impedir.
  if (diagnoses == null) return { kind: 'noPermission' };
  const sorted = sortDiagnosesForCard(diagnoses as PatientDiagnosisDetail[]);
  return sorted.length === 0 ? { kind: 'empty' } : { kind: 'list', diagnoses: sorted };
}
