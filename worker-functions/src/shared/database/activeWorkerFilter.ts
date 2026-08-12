/**
 * activeWorkerFilter
 *
 * Fonte única do recorte "worker desativado não aparece".
 *
 * `status = 'DISABLED'` é a baixa de conta: o worker pediu para sair (a Luz
 * executa via `deactivate_account` → `DeactivateWorkerAccountUseCase`, que na
 * mesma transação grava o `messaging_opt_out`) ou um admin desativou. A baixa é
 * REVERSÍVEL e AUDITADA — o registro fica no banco de propósito (trilha em
 * `worker_status_history`, e sem o worker não existiria o opt-out que impede o
 * contato). O que não pode acontecer é a pessoa continuar aparecendo como se
 * fosse contatável.
 *
 * Regra (decidida em 05/08 com o Gabriel):
 *   - Some das superfícies OPERACIONAIS (onde alguém age sobre a pessoa: kanban
 *     da vaga, candidatos da vaga, busca/export do painel) e das CONTAGENS VIVAS
 *     (dashboard de gestão à vista, contadores da lista de vagas).
 *   - CONTINUA visível onde o objetivo é justamente ver desativados: detalhe do
 *     worker (para reverter a baixa), `GET /workers/status` (card "Desativados")
 *     e `GET /workers/status/:status` com `status=DISABLED`, filtro explícito
 *     `?status=DISABLED` na busca/export.
 *   - NÃO filtra "Alocados" (`ana_care_status`): lá o número representa cobertura
 *     de paciente. Um worker desativado que ainda aparece cobrindo um caso é um
 *     sinal a investigar, não algo a esconder.
 */

/** Status de conta dada de baixa. Ver `DeactivateWorkerAccountUseCase`. */
export const DISABLED_WORKER_STATUS = 'DISABLED';

/**
 * Predicado para queries que JÁ têm a tabela `workers` no FROM/JOIN.
 *
 * `COALESCE` de propósito: em LEFT JOIN sem worker correspondente o status vem
 * NULL, e essas linhas devem continuar aparecendo (some só quem está DISABLED
 * de verdade, não quem não tem cadastro linkado).
 *
 * @param alias alias da tabela `workers` na query (default `w`).
 */
export function excludeDisabledWorkersSql(alias = 'w'): string {
  return `COALESCE(${alias}.status, '') <> '${DISABLED_WORKER_STATUS}'`;
}

/**
 * Predicado para subqueries/contadores que só têm o `worker_id` à mão (não há
 * join com `workers`). Ex.: os contadores por vaga da lista de vagas.
 *
 * @param workerIdExpr expressão do worker_id (ex.: `wja.worker_id`).
 */
export function workerNotDisabledSql(workerIdExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM workers w_disabled_chk
     WHERE w_disabled_chk.id = ${workerIdExpr}
       AND w_disabled_chk.status = '${DISABLED_WORKER_STATUS}'
  )`;
}
