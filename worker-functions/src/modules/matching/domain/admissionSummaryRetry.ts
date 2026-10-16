/**
 * Reprocesso do resumo (spec 050 F11, R-38). Regra pura: a decisão do botão "Reintentar resumen" a partir de quatro fatos já lidos
 * da reunião. Sem banco, sem relógio, sem texto: o serviço lê os fatos e esta função decide.
 */

/** Evento da trilha (só-acréscimo) que autoriza +1 rodada de até `MAX_SUMMARY_ATTEMPTS` chamadas pagas. `ref = { actorUid, authorization }`. */
export const SUMMARY_RETRY_AUTHORIZED_EVENT = 'summary_retry_authorized';
/** Teto de autorizações por reunião (⚙️ R-38): depois dele a reunião só se resolve fora do botão. */
export const MAX_SUMMARY_RETRY_AUTHORIZATIONS = 2;

export type SummaryRetryRefusal = 'appointment_not_booked' | 'already_done' | 'import_terminal' | 'authorization_limit';

export type SummaryRetryDecision =
  | { kind: 'authorize' }
  /** Não esgotada (inclui motivos `prompt_*` e de catálogo, que não contam no teto): o botão só roda a importação agora. */
  | { kind: 'run_now' }
  | { kind: 'refuse'; reason: SummaryRetryRefusal };

export interface SummaryRetryFacts {
  appointmentStatus: string;
  importStatus: string | null;
  /** Falhas do lado do modelo DESDE a última autorização (a mesma contagem que o teto de 3 usa). */
  modelFailuresSinceAuthorization: number;
  authorizations: number;
}

const RETRYABLE_IMPORT_STATUS = ['pending', 'waiting', 'blocked'];

export function decideSummaryRetry(f: SummaryRetryFacts, maxAttempts: number): SummaryRetryDecision {
  if (f.appointmentStatus !== 'booked') return { kind: 'refuse', reason: 'appointment_not_booked' };
  if (f.importStatus === 'done') return { kind: 'refuse', reason: 'already_done' };
  if (!RETRYABLE_IMPORT_STATUS.includes(f.importStatus ?? '')) return { kind: 'refuse', reason: 'import_terminal' };
  if (f.modelFailuresSinceAuthorization < maxAttempts) return { kind: 'run_now' };
  if (f.authorizations >= MAX_SUMMARY_RETRY_AUTHORIZATIONS) return { kind: 'refuse', reason: 'authorization_limit' };
  return { kind: 'authorize' };
}

/** O que a aba mostra por reunião (spec 050 F11): `null` = sem botão (nada falhou, ou a reunião não está mais na fila do resumo). */
export interface SummaryRetryView {
  /** 3 chamadas pagas gastas desde a última autorização: o botão AUTORIZA uma rodada nova (com custo). Falso: o botão só roda agora. */
  exhausted: boolean;
  /** Autorizações que ainda restam (teto 2). `exhausted && authorizationsLeft === 0` = sem saída pelo botão. */
  authorizationsLeft: number;
}

export interface SummaryRetryListFacts {
  appointmentStatus: string;
  importStatus: string | null;
  /** Falhas do lado do modelo desde a última autorização (a contagem do teto). */
  modelFailuresSinceAuthorization: number;
  /** Qualquer `summary_failed` desde a última autorização (inclui `prompt_*` e catálogo, que não contam no teto). */
  anyFailuresSinceAuthorization: number;
  authorizations: number;
}

export function summaryRetryView(f: SummaryRetryListFacts, maxAttempts: number): SummaryRetryView | null {
  if (f.appointmentStatus !== 'booked' || !RETRYABLE_IMPORT_STATUS.includes(f.importStatus ?? '')) return null;
  if (f.anyFailuresSinceAuthorization === 0) return null;
  return {
    exhausted: f.modelFailuresSinceAuthorization >= maxAttempts,
    authorizationsLeft: Math.max(0, MAX_SUMMARY_RETRY_AUTHORIZATIONS - f.authorizations),
  };
}
