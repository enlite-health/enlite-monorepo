/**
 * messagingOptOutFilter — o ÚNICO predicado de opt-out de mensageria.
 *
 * Idêntico ao que o OutboxProcessor aplica antes de enviar: linha em messaging_opt_out
 * sem opted_in_at (isto é, a pessoa saiu e não voltou). Quem pré-checa opt-out antes de
 * enfileirar usa ESTA função — dois predicados diferentes já divergiram uma vez.
 */
export function optedOutExistsSql(workerIdRef: string): string {
  return `EXISTS(
    SELECT 1 FROM messaging_opt_out moo
    WHERE moo.worker_id = ${workerIdRef} AND moo.opted_in_at IS NULL
  )`;
}
