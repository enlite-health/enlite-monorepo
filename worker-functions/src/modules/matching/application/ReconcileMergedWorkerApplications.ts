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
  /**
   * true = já existe outra linha que fica nesta vaga (a do canônico, ou a de
   * outro cadastro morto da mesma corrente que foi eleito) → descartar esta.
   */
  duplicate: boolean;
  /** Linha inteira, para o rollback recriar exatamente o que foi removido. */
  snapshot: Record<string, unknown>;
}

/** Filhos movidos numa reconciliação, para o rollback devolver. */
export interface ReconcileEffects {
  movedHistoryIds: string[];
  movedNoteIds: string[];
}

/** Alcance da corrente de merge — mesmo teto de `resolveCanonicalWorkerId`. */
const MAX_CHAIN_DEPTH = 10;

/**
 * Cadastros fundidos cuja corrente NÃO termina num worker vivo dentro do teto
 * (ciclo/corrupção). Ficam de fora de {@link findMergedOrphans} porque não há
 * canônico para onde apontar — e precisam ser ditos em voz alta, senão o
 * operador lê "nada a fazer" e conclui que a limpeza acabou.
 */
export async function findUnresolvedChains(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<string[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id AS start_id, id, merged_into_id, 0 AS depth
         FROM workers WHERE merged_into_id IS NOT NULL
       UNION ALL
       SELECT c.start_id, w.id, w.merged_into_id, c.depth + 1
         FROM workers w JOIN chain c ON w.id = c.merged_into_id
        WHERE c.depth < $1
     )
     SELECT DISTINCT start_id::text AS id FROM chain
      WHERE start_id NOT IN (SELECT start_id FROM chain WHERE merged_into_id IS NULL)`,
    [MAX_CHAIN_DEPTH],
  );
  return rows.map((r) => r.id as string);
}

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
     ),
     raw AS (
       SELECT 'application' AS kind, a.id::text AS row_id, a.worker_id::text AS dead_worker_id,
              c.canonical_id::text AS canonical_id, a.job_posting_id::text AS job_posting_id,
              jp.title AS vacancy_title,
              a.application_funnel_stage AS stage, a.match_score::text AS match_score,
              EXISTS (
                SELECT 1 FROM worker_job_applications dup
                 WHERE dup.worker_id = c.canonical_id AND dup.job_posting_id = a.job_posting_id
              ) AS canonical_has_row,
              a.created_at,
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
              e.created_at,
              to_jsonb(e.*)
         FROM encuadres e
         JOIN canonical c ON c.dead_id = e.worker_id
         LEFT JOIN job_postings jp ON jp.id = e.job_posting_id
     )
     -- Duas linhas mortas da MESMA corrente na MESMA vaga (A→C e B→C, ou a
     -- cadeia A→B→C) não podem ser as duas reparentadas: a segunda estouraria
     -- 23505 na unique e ficaria no cadastro morto, mantendo o card duplicado.
     -- Elege-se a mais antiga como a que fica; as demais viram descarte.
     SELECT kind, row_id, dead_worker_id, canonical_id, job_posting_id, vacancy_title,
            stage, match_score, snapshot,
            (canonical_has_row OR ROW_NUMBER() OVER (
               PARTITION BY kind, canonical_id, job_posting_id ORDER BY created_at, row_id
             ) > 1) AS duplicate
       FROM raw
      ORDER BY kind, vacancy_title`,
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

/** Erro de linha: o SAVEPOINT do chamador isola e manda para revisão manual. */
export class ReconcileRowError extends Error {}

/** Move a trilha e as notas da WJA fantasma para a canônica, antes do DELETE. */
async function moveApplicationChildren(
  client: PoolClient,
  row: MergedOrphanRow,
): Promise<ReconcileEffects> {
  const { rows } = await client.query(
    `SELECT id FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
    [row.canonicalWorkerId, row.jobPostingId],
  );
  const survivingWjaId = rows[0]?.id;

  // Fail-closed. `duplicate` foi calculado numa leitura anterior; se a linha
  // canônica não está mais aqui (merge concorrente, CSV antigo re-executado),
  // seguir para o DELETE apagaria a ÚNICA postulação da pessoa nesta vaga, com
  // CASCADE na trilha e nas notas. Melhor falhar e deixar para revisão.
  if (!survivingWjaId) {
    throw new ReconcileRowError(
      `marcada como duplicada, mas o canônico ${row.canonicalWorkerId} não tem ` +
        `postulação na vaga ${row.jobPostingId} — nada foi apagado`,
    );
  }

  // FK ON DELETE CASCADE (migration 169): sem este re-point, a autoria que
  // alimenta o selo "levantou a mão" morre junto com a linha fantasma.
  const history = await client.query(
    `UPDATE worker_job_application_stage_history SET application_id = $1
      WHERE application_id = $2 RETURNING id`,
    [survivingWjaId, row.rowId],
  );

  // Notas são lidas por (worker_id, job_posting_id) desde a migration 235, mas a
  // FK antiga (migration 204) segue viva e em CASCADE — os dois lados precisam
  // apontar para a linha que fica.
  const notes = await client.query(
    `UPDATE wja_contact_notes
        SET worker_id = $1, worker_job_application_id = $2
      WHERE worker_job_application_id = $3
         OR (worker_id = $4 AND job_posting_id = $5)
      RETURNING id`,
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

  return {
    movedHistoryIds: history.rows.map((r) => r.id as string),
    movedNoteIds: notes.rows.map((r) => r.id as string),
  };
}

/** Colunas que identificam a linha ou são mantidas pelo banco — nunca copiadas. */
const ENCUADRE_KEY_COLUMNS = ['id', 'worker_id', 'job_posting_id', 'created_at', 'updated_at'];

/**
 * Copia para o encuadre que fica TODO campo que ele não tem.
 *
 * Dinâmico de propósito: uma lista fixa envelhece a cada coluna nova e faz o
 * `DELETE` seguinte virar perda silenciosa de dado operacional
 * (`recruitment_date`, `obs_*`, `rejection_reason*`, `recruiter_name`…). A
 * migration 192 consolidou encuadres duplicados pelo mesmo princípio, elegendo
 * o sobrevivente por quantidade de campos preenchidos.
 */
async function mergeEncuadreFields(client: PoolClient, row: MergedOrphanRow): Promise<void> {
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'encuadres'
        AND is_generated = 'NEVER' AND identity_generation IS NULL
        AND column_name <> ALL($1::text[])
      ORDER BY ordinal_position`,
    [ENCUADRE_KEY_COLUMNS],
  );

  if (cols.length === 0) return;

  const assignments = cols
    .map(({ column_name: c }) => `"${c}" = COALESCE(dst."${c}", src."${c}")`)
    .join(', ');

  await client.query(
    `UPDATE encuadres dst SET ${assignments}
       FROM encuadres src
      WHERE src.id = $1 AND dst.worker_id = $2 AND dst.job_posting_id = $3`,
    [row.rowId, row.canonicalWorkerId, row.jobPostingId],
  );
}

/**
 * Aplica uma linha: reparenta o órfão ou funde-e-descarta o duplicado.
 * O chamador é responsável pela transação, pelo SAVEPOINT por linha e por
 * chamar {@link bypassRegisteredGuard} antes.
 */
export async function reconcileRow(
  client: PoolClient,
  row: MergedOrphanRow,
): Promise<ReconcileEffects> {
  const table = row.kind === 'application' ? 'worker_job_applications' : 'encuadres';
  const none: ReconcileEffects = { movedHistoryIds: [], movedNoteIds: [] };

  if (!row.duplicate) {
    await client.query(`UPDATE ${table} SET worker_id = $1 WHERE id = $2`, [
      row.canonicalWorkerId,
      row.rowId,
    ]);
    if (row.kind !== 'application') return none;

    // As notas seguem o candidato: sem isto o card reparentado mostraria
    // contact_notes_count = 0 e a thread ficaria inalcançável.
    const notes = await client.query(
      `UPDATE wja_contact_notes SET worker_id = $1
        WHERE worker_id = $2 AND job_posting_id = $3
        RETURNING id`,
      [row.canonicalWorkerId, row.deadWorkerId, row.jobPostingId],
    );
    return { movedHistoryIds: [], movedNoteIds: notes.rows.map((r) => r.id as string) };
  }

  const effects =
    row.kind === 'application' ? await moveApplicationChildren(client, row) : none;
  if (row.kind === 'encuadre') await mergeEncuadreFields(client, row);

  await client.query(`DELETE FROM ${table} WHERE id = $1`, [row.rowId]);
  return effects;
}

/**
 * Desfaz uma linha reconciliada, incluindo os filhos que ela moveu.
 *
 * Recria o que foi descartado, devolve o `worker_id` do que foi reparentado e
 * re-aponta trilha e notas para onde estavam. Sem os `effects`, o rollback
 * deixaria o card de volta com `contactNotesCount = 0` e as notas penduradas no
 * candidato errado — pior que o estado original.
 *
 * NÃO desfaz os campos preenchidos por COALESCE na linha sobrevivente: são
 * buracos preenchidos com dado da própria pessoa, corretos de qualquer forma, e
 * distingui-los do que já estava lá exigiria uma segunda trilha.
 *
 * @returns true se a linha foi de fato revertida.
 */
export async function rollbackRow(
  client: PoolClient,
  row: MergedOrphanRow,
  effects?: ReconcileEffects,
): Promise<boolean> {
  const table = row.kind === 'application' ? 'worker_job_applications' : 'encuadres';

  if (!row.duplicate) {
    const res = await client.query(`UPDATE ${table} SET worker_id = $1 WHERE id = $2`, [
      row.deadWorkerId,
      row.rowId,
    ]);
    if ((res as { rowCount?: number }).rowCount !== 1) return false;

    if (effects?.movedNoteIds.length) {
      await client.query(
        `UPDATE wja_contact_notes SET worker_id = $1 WHERE id = ANY($2::uuid[])`,
        [row.deadWorkerId, effects.movedNoteIds],
      );
    }
    return true;
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
  if (res.rows.length !== 1) return false;

  // A linha volta com o mesmo id (vem do snapshot), então basta re-apontar.
  if (effects?.movedHistoryIds.length) {
    await client.query(
      `UPDATE worker_job_application_stage_history SET application_id = $1 WHERE id = ANY($2::uuid[])`,
      [row.rowId, effects.movedHistoryIds],
    );
  }
  if (effects?.movedNoteIds.length) {
    await client.query(
      `UPDATE wja_contact_notes SET worker_id = $1, worker_job_application_id = $2
        WHERE id = ANY($3::uuid[])`,
      [row.deadWorkerId, row.rowId, effects.movedNoteIds],
    );
  }
  return true;
}
