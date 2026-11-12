/**
 * Gravar `job_postings.talentum_prescreening_id` sob o índice único parcial (migration 558) nunca pode derrubar o
 * fluxo: se o `_id` já está em OUTRA vaga viva, o valor vira NULL (o backfill/humano resolve) e o colide é logado.
 * Sem depender de pegar exceção 23505 (que abortaria a transação depois de o projeto já existir na Talentum).
 */

/** Fragmento de SQL: `$value` (text) ou NULL quando outra vaga viva (≠ `$id`) já tem esse `_id`. */
export function guardedPrescreeningIdSql(valueParam: number, idParam: number): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM job_postings o WHERE o.talentum_prescreening_id = $${valueParam}::text AND o.deleted_at IS NULL AND o.id <> $${idParam})
              THEN NULL ELSE $${valueParam}::text END`;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Chamar após o UPDATE com o valor GRAVADO (`RETURNING talentum_prescreening_id`). Se o `_id` pedido não foi
 * gravado e outra vaga viva o detém, loga `talentum_prescreening_id_colide` (só ids de vaga, sem PII).
 */
export async function logPrescreeningIdCollision(
  db: Queryable,
  jobPostingId: string,
  requestedId: string | null,
  storedId: unknown,
): Promise<void> {
  if (!requestedId || storedId === requestedId) return;
  const other = await db.query(
    'SELECT id FROM job_postings WHERE talentum_prescreening_id = $1 AND deleted_at IS NULL AND id <> $2 LIMIT 1',
    [requestedId, jobPostingId],
  );
  if (other.rows[0]) {
    console.warn(`talentum_prescreening_id_colide vaga=${jobPostingId} outra_vaga=${String(other.rows[0].id)}`);
  }
}
