/**
 * backfill-merged-worker-applications.ts
 *
 * Reconcilia as postulações (`worker_job_applications`) e os cards
 * (`encuadres`) que ficaram presos em registros de worker JÁ FUNDIDOS
 * (`merged_into_id IS NOT NULL`).
 *
 * Origem (13/08, caso Norma Araujo, CASO 762-469): o webhook do Talentum
 * resolvia a pessoa pelo e-mail antigo e escrevia no cadastro que já tinha sido
 * fundido em 23/06. A trava `UNIQUE (worker_id, job_posting_id)` não pega, porque
 * os dois IDs são da mesma pessoa mas a constraint só enxerga IDs. Resultado: a
 * mesma candidata aparecia duas vezes no Kanban da mesma vaga, e mover um card
 * não movia o outro. A CAUSA foi fechada em `ProcessTalentumPrescreening`
 * (resolução canônica antes de escrever); este script limpa o que já entrou.
 *
 * Dois casos, tratamento diferente:
 *
 *   1. DUPLICADO — o canônico já tem postulação nesta vaga. A linha do registro
 *      morto é o card fantasma. Descartada. É exatamente a semântica que o
 *      próprio merge usa quando roda (`WorkerDeduplicationService.mergeWorkers`:
 *      `ON CONFLICT DO NOTHING` seguido de `DELETE`) — não estamos inventando
 *      política nova, estamos aplicando a que já existe ao que passou por fora.
 *      Antes de descartar, o `match_score` do Talentum é copiado para a linha
 *      canônica SE ela não tiver um. A etapa do funil NUNCA é sobrescrita: a
 *      canônica costuma estar mais adiantada (CONFIRMED) que a fantasma
 *      (QUALIFIED), e regredir a etapa apagaria trabalho do time.
 *
 *   2. ÓRFÃO — o canônico não tem postulação nesta vaga. Aqui NÃO há duplicata:
 *      é uma postulação real da pessoa, presa no cadastro errado. Reparentada
 *      para o canônico. Descartá-la apagaria candidatura legítima.
 *
 * Nada é apagado sem snapshot: cada linha afetada é gravada como JSON completo
 * num CSV antes da escrita, e `--rollback <csv>` desfaz a operação inteira.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-merged-worker-applications.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-merged-worker-applications.ts --execute
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-merged-worker-applications.ts --rollback <csv>
 *
 * Pré-requisito: cloud-sql-proxy apontando para a instância alvo em DATABASE_URL.
 */

import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';

const ACTOR = systemActor('backfill-merged-worker-applications');
const OUT_DIR = path.join(__dirname, 'backfill-merged-output');

type Mode = 'dry-run' | 'execute' | 'rollback';

interface OrphanRow {
  kind: 'application' | 'encuadre';
  rowId: string;
  deadWorkerId: string;
  canonicalWorkerId: string;
  jobPostingId: string;
  vacancyTitle: string | null;
  stage: string | null;
  matchScore: string | null;
  /** true = o canônico já tem linha nesta vaga (duplicado) → descartar. */
  duplicate: boolean;
  /** Linha inteira, para o rollback recriar exatamente o que foi removido. */
  snapshot: Record<string, unknown>;
}

// ── Leitura ────────────────────────────────────────────────────────────────────

/**
 * Postulações e encuadres ancorados em worker fundido, já classificados em
 * duplicado × órfão. `resolveCanonicalWorkerId` é aplicado em SQL (recursivo)
 * para cobrir cadeias de mais de um salto.
 */
async function findOrphans(db: Pool | PoolClient): Promise<OrphanRow[]> {
  const sql = `
    WITH RECURSIVE chain AS (
      SELECT id AS start_id, id, merged_into_id, 1 AS depth
        FROM workers
       WHERE merged_into_id IS NOT NULL
      UNION ALL
      SELECT c.start_id, w.id, w.merged_into_id, c.depth + 1
        FROM workers w
        JOIN chain c ON w.id = c.merged_into_id
       WHERE c.depth < 10
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
    ORDER BY 1, 6`;

  const { rows } = await db.query(sql);
  return rows.map((r) => ({
    kind: r.kind,
    rowId: r.row_id,
    deadWorkerId: r.dead_worker_id,
    canonicalWorkerId: r.canonical_id,
    jobPostingId: r.job_posting_id,
    vacancyTitle: r.vacancy_title,
    stage: r.stage,
    matchScore: r.match_score,
    duplicate: r.duplicate,
    snapshot: r.snapshot,
  }));
}

// ── Escrita ────────────────────────────────────────────────────────────────────

/** Reparenta o órfão ou descarta o duplicado. Uma linha, um SAVEPOINT. */
async function applyRow(client: PoolClient, row: OrphanRow): Promise<void> {
  const table = row.kind === 'application' ? 'worker_job_applications' : 'encuadres';

  if (!row.duplicate) {
    await client.query(`UPDATE ${table} SET worker_id = $1 WHERE id = $2`, [
      row.canonicalWorkerId,
      row.rowId,
    ]);
    return;
  }

  // Duplicado: preservar o score do Talentum na linha canônica antes de
  // descartar a fantasma — só se a canônica não tiver score. A etapa do funil
  // fica intocada de propósito (a canônica costuma estar mais adiantada).
  if (row.kind === 'application' && row.matchScore !== null) {
    await client.query(
      `UPDATE worker_job_applications
          SET match_score = $1, updated_at = NOW()
        WHERE worker_id = $2 AND job_posting_id = $3 AND match_score IS NULL`,
      [row.matchScore, row.canonicalWorkerId, row.jobPostingId],
    );
  }

  await client.query(`DELETE FROM ${table} WHERE id = $1`, [row.rowId]);
}

/**
 * Rollback: recria o que foi descartado e devolve o `worker_id` do que foi
 * reparentado. Não desfaz o `match_score` copiado — é preenchimento de campo
 * vazio com o dado do Talentum da própria pessoa, correto de qualquer forma.
 */
async function rollbackRow(client: PoolClient, row: OrphanRow): Promise<void> {
  const table = row.kind === 'application' ? 'worker_job_applications' : 'encuadres';

  if (!row.duplicate) {
    await client.query(`UPDATE ${table} SET worker_id = $1 WHERE id = $2`, [
      row.deadWorkerId,
      row.rowId,
    ]);
    return;
  }

  const cols = Object.keys(row.snapshot);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
    cols.map((c) => row.snapshot[c]),
  );
}

// ── Relatório ──────────────────────────────────────────────────────────────────

function report(rows: OrphanRow[]): void {
  const apps = rows.filter((r) => r.kind === 'application');
  const encs = rows.filter((r) => r.kind === 'encuadre');
  const people = new Set(rows.map((r) => r.canonicalWorkerId));

  console.log(`\nPostulações presas em registro fundido: ${apps.length}`);
  console.log(`  duplicadas (card fantasma, descartar): ${apps.filter((r) => r.duplicate).length}`);
  console.log(`  órfãs (postulação real, reparentar):   ${apps.filter((r) => !r.duplicate).length}`);
  console.log(`Encuadres:                               ${encs.length}`);
  console.log(`  duplicados: ${encs.filter((r) => r.duplicate).length}   órfãos: ${encs.filter((r) => !r.duplicate).length}`);
  console.log(`Pessoas afetadas: ${people.size}\n`);

  for (const r of rows) {
    const action = r.duplicate ? 'DESCARTA' : 'REPARENTA';
    console.log(
      `  [${action}] ${r.kind.padEnd(11)} ${r.vacancyTitle ?? '(vaga removida)'} | ` +
        `stage=${r.stage ?? '-'} score=${r.matchScore ?? '-'} | ${r.deadWorkerId} → ${r.canonicalWorkerId}`,
    );
  }
}

function writeSnapshot(rows: OrphanRow[]): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `merged-orphans-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`);
  const header = 'kind,row_id,dead_worker_id,canonical_worker_id,job_posting_id,duplicate,snapshot_json\n';
  const body = rows
    .map((r) =>
      [
        r.kind,
        r.rowId,
        r.deadWorkerId,
        r.canonicalWorkerId,
        r.jobPostingId,
        r.duplicate,
        JSON.stringify(JSON.stringify(r.snapshot)),
      ].join(','),
    )
    .join('\n');
  fs.writeFileSync(file, header + body + '\n');
  return file;
}

function readSnapshot(file: string): OrphanRow[] {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1);
  return lines.map((line) => {
    const firstCols = line.split(',', 6);
    const snapshotJson = line.slice(firstCols.join(',').length + 1);
    return {
      kind: firstCols[0] as OrphanRow['kind'],
      rowId: firstCols[1],
      deadWorkerId: firstCols[2],
      canonicalWorkerId: firstCols[3],
      jobPostingId: firstCols[4],
      vacancyTitle: null,
      stage: null,
      matchScore: null,
      duplicate: firstCols[5] === 'true',
      snapshot: JSON.parse(JSON.parse(snapshotJson)),
    };
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode: Mode = argv.includes('--execute')
    ? 'execute'
    : argv.includes('--rollback')
      ? 'rollback'
      : 'dry-run';

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    if (mode === 'rollback') {
      const csv = argv[argv.indexOf('--rollback') + 1];
      if (!csv || !fs.existsSync(csv)) throw new Error(`CSV de rollback não encontrado: ${csv}`);
      const rows = readSnapshot(csv);
      console.log(`Revertendo ${rows.length} linhas a partir de ${csv}...`);

      const failures: string[] = [];
      await withActorContext(
        pool,
        async (client) => {
          for (const row of rows) {
            await client.query('SAVEPOINT sp');
            try {
              await rollbackRow(client, row);
              await client.query('RELEASE SAVEPOINT sp');
            } catch (err) {
              await client.query('ROLLBACK TO SAVEPOINT sp');
              failures.push(`${row.kind} ${row.rowId}: ${(err as Error).message}`);
            }
          }
        },
        ACTOR,
      );

      console.log(`Revertidas: ${rows.length - failures.length}/${rows.length}`);
      if (failures.length) console.log(`Falhas:\n  ${failures.join('\n  ')}`);
      return;
    }

    const rows = await findOrphans(pool);
    report(rows);

    if (rows.length === 0) {
      console.log('Nada a fazer.');
      return;
    }

    if (mode === 'dry-run') {
      console.log('DRY-RUN — nada foi escrito. Rode com --execute para aplicar.');
      return;
    }

    const csv = writeSnapshot(rows);
    console.log(`Snapshot salvo em ${csv}`);

    // Encuadres antes das applications: o trigger de encuadre reage a INSERT em
    // worker_job_applications, e não queremos que a limpeza recrie o card.
    const ordered = [...rows].sort((a) => (a.kind === 'encuadre' ? -1 : 1));

    const failures: string[] = [];
    await withActorContext(
      pool,
      async (client) => {
        for (const row of ordered) {
          await client.query('SAVEPOINT sp');
          try {
            await applyRow(client, row);
            await client.query('RELEASE SAVEPOINT sp');
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT sp');
            failures.push(`${row.kind} ${row.rowId}: ${(err as Error).message}`);
          }
        }
      },
      ACTOR,
    );

    console.log(`\nAplicadas: ${ordered.length - failures.length}/${ordered.length}`);
    if (failures.length) {
      console.log(`Falhas (revisar à mão):\n  ${failures.join('\n  ')}`);
    }
    console.log(`Rollback: --rollback ${csv}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
