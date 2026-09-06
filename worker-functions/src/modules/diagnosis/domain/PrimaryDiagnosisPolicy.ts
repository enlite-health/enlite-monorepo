/**
 * PrimaryDiagnosisPolicy — Strategy (spec 016 F2, D263, tabela GoF do "Contrato de
 * arquitetura"). ÚNICO lugar onde vive qual principal vence quando mais de uma ORIGEM tem um
 * diagnóstico principal ativo ao mesmo tempo — a tabela permite isso de propósito (índice único
 * é por `(patient_id, source)`, nunca por paciente inteiro; ver COMMENT da migration 325).
 *
 * "Só um principal" mora em DOIS lugares (Contrato de arquitetura): o índice parcial único
 * REJEITA duplicata dentro da MESMA origem (sobrevive a escritor concorrente e a `psql` na mão);
 * esta classe decide qual API/tela mostra quando origens DIFERENTES discordam. Nunca grava nada
 * — é leitura pura sobre o que já existe.
 */
import type { DiagnosisSource } from './DiagnosisSource';

export interface DiagnosisForPolicy {
  readonly source: DiagnosisSource;
  readonly isPrimary: boolean;
  readonly active: boolean;
}

export class PrimaryDiagnosisPolicy {
  /**
   * Entre os diagnósticos ATIVOS e PRINCIPAIS de cada origem, devolve o que vence pela ordem de
   * precedência de `DiagnosisSource` (PANEL > CLICKUP > BACKFILL). `null` quando nenhum
   * diagnóstico ativo está marcado como principal — nunca inventa um vencedor (contagem zero é
   * falha ou ausência real, não sucesso disfarçado; aqui `null` é o "ausência real" honesto).
   */
  static winningPrimary<T extends DiagnosisForPolicy>(diagnoses: readonly T[]): T | null {
    let winner: T | null = null;
    for (const candidate of diagnoses) {
      if (!candidate.active || !candidate.isPrimary) continue;
      if (winner === null || candidate.source.outranks(winner.source)) {
        winner = candidate;
      }
    }
    return winner;
  }
}
