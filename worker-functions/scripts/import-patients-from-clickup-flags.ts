/**
 * import-patients-from-clickup-flags.ts
 *
 * Parser PURO dos flags do CLI de `import-patients-from-clickup.ts`. Extraído para ser
 * testável sem rodar o script inteiro (que faz I/O de rede/DB e `process.exit`).
 *
 * `--apply` é a ÚNICA combinação que grava — dry-run é o DEFAULT (decisão 11/09/2026: carga
 * do ClickUp só pontual/manual, nunca agendada; ver cabeçalho de import-patients-from-clickup.ts).
 * Mesma disciplina do `backfill-diagnosis-catalog/cli-guards.ts` (D10 do ingestor CID-11):
 * falha visível, nunca escrita por omissão.
 */

export interface ImportPatientsFlags {
  /** true = grava no banco. Default false (dry-run). Só `--apply` liga isto. */
  apply: boolean;
  /** `--task-id <id>`: carga de UMA task específica (GET direto), sem paginar a lista.
   *  Cobre o caso antes servido por `resync-one-clickup-task.ts` (removido 11/09/2026). */
  taskId: string | null;
  /** `--limit N`: processa só as N primeiras tasks (após filtro de status). null = sem limite. */
  limit: number | null;
  /** `--status X,Y,Z`: filtra por `status.status` (comma-separated, case-insensitive). */
  statusFilter: string[];
  /** `--verbose`: imprime o payload mapeado inteiro por task. */
  verbose: boolean;
}

function flagValue(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

export function parseImportPatientsFlags(argv: string[]): ImportPatientsFlags {
  const apply = argv.includes('--apply');

  const taskId = flagValue(argv, '--task-id');

  const limitRaw = flagValue(argv, '--limit');
  const limit = limitRaw !== null ? parseInt(limitRaw, 10) : null;

  const statusFilterRaw = flagValue(argv, '--status');
  const statusFilter = statusFilterRaw
    ? statusFilterRaw.split(',').map(s => s.trim().toLowerCase())
    : [];

  const verbose = argv.includes('--verbose');

  return { apply, taskId, limit, statusFilter, verbose };
}
