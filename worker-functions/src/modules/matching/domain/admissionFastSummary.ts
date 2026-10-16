/**
 * Caminho rápido do resumo (spec 050, 4º passo; R-51, R-52). Regras puras: o relógio entra por parâmetro, sem banco e sem log.
 * `decideFastRead` diz quando ler o Tactiq; `isTranscriptReady` diz se a leitura devolveu uma transcrição pronta.
 */

/** R-51: a 1ª leitura só vem 3 min depois do fim real (os blocos completam em ~2 min 40 s, F0.3d). */
export const FAST_FIRST_READ_DELAY_MS = 3 * 60 * 1000;
/** R-51: leituras seguintes espaçadas de pelo menos 60 s. */
export const FAST_MIN_GAP_MS = 60 * 1000;
/** R-51: no máximo 5 leituras por reunião (o Tactiq limita a 10 reuniões/h por usuária, §7.1). */
export const FAST_MAX_READS = 5;
/** R-52: 10 min depois do fim o caminho rápido desiste; a importação de 15 min assume (§19.7 item 2). */
export const FAST_DEADLINE_MS = 10 * 60 * 1000;

export type FastReadDecision = { kind: 'wait' } | { kind: 'read' } | { kind: 'give_up'; reason: 'deadline' | 'max_reads' };

export interface FastReadFacts {
  now: Date;
  /** O fim real gravado (`conference_ended_at`). */
  endedAt: Date;
  /** Leituras já feitas por este caminho (`summary_fast_reads`; `null` = nenhuma). */
  reads: number | null;
  /** `summary_fast_last_read_at`; `null` = nenhuma leitura. */
  lastReadAt: Date | null;
}

export function decideFastRead(f: FastReadFacts): FastReadDecision {
  const sinceEnd = f.now.getTime() - f.endedAt.getTime();
  if (sinceEnd >= FAST_DEADLINE_MS) return { kind: 'give_up', reason: 'deadline' };
  if ((f.reads ?? 0) >= FAST_MAX_READS) return { kind: 'give_up', reason: 'max_reads' };
  if (sinceEnd < FAST_FIRST_READ_DELAY_MS) return { kind: 'wait' };
  if (f.lastReadAt !== null && f.now.getTime() - f.lastReadAt.getTime() < FAST_MIN_GAP_MS) return { kind: 'wait' };
  return { kind: 'read' };
}

/**
 * R-51: pronta = a reunião existe no Tactiq (`count !== null`) E contagem de blocos > 0 E igual à leitura anterior E nenhuma
 * conferência aberta. `previousCount` `null` = a leitura anterior não devolveu contagem (ou é a 1ª): nunca pronta.
 */
export function isTranscriptReady(f: { count: number | null; previousCount: number | null; conferenceOpen: boolean }): boolean {
  if (f.conferenceOpen) return false;
  if (f.count === null || f.previousCount === null) return false;
  return f.count > 0 && f.count === f.previousCount;
}
