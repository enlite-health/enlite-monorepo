/**
 * canonicalWorker
 *
 * Fonte única do recorte "um registro mergeado não é uma pessoa".
 *
 * Quando dois cadastros da mesma pessoa são fundidos, o perdedor NÃO é apagado:
 * ele fica no banco com `merged_into_id` apontando para o sobrevivente (ver
 * `WorkerDeduplicationService.mergeWorkers`). O registro precisa continuar
 * existindo — é dele que dependem a trilha de auditoria e o vínculo de login
 * antigo. O que não pode acontecer é o sistema tratá-lo como uma pessoa viva.
 *
 * Quando isso acontece na ESCRITA, o estrago é duplicidade silenciosa: a trava
 * `UNIQUE (worker_id, job_posting_id)` de `worker_job_applications` — que existe
 * justamente para impedir a mesma pessoa de se postular duas vezes na mesma vaga
 * — é por ID de worker, então dois IDs da mesma pessoa passam pelos dois lados
 * dela. O time de recrutamento vê a candidata duas vezes no mesmo caso, move um
 * card e o outro não acompanha (são linhas independentes).
 *
 * Caso que originou este arquivo (13/08, Norma Araujo, CASO 762-469): o webhook
 * do Talentum resolveu a prestadora pelo e-mail antigo, casou o registro fundido
 * em 23/06 e escreveu nele. Duas postulações na mesma vaga com 3 minutos de
 * diferença.
 *
 * Regra: todo caminho que resolve uma pessoa a partir de um dado de contato
 * (e-mail, telefone, CUIL) e depois ESCREVE precisa resolver o canônico antes de
 * escrever. Leitura pura pode continuar usando o ID como veio.
 */

/** Pool ou client de transação — só precisamos de `query`. */
type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

/**
 * Teto de saltos na cadeia `merged_into_id`.
 *
 * Cadeias reais têm 1 salto (A→B); 2 aparecem quando um merge antigo é
 * re-mergeado. O teto existe para que um ciclo — que não deveria existir, mas
 * que nada no schema impede — não vire loop infinito.
 */
export const MAX_MERGE_CHAIN_DEPTH = 10;

/**
 * Segue a cadeia `merged_into_id` até o registro vivo.
 *
 * @returns o ID do sobrevivente; o próprio ID se ele já for vivo; `null` se o ID
 *   não existe OU se a cadeia não terminou dentro de {@link MAX_MERGE_CHAIN_DEPTH}
 *   saltos (ciclo). Os dois casos devolvem `null` de propósito: em ambos não há
 *   pessoa viva provável, e o chamador deve tratar como "não encontrei" em vez de
 *   escrever num registro suspeito.
 */
export async function resolveCanonicalWorkerId(
  db: Queryable,
  workerId: string,
): Promise<string | null> {
  const result = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id, merged_into_id, 1 AS depth
         FROM workers
        WHERE id = $1
       UNION ALL
       SELECT w.id, w.merged_into_id, c.depth + 1
         FROM workers w
         JOIN chain c ON w.id = c.merged_into_id
        WHERE c.depth < $2
     )
     SELECT id FROM chain WHERE merged_into_id IS NULL LIMIT 1`,
    [workerId, MAX_MERGE_CHAIN_DEPTH],
  );

  return (result.rows[0]?.id as string | undefined) ?? null;
}

/**
 * Predicado para queries que JÁ têm a tabela `workers` no FROM/JOIN.
 *
 * Em LEFT JOIN sem worker correspondente `merged_into_id` vem NULL e a linha
 * passa no predicado — que é o comportamento desejado, o mesmo cuidado que o
 * `excludeDisabledWorkersSql` resolve com COALESCE: some só quem está mergeado
 * de verdade, não quem não tem cadastro linkado.
 *
 * @param alias alias da tabela `workers` na query (default `w`).
 */
export function excludeMergedWorkersSql(alias = 'w'): string {
  return `${alias}.merged_into_id IS NULL`;
}
