/**
 * messagingOptOutFilter
 *
 * Fonte ÚNICA do predicado "este worker está em opt-out de mensagens".
 *
 * O incidente de 10/07/2026 nasceu de predicados divergentes: a seleção de
 * algumas campanhas checava opt-out de um jeito e o envio final não checava.
 * O `OutboxProcessor` virou o ponto único de defesa; quem quiser PRÉ-checar
 * (para contar o pulo antes de enfileirar, D211.4) usa ESTA expressão — nunca
 * uma cópia. `opted_in_at IS NULL` = opt-out vigente (re-opt-in limpa).
 */

/** Verdadeiro quando o worker identificado por `workerIdExpr` está em opt-out. */
export function optedOutExistsSql(workerIdExpr: string): string {
  return `EXISTS(
                SELECT 1 FROM messaging_opt_out moo
                WHERE moo.worker_id = ${workerIdExpr} AND moo.opted_in_at IS NULL
              )`;
}
