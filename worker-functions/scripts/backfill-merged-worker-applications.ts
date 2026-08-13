/**
 * backfill-merged-worker-applications.ts
 *
 * CLI da reconciliação de postulações presas em cadastro fundido. A lógica vive
 * em `modules/matching/application/ReconcileMergedWorkerApplications` (testada
 * em e2e contra Postgres real); aqui só ficam argumentos, snapshot e relatório.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-merged-worker-applications.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-merged-worker-applications.ts --execute
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-merged-worker-applications.ts --rollback <csv>
 *
 * Pré-requisito: cloud-sql-proxy apontando para a instância alvo em DATABASE_URL.
 *
 * Ordem recomendada de operação: deployar primeiro o fix da CAUSA
 * (ProcessTalentumPrescreening), senão o webhook do Talentum recria linhas
 * novas logo depois da limpeza.
 */

import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import {
  findMergedOrphans,
  reconcileRow,
  rollbackRow,
  bypassRegisteredGuard,
  MergedOrphanRow,
} from '@modules/matching/application/ReconcileMergedWorkerApplications';

const ACTOR = systemActor('backfill-merged-worker-applications');
const OUT_DIR = path.join(__dirname, 'backfill-merged-output');

type Mode = 'dry-run' | 'execute' | 'rollback';

// ── Relatório ──────────────────────────────────────────────────────────────────

function report(rows: MergedOrphanRow[]): void {
  const apps = rows.filter((r) => r.kind === 'application');
  const encs = rows.filter((r) => r.kind === 'encuadre');
  const people = new Set(rows.map((r) => r.canonicalWorkerId));

  console.log(`\nPostulações presas em cadastro fundido: ${apps.length}`);
  console.log(`  duplicadas (card fantasma, descartar): ${apps.filter((r) => r.duplicate).length}`);
  console.log(`  órfãs (postulação real, reparentar):   ${apps.filter((r) => !r.duplicate).length}`);
  console.log(`Encuadres: ${encs.length}`);
  console.log(`  duplicados: ${encs.filter((r) => r.duplicate).length}   órfãos: ${encs.filter((r) => !r.duplicate).length}`);
  console.log(`Pessoas afetadas: ${people.size}\n`);

  for (const r of rows) {
    const action = r.duplicate ? 'DESCARTA ' : 'REPARENTA';
    console.log(
      `  [${action}] ${r.kind.padEnd(11)} ${r.vacancyTitle ?? '(vaga removida)'} | ` +
        `stage=${r.stage ?? '-'} score=${r.matchScore ?? '-'} | ${r.deadWorkerId} → ${r.canonicalWorkerId}`,
    );
  }
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

function writeSnapshot(rows: MergedOrphanRow[]): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  const file = path.join(OUT_DIR, `merged-orphans-${stamp}.csv`);
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

function readSnapshot(file: string): MergedOrphanRow[] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const head = line.split(',', 6);
      const snapshotJson = line.slice(head.join(',').length + 1);
      return {
        kind: head[0] as MergedOrphanRow['kind'],
        rowId: head[1],
        deadWorkerId: head[2],
        canonicalWorkerId: head[3],
        jobPostingId: head[4],
        vacancyTitle: null,
        stage: null,
        matchScore: null,
        duplicate: head[5] === 'true',
        snapshot: JSON.parse(JSON.parse(snapshotJson)),
      };
    });
}

// ── Execução ───────────────────────────────────────────────────────────────────

/**
 * Roda `apply` linha a linha sob SAVEPOINT: uma linha que falha não derruba o
 * lote, fica registrada e segue para revisão manual (mesma lição do
 * bulk-archive, onde um guard de trigger travava o lote inteiro).
 */
async function runPerRow(
  pool: Pool,
  rows: MergedOrphanRow[],
  apply: (client: PoolClient, row: MergedOrphanRow) => Promise<boolean>,
): Promise<{ ok: number; failures: string[] }> {
  let ok = 0;
  const failures: string[] = [];

  await withActorContext(
    pool,
    async (client) => {
      await bypassRegisteredGuard(client);
      for (const row of rows) {
        await client.query('SAVEPOINT sp');
        try {
          const applied = await apply(client, row);
          await client.query('RELEASE SAVEPOINT sp');
          if (applied) ok += 1;
          else failures.push(`${row.kind} ${row.rowId}: sem efeito (linha já no estado alvo?)`);
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT sp');
          failures.push(`${row.kind} ${row.rowId}: ${(err as Error).message}`);
        }
      }
    },
    ACTOR,
  );

  return { ok, failures };
}

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

      // Ordem inversa da aplicação: as linhas descartadas voltam antes de
      // qualquer reparent ser desfeito.
      const { ok, failures } = await runPerRow(pool, [...rows].reverse(), rollbackRow);
      console.log(`Revertidas: ${ok}/${rows.length}`);
      if (failures.length) console.log(`Não revertidas:\n  ${failures.join('\n  ')}`);
      return;
    }

    const rows = await findMergedOrphans(pool);
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

    // Applications antes de encuadres: mover a trilha de etapas depende da WJA
    // canônica, e o encuadre não participa dessa relação.
    const ordered = [...rows].sort((a, b) => {
      if (a.kind === b.kind) return 0;
      return a.kind === 'application' ? -1 : 1;
    });

    const { ok, failures } = await runPerRow(pool, ordered, async (client, row) => {
      await reconcileRow(client, row);
      return true;
    });

    console.log(`\nAplicadas: ${ok}/${ordered.length}`);
    if (failures.length) console.log(`Falhas (revisar à mão):\n  ${failures.join('\n  ')}`);
    console.log(`Rollback: --rollback ${csv}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
