import { SUMMARY_RETRY_AUTHORIZED_EVENT } from '../domain/admissionSummaryRetry';

/**
 * Fragmento SQL ÚNICO (spec 050 F11, R-38): o instante da última autorização de reprocesso da reunião, ou `-infinity` se nunca houve.
 * A trilha é só-acréscimo por trigger: nada é apagado; "desde a última autorização" é um filtro `at >` este instante. Quem conta falhas
 * (`countModelSummaryFailures`), decide se a exaustão já foi registrada (`hasBlockedReason`) e monta a fila (`listDueIds`) usa ESTE
 * fragmento, para os três nunca discordarem.
 *
 * `apptIdSql` é uma expressão SQL que resolve ao id da reunião (`a.id`, `$1::uuid`) — nunca entrada de usuário.
 */
export function lastRetryAuthorizationSql(apptIdSql: string): string {
  return `COALESCE((SELECT max(r.at) FROM admission_events r WHERE r.appointment_id = ${apptIdSql} AND r.kind = '${SUMMARY_RETRY_AUTHORIZED_EVENT}'), '-infinity'::timestamptz)`;
}
