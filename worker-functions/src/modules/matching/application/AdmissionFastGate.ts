import { isTranscriptReady } from '../domain/admissionFastSummary';
import type { FastGate, TranscriptRead } from './AdmissionTranscriptReader';

/** O portão mais a contagem que ele viu: o job de 1 min guarda `count` como a "última contagem" da reunião. */
export interface FastGateProbe extends FastGate {
  /** `undefined` = a leitura não chegou ao portão; `null` = chegou sem contagem (não achou, ambígua, integridade, sem vínculo); `n` = blocos lidos. */
  readonly count: number | null | undefined;
}

/**
 * O portão do modo rápido (spec 050 F28, R-51): quem decide se a transcrição está pronta é `isTranscriptReady` (F24), não um `if` na
 * importação. Antes do portão o modo rápido só acelera o caso feliz: "não achou", "fora da janela", "ambígua", "sem vínculo", falha do
 * MCP e integridade viram `not_ready` com contagem nula — quem decide estado terminal continua sendo a rede de 15 min.
 * `busy` e o token transitório NÃO passam por aqui (`false`): seguem o caminho de sempre e saem `transient`, sem contar leitura.
 */
export function createFastGate(input: { previousCount: number | null; conferenceOpen: boolean }): FastGateProbe {
  let seen: number | null | undefined;
  return {
    get count() {
      return seen;
    },
    hold(read: TranscriptRead): boolean {
      switch (read.kind) {
        case 'busy':
          return false;
        case 'no_access':
          if (read.reason === 'transient') return false;
          seen = null;
          return true;
        case 'read': {
          seen = read.parts.reduce((n, p) => n + p.blocks, 0);
          return !isTranscriptReady({ count: seen, previousCount: input.previousCount, conferenceOpen: input.conferenceOpen });
        }
        default:
          seen = null;
          return true;
      }
    },
  };
}
