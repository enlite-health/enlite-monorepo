/**
 * findAbsorbedWorkerIds
 *
 * Hotfix 14/09 (documentos de worker absorvido em merge): dado o id de um
 * worker SOBREVIVENTE (`merged_into_id IS NULL`), devolve os ids de TODOS os
 * workers cuja corrente `merged_into_id` termina nele — a direção OPOSTA de
 * {@link resolveCanonicalWorkerId} (que sobe de um id possivelmente morto até
 * o vivo; este desce do vivo até todos os mortos que apontam para ele,
 * direto ou em cadeia A→C→B).
 *
 * Por que existe: `WorkerPhoneMergeService.executeSingleMerge` reparenta
 * `worker_id` em `worker_documents`/`worker_additional_documents` para o
 * sobrevivente, mas NUNCA move o objeto no GCS — o caminho gravado continua
 * `workers/<id do absorvido>/...`. O guard de documento (`documentPathGuard`)
 * trava por PREFIXO `workers/<workerId>/`; sem esta lista, o sobrevivente
 * pedindo o PRÓPRIO documento (cujo caminho ainda carrega o id do cadastro
 * absorvido) levava 404. Medido em PRD (só contagem, 13/09): 51 documentos
 * legítimos nessa forma.
 *
 * Fail-closed:
 *   - `survivorId` inexistente → `[]` (a CTE parte do `country` do
 *     sobrevivente; sem ele, nada casa).
 *   - só entram absorvidos do MESMO `country` do sobrevivente — cadeia que
 *     atravessa país (dado corrompido/import errado) não abre.
 *   - profundidade máxima igual à de `resolveCanonicalWorkerId`
 *     (`MAX_MERGE_DEPTH = 10`) — cadeia mais funda que isso não é seguida
 *     (mesmo teto, mesma razão: ciclo/corrupção não trava a query).
 *
 * Não reaproveita a CTE de `ReconcileMergedWorkerApplications.findMergedOrphans`
 * por decisão explícita, não por descuido: aquela CTE sobe de QUALQUER morto
 * até o canônico (direção ascendente, sem filtro de país, servindo um job de
 * reconciliação em lote); esta desce de UM sobrevivente conhecido até seus
 * mortos (direção descendente, com filtro de país, servindo um guard de
 * autorização por request). Extrair uma CTE comum exigiria parametrizar
 * direção E filtro de país dentro do job de reconciliação — ripple num
 * caminho crítico de dados (duplicata × órfão) fora do escopo deste hotfix.
 * O que É compartilhado: o teto `MAX_MERGE_DEPTH` (importado, não redigitado).
 */

import type { Pool, PoolClient } from 'pg';
import { MAX_MERGE_DEPTH } from './resolveCanonicalWorkerId';

export async function findAbsorbedWorkerIds(
  db: Pool | PoolClient,
  survivorId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE survivor AS (
       SELECT id, country FROM workers WHERE id = $1::uuid
     ),
     chain AS (
       SELECT w.id, w.merged_into_id, 0 AS depth
         FROM workers w
         JOIN survivor s ON w.merged_into_id = s.id AND w.country = s.country
       UNION ALL
       SELECT w.id, w.merged_into_id, c.depth + 1
         FROM workers w
         JOIN chain c ON w.merged_into_id = c.id
         JOIN survivor s ON w.country = s.country
        WHERE c.depth < $2
     )
     SELECT id::text AS id FROM chain`,
    [survivorId, MAX_MERGE_DEPTH],
  );

  return rows.map((r) => r.id);
}
