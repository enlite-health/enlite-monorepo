import type { MeetConferenceRecord } from '../application/ports/MeetConferencePort';
import { earliestConferenceStart } from './admissionPostCall';

/**
 * Regra do job de 1 minuto (spec 050, 4º passo; R-44 a R-46, R-49, R-50, R-56). Pura: sem banco, sem relógio, sem log. O job lê o estado
 * da reunião e as conferências do Meet, pergunta aqui o que gravar e aplica os efeitos na mesma transação. Nenhum horário entra: a
 * decisão é por ESTADO, então atraso, estouro e reabertura não a quebram (a janela ativa é da fila, `AdmissionLiveRepository`).
 */

/** R-46: a reunião entra na janela ativa 15 min antes da hora marcada (decisão do Gabriel, 12/10, §19.7 item 1). */
export const LIVE_ENTRY_LEAD_MS = 15 * 60 * 1000;
/** R-46: e sai 60 min depois do fim marcado, salvo conferência aberta ou gatilho armado (§19.7 item 1). */
export const LIVE_EXIT_TAIL_MS = 60 * 60 * 1000;
/** R-56: um fim antes de `hora marcada + 10 min` é gravado, mas não arma o resumo (a sala aberta antes da hora não é a entrevista). */
export const EARLY_END_GUARD_MS = 10 * 60 * 1000;

/** `import_status` em que o fim ainda pode ser (re)gravado: os da fila da rede (NULL/waiting/blocked) mais `pending` (fim já gravado). */
const END_OPEN_IMPORT_STATUS: ReadonlyArray<string | null> = [null, 'pending', 'waiting', 'blocked'];

export type SummaryFastState = 'armed' | 'fired' | 'gave_up' | 'cancelled';

export interface LiveFacts {
  slotStart: Date;
  /** `conference_started_at` (515); `null` = início nunca gravado. */
  conferenceStartedAt: Date | null;
  /** `conference_ended_at` (503); `null` = fim nunca gravado (ou zerado por uma reabertura). */
  conferenceEndedAt: Date | null;
  importStatus: string | null;
  /** `summary_fast_state` (517); `null` = nunca armado. */
  summaryFastState: SummaryFastState | null;
  /** Já existe o evento `conference_reopened` com `reason='after_summary'` para esta reunião (o evento é UM por reunião). */
  reopenAfterSummaryRecorded: boolean;
}

export type LiveEffect =
  /** R-44: grava o MENOR início observado (e o "ficou sabendo"). */
  | { kind: 'record_start'; startedAt: Date }
  /** R-45: grava o fim e ARMA o gatilho do resumo. `rearm` = já havia gatilho (cancelado pela reabertura, ou armado num fim que andou): recomeça no novo fim e zera a última contagem. */
  | { kind: 'record_end_and_arm'; endedAt: Date; rearm: boolean }
  /** R-56: fim cedo demais (`reason='too_early'`): grava e mostra, NÃO arma. */
  | { kind: 'record_end_no_arm'; endedAt: Date; reason: 'too_early' }
  /** R-49: conferência nova com fim gravado e sem resumo: zera o fim e CANCELA o gatilho se estava armado (`cancelTrigger`). */
  | { kind: 'reopen_and_cancel'; cancelTrigger: boolean }
  /** R-50: conferência nova depois de o resumo existir: só o evento. Nenhuma mudança de importação. */
  | { kind: 'reopen_after_summary' };

export function decideLive(f: LiveFacts, records: readonly MeetConferenceRecord[]): LiveEffect[] {
  if (records.length === 0) return []; // `no_show` não é daqui: é da rede de 15 min.

  const effects: LiveEffect[] = [];
  const earliest = earliestConferenceStart(records) as Date; // records não vazio
  if (f.conferenceStartedAt === null || earliest.getTime() < f.conferenceStartedAt.getTime()) {
    effects.push({ kind: 'record_start', startedAt: earliest });
  }

  const open = records.some((r) => r.endTime === null);
  if (open) {
    if (f.conferenceEndedAt === null) return effects; // em andamento, nada a desfazer
    if (f.importStatus === 'done') {
      if (!f.reopenAfterSummaryRecorded) effects.push({ kind: 'reopen_after_summary' });
      return effects;
    }
    if (END_OPEN_IMPORT_STATUS.includes(f.importStatus)) {
      effects.push({ kind: 'reopen_and_cancel', cancelTrigger: f.summaryFastState === 'armed' });
    }
    return effects;
  }

  // Todas fechadas: o fim é o MAIOR endTime (R-49). Só grava se for novo (a 2ª execução não repete).
  if (!END_OPEN_IMPORT_STATUS.includes(f.importStatus)) return effects; // done e terminais: o fim não anda
  const endedAt = new Date(Math.max(...records.map((r) => (r.endTime as Date).getTime())));
  if (f.conferenceEndedAt !== null && endedAt.getTime() <= f.conferenceEndedAt.getTime()) return effects;
  if (endedAt.getTime() < f.slotStart.getTime() + EARLY_END_GUARD_MS) {
    effects.push({ kind: 'record_end_no_arm', endedAt, reason: 'too_early' });
  } else {
    effects.push({ kind: 'record_end_and_arm', endedAt, rearm: f.summaryFastState !== null });
  }
  return effects;
}
