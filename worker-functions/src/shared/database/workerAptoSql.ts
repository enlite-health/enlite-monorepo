/**
 * Espelho TS do "apto" (spec 067 FR-03) — zero regra, só a CHAMADA ao dono.
 *
 * "Apto" = REGISTERED + cadastro completo + documentos obrigatórios VALIDADOS. A regra vive em UM lugar, a
 * função SQL `fn_worker_is_apto(uuid)` (migration 546). Este arquivo só emite a chamada; ele NÃO repete lista de
 * campo, de documento nem de profissão. Molde: `activeWorkerFilter.ts`.
 */
import { COMPLETED_COLUMN_STAGES } from '@modules/matching/domain/kanbanColumn';

/**
 * Predicado/expressão booleana "este worker está apto".
 *
 * @param workerIdExpr expressão do worker_id (ex.: `wja.worker_id`, `w.id`, `$1`).
 */
export function workerAptoSql(workerIdExpr: string): string {
  return `fn_worker_is_apto(${workerIdExpr})`;
}

/**
 * Coluna `worker_apto` do Kanban: só avalia o apto quando a etapa é de Completado (SUP-3 do plano — custo e escopo);
 * nas outras etapas devolve NULL e a coluna do quadro não depende dele.
 *
 * A lista de etapas vem de `COMPLETED_COLUMN_STAGES` (interpolada, não copiada).
 *
 * @param stageExpr    expressão da etapa (ex.: `wja.application_funnel_stage`)
 * @param workerIdExpr expressão do worker_id (ex.: `wja.worker_id`)
 */
export function aptoWhenCompletedSql(stageExpr: string, workerIdExpr: string): string {
  const stages = COMPLETED_COLUMN_STAGES.map((s) => `'${s}'`).join(', ');
  return `CASE WHEN ${stageExpr} IN (${stages}) THEN ${workerAptoSql(workerIdExpr)} END`;
}
