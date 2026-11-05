/**
 * resolveLiveCanonicalWorkerIds
 *
 * Regra ÚNICA do Talentum (webhook e script de reconciliação) para ids de worker casados por e-mail/telefone,
 * incluindo cadastros FUNDIDOS (D111): cada id segue a cadeia até o sobrevivente e o resultado é deduplicado.
 * 2+ ids devolvidos = sobreviventes DISTINTOS (ambíguo; quem chama decide). Quem chama já excluiu `deleted_at` na
 * linha casada; aqui só se confere que o SOBREVIVENTE de um id fundido não foi deletado.
 *
 * `canonicalize` é de quem chama (o webhook passa o `toCanonical`, com alarme de cadeia quebrada); `null` = descarta.
 */
import type { Pool, PoolClient } from 'pg';

export async function resolveLiveCanonicalWorkerIds(
  db: Pick<Pool | PoolClient, 'query'>,
  rawIds: readonly string[],
  canonicalize: (workerId: string) => Promise<string | null>,
): Promise<string[]> {
  const live = new Set<string>();
  for (const raw of new Set(rawIds)) {
    const canonical = await canonicalize(raw);
    if (!canonical) continue;
    if (canonical !== raw) {
      const alive = await db.query('SELECT 1 AS alive FROM workers WHERE id = $1::uuid AND deleted_at IS NULL', [canonical]);
      if (alive.rows.length === 0) continue;
    }
    live.add(canonical);
  }
  return [...live];
}
