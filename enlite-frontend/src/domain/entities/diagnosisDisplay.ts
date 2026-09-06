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
