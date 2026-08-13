/**
 * ReconcileMergedWorkerApplications
 *
 * Reconcilia postulações (`worker_job_applications`) e cards (`encuadres`)
 * ancorados em cadastros JÁ FUNDIDOS (`merged_into_id IS NOT NULL`).
 *
 * Origem (13/08, caso Norma Araujo, CASO 762-469): a mesma prestadora aparecia
 * em dois cards da MESMA vaga. A trava `UNIQUE (worker_id, job_posting_id)` é
 * por ID de worker, e a pessoa tinha dois cadastros — um fundido no outro desde
 * 23/06. O webhook do Talentum resolvia pelo e-mail antigo e escrevia no morto.
 * A CAUSA está fechada em `ProcessTalentumPrescreening` (resolução canônica
 * antes de escrever); isto limpa o que já entrou.
 *
 * Dois casos, tratamento diferente:
 *
 *   DUPLICADO — o canônico já tem linha nesta vaga. A do registro morto é o card
 *     fantasma. Descartada, que é a mesma semântica do próprio merge
 *     (`WorkerDeduplicationService.mergeWorkers`: `ON CONFLICT DO NOTHING` +
 *     `DELETE`). Antes de descartar, o que a fantasma tem de único é movido para
 *     a linha canônica: trilha de etapas, notas de contato e campos de entrevista
 *     ainda vazios. A ETAPA do funil nunca é sobrescrita — a canônica costuma
 *     estar mais adiantada (CONFIRMED) que a fantasma (QUALIFIED), e regredir
 *     apagaria trabalho do time.
 *
 *   ÓRFÃO — o canônico não tem linha nesta vaga. Não há duplicata: é uma
 *     postulação real presa no cadastro errado. Reparentada. Descartá-la
 *     apagaria candidatura legítima.
 *
 * Por que mover a trilha antes de deletar: `worker_job_application_stage_history`
 * (migration 169) e `wja_contact_notes` (migration 204) têm FK
 * `ON DELETE CASCADE` para a WJA. Um `DELETE` direto levaria junto a autoria que
 * sustenta o selo "levantou a mão" (D95) e as notas das operadoras. Medido em
 * prod em 13/08: 115 linhas de histórico e 1 nota penduradas nas 30 linhas.
 */

import type { PoolClient } from 'pg';

export interface MergedOrphanRow {
  kind: 'application' | 'encuadre';
  rowId: string;
  deadWorkerId: string;
  canonicalWorkerId: string;
  jobPostingId: string;
  vacancyTitle: string | null;
  stage: string | null;
  matchScore: string | null;
  /** true = o canônico já tem linha nesta vaga → descartar a do morto. */
  duplicate: boolean;
  /** Linha inteira, para o rollback recriar exatamente o que foi removido. */
  snapshot: Record<string, unknown>;
}

/** Alcance da corrente de merge — mesmo teto de `resolveCanonicalWorkerId`. */
const MAX_CHAIN_DEPTH = 10;

/**
 * Postulações e encuadres presos em cadastro fundido, já classificados em
 * duplicado × órfão. A corrente é resolvida em SQL para cobrir merges
 * encadeados (A→B→C) numa passada só.
 */
export async function findMergedOrphans(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<MergedOrphanRow[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id AS start_id, id, merged_into_id, 0 AS depth
         FROM workers
        WHERE merged_into_id IS NOT NULL
       UNION ALL
       SELECT c.start_id, w.id, w.merged_into_id, c.depth + 1
         FROM workers w
         JOIN chain c ON w.id = c.merged_into_id
        WHERE c.depth < $1
     ),
     canonical AS (
       SELECT start_id AS dead_id, id AS canonical_id
         FROM chain
        WHERE merged_into_id IS NULL
     )
     SELECT 'application' AS kind, a.id::text AS row_id, a.worker_id::text AS dead_worker_id,
            c.canonical_id::text, a.job_posting_id::text, jp.title AS vacancy_title,
            a.application_funnel_stage AS stage, a.match_score::text AS match_score,
            EXISTS (
              SELECT 1 FROM worker_job_applications dup
               WHERE dup.worker_id = c.canonical_id AND dup.job_posting_id = a.job_posting_id
            ) AS duplicate,
            to_jsonb(a.*) AS snapshot
       FROM worker_job_applications a
       JOIN canonical c ON c.dead_id = a.worker_id
       LEFT JOIN job_postings jp ON jp.id = a.job_posting_id
     UNION ALL
     SELECT 'encuadre', e.id::text, e.worker_id::text,
            c.canonical_id::text, e.job_posting_id::text, jp.title,
            NULL, NULL,
            EXISTS (
              SELECT 1 FROM encuadres dup
               WHERE dup.worker_id = c.canonical_id AND dup.job_posting_id = e.job_posting_id
            ),
            to_jsonb(e.*)
       FROM encuadres e
       JOIN canonical c ON c.dead_id = e.worker_id
       LEFT JOIN job_postings jp ON jp.id = e.job_posting_id
     ORDER BY 1, 6`,
    [MAX_CHAIN_DEPTH],
  );

  return rows.map((r) => ({
    kind: r.kind as MergedOrphanRow['kind'],
    rowId: r.row_id as string,
    deadWorkerId: r.dead_worker_id as string,
    canonicalWorkerId: r.canonical_id as string,
    jobPostingId: r.job_posting_id as string,
    vacancyTitle: (r.vacancy_title as string) ?? null,
    stage: (r.stage as string) ?? null,
    matchScore: (r.match_score as string) ?? null,
    duplicate: r.duplicate as boolean,
    snapshot: r.snapshot as Record<string, unknown>,
  }));
}

/**
 * Libera o guard de postulação para esta transação.
 *
 * `enforce_worker_registered_for_application` dispara em `UPDATE OF worker_id` e
 * exige worker REGISTERED. Reparent não é postulação nova — é consolidação de
 * dado que já existe — e a própria função prevê este bypass, usado pelo
 * merge/undo do dedup. Sem ele, reparentar para um canônico ainda incompleto
 * falharia.
 */
export async function bypassRegisteredGuard(client: PoolClient): Promise<void> {
  await client.query(`SET LOCAL app.bypass_registered_guard = 'on'`);
}

/** Move a trilha e as notas da WJA fantasma para a canônica, antes do DELETE. */
async function moveApplicationChildren(
  client: PoolClient,
  row: MergedOrphanRow,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT id FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
    [row.canonicalWorkerId, row.jobPostingId],
  );
  const survivingWjaId = rows[0]?.id;
  if (!survivingWjaId) return;

  // FK ON DELETE CASCADE (migration 169): sem este re-point, a autoria que
  // alimenta o selo "levantou a mão" morre junto com a linha fantasma.
  await client.query(
    `UPDATE worker_job_application_stage_history SET application_id = $1 WHERE application_id = $2`,
    [survivingWjaId, row.rowId],
  );

  // Notas são lidas por (worker_id, job_posting_id) desde a migration 235, mas a
  // FK antiga (migration 204) segue viva e em CASCADE — os dois lados precisam
  // apontar para a linha que fica.
  await client.query(
    `UPDATE wja_contact_notes
        SET worker_id = $1, worker_job_application_id = $2
      WHERE worker_job_application_id = $3
         OR (worker_id = $4 AND job_posting_id = $5)`,
    [row.canonicalWorkerId, survivingWjaId, row.rowId, row.deadWorkerId, row.jobPostingId],
  );

  // Score do Talentum só preenche buraco — nunca sobrescreve.
  if (row.matchScore !== null) {
    await client.query(
      `UPDATE worker_job_applications
          SET match_score = $1, updated_at = NOW()
        WHERE id = $2 AND match_score IS NULL`,
      [row.matchScore, survivingWjaId],
    );
  }
}

/** Copia para o encuadre que fica os campos de entrevista que ele não tem. */
async function mergeEncuadreFields(client: PoolClient, row: MergedOrphanRow): Promise<void> {
  await client.query(
    `UPDATE encuadres dst
        SET interview_date = COALESCE(dst.interview_date, src.interview_date),
            interview_time = COALESCE(dst.interview_time, src.interview_time),
            meet_link      = COALESCE(dst.meet_link,      src.meet_link),
            resultado      = COALESCE(dst.resultado,      src.resultado),
            attended       = COALESCE(dst.attended,       src.attended)
       FROM encuadres src
      WHERE src.id = $1
        AND dst.worker_id = $2
        AND dst.job_posting_id = $3`,
    [row.rowId, row.canonicalWorkerId, row.jobPostingId],
  );
}

/**
 * Aplica uma linha: reparenta o órfão ou funde-e-descarta o duplicado.
 * O chamador é responsável pela transação, pelo SAVEPOINT por linha e por
 * chamar {@link bypassRegisteredGuard} antes.
 */
export async function reconcileRow(client: PoolClient, row: MergedOrphanRow): Promise<void> {
  const table = row.kind === 'application' ? 'worker_job_applications' : 'encuadres';

  if (!row.duplicate) {
    await client.query(`UPDATE ${table} SET worker_id = $1 WHERE id = $2`, [
      row.canonicalWorkerId,
      row.rowId,
    ]);
    if (row.kind === 'application') {
      // As notas seguem o candidato: sem isto o card reparentado mostraria
      // contact_notes_count = 0 e a thread ficaria inalcançável.
      await client.query(
        `UPDATE wja_contact_notes SET worker_id = $1
          WHERE worker_id = $2 AND job_posting_id = $3`,
        [row.canonicalWorkerId, row.deadWorkerId, row.jobPostingId],
      );
    }
    return;
  }

  if (row.kind === 'application') {
    await moveApplicationChildren(client, row);
  } else {
    await mergeEncuadreFields(client, row);
  }

  await client.query(`DELETE FROM ${table} WHERE id = $1`, [row.rowId]);
}

/**
 * Desfaz uma linha reconciliada.
 *
 * Recria o que foi descartado e devolve o `worker_id` do que foi reparentado.
 * NÃO desfaz os campos preenchidos por COALESCE na linha sobrevivente: são
 * buracos preenchidos com dado da própria pessoa, corretos de qualquer forma, e
 * distingui-los do que já estava lá exigiria uma segunda trilha.
 *
 * @returns true se a linha foi de fato revertida.
 */
export async function rollbackRow(client: PoolClient, row: MergedOrphanRow): Promise<boolean> {
  const table = row.kind === 'application' ? 'worker_job_applications' : 'encuadres';

  if (!row.duplicate) {
    const res = await client.query(`UPDATE ${table} SET worker_id = $1 WHERE id = $2`, [
      row.deadWorkerId,
      row.rowId,
    ]);
    return (res as { rowCount?: number }).rowCount === 1;
  }

  const cols = Object.keys(row.snapshot);
  const res = await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT DO NOTHING
     RETURNING id`,
    cols.map((c) => row.snapshot[c]),
  );
  // ON CONFLICT DO NOTHING devolve 0 linhas quando não inseriu: um re-insert
  // pulado não pode ser contado como revertido.
  return res.rows.length === 1;
}
