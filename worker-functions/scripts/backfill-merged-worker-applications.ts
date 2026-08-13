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
  findUnresolvedChains,
  reconcileRow,
  rollbackRow,
  bypassRegisteredGuard,
  MergedOrphanRow,
  ReconcileEffects,
} from '@modules/matching/application/ReconcileMergedWorkerApplications';

/** Uma linha reconciliada + o que ela moveu, para o rollback ser simétrico. */
interface SnapshotEntry {
  row: MergedOrphanRow;
  effects: ReconcileEffects;
}

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
//
// JSON, não CSV: o snapshot carrega a linha inteira (com vírgulas e aspas nos
// campos livres) e os ids dos filhos movidos. Contém PII — nome, telefone,
// observações — e por isso o diretório inteiro é gitignorado.

function snapshotPath(): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  return path.join(OUT_DIR, `merged-orphans-${stamp}.json`);
}

function writeSnapshot(file: string, entries: SnapshotEntry[]): void {
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

function readSnapshot(file: string): SnapshotEntry[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotEntry[];
}

// ── Execução ───────────────────────────────────────────────────────────────────

/**
 * Roda `apply` linha a linha sob SAVEPOINT: uma linha que falha não derruba o
 * lote, fica registrada e segue para revisão manual (mesma lição do
 * bulk-archive, onde um guard de trigger travava o lote inteiro).
 */
async function runPerRow(
  pool: Pool,
  entries: SnapshotEntry[],
  apply: (client: PoolClient, entry: SnapshotEntry) => Promise<boolean>,
): Promise<{ ok: number; failures: string[] }> {
  let ok = 0;
  const failures: string[] = [];

  await withActorContext(
    pool,
    async (client) => {
      await bypassRegisteredGuard(client);
      for (const entry of entries) {
        const { row } = entry;
        await client.query('SAVEPOINT sp');
        try {
          const applied = await apply(client, entry);
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
      const file = argv[argv.indexOf('--rollback') + 1];
      if (!file || !fs.existsSync(file)) throw new Error(`Snapshot não encontrado: ${file}`);
      const entries = readSnapshot(file);
      console.log(`Revertendo ${entries.length} linhas a partir de ${file}...`);

      // Ordem inversa da aplicação: as linhas descartadas voltam antes de
      // qualquer reparent ser desfeito.
      const { ok, failures } = await runPerRow(pool, [...entries].reverse(), (client, entry) =>
        rollbackRow(client, entry.row, entry.effects),
      );
      console.log(`Revertidas: ${ok}/${entries.length}`);
      if (failures.length) console.log(`Não revertidas:\n  ${failures.join('\n  ')}`);
      return;
    }

    const unresolved = await findUnresolvedChains(pool);
    if (unresolved.length) {
      console.log(
        `\n⚠️  ${unresolved.length} cadastro(s) com corrente de merge que não termina em ` +
          `worker vivo (ciclo/corrupção) — FORA desta limpeza, precisam de análise manual:\n  ` +
          unresolved.join('\n  '),
      );
    }

    const rows = await findMergedOrphans(pool);
    report(rows);

    if (rows.length === 0) {
      console.log('Nada a reconciliar.');
      return;
    }
    if (mode === 'dry-run') {
      console.log('DRY-RUN — nada foi escrito. Rode com --execute para aplicar.');
      return;
    }

    // Applications antes de encuadres: mover a trilha de etapas depende da WJA
    // canônica, e o encuadre não participa dessa relação.
    const ordered = [...rows].sort((a, b) => {
      if (a.kind === b.kind) return 0;
      return a.kind === 'application' ? -1 : 1;
    });

    const file = snapshotPath();
    const applied: SnapshotEntry[] = [];
    const { ok, failures } = await runPerRow(
      pool,
      ordered.map((row) => ({ row, effects: { movedHistoryIds: [], movedNoteIds: [] } })),
      async (client, entry) => {
        entry.effects = await reconcileRow(client, entry.row);
        // Registrado só depois de aplicar: o snapshot descreve o que de fato
        // mudou, e é isso que o rollback consegue desfazer.
        applied.push(entry);
        return true;
      },
    );

    writeSnapshot(file, applied);
    console.log(`\nAplicadas: ${ok}/${ordered.length}`);
    if (failures.length) console.log(`Falhas (revisar à mão):\n  ${failures.join('\n  ')}`);
    console.log(`Snapshot: ${file}`);
    console.log(`Rollback: --rollback ${file}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
