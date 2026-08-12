/**
 * WorkerPhoneMergeOrchestrator
 *
 * CLI entry point para dry-run e execução do merge de workers duplicados.
 *
 * Uso:
 *   # Dry-run (READ-ONLY): computa plano e emite JSON sem escrever
 *   ts-node -r dotenv/config -r tsconfig-paths/register \
 *     src/infrastructure/services/WorkerPhoneMergeOrchestrator.ts --dry-run
 *
 *   # Execução real (escreve no banco configurado em DATABASE_URL)
 *   ts-node -r dotenv/config -r tsconfig-paths/register \
 *     src/infrastructure/services/WorkerPhoneMergeOrchestrator.ts --execute
 *
 *   # Dry-run com output em arquivo
 *   ts-node ... --dry-run > /tmp/merge-plan.json
 *
 * ATENÇÃO: --execute modifica dados. Sempre rodar --dry-run primeiro e revisar.
 */

import { WorkerPhoneMergeService } from './WorkerPhoneMergeService';
import { logger, reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

const log = logger.child({ source: 'WorkerPhoneMergeOrchestrator' });

function parseArgs(): { mode: 'dry-run' | 'execute' } {
  const args = process.argv.slice(2);
  if (args.includes('--execute')) return { mode: 'execute' };
  if (args.includes('--dry-run')) return { mode: 'dry-run' };
  // Default: dry-run (seguro)
  return { mode: 'dry-run' };
}

async function main(): Promise<void> {
  const { mode } = parseArgs();

  log.info({ msg: 'orchestrator_start', mode });

  const service = new WorkerPhoneMergeService();

  try {
    if (mode === 'dry-run') {
      const plan = await service.dryRun();

      // Emite plano estruturado no stdout (pode ser redirecionado para arquivo)
      process.stdout.write(JSON.stringify(plan, null, 2) + '\n');

      // Sumário legível no stderr para não poluir o JSON
      process.stderr.write([
        '',
        '=== DRY-RUN SUMMARY ===',
        `Grupos analisados:        ${plan.total_collision_groups}`,
        `  Firebase (auto-merge):  ${plan.total_firebase_groups}`,
        `  Most complete:          ${plan.total_most_complete_groups}`,
        `  Conflito (manual):      ${plan.total_conflict_groups}`,
        `Ghost matches:            ${plan.total_ghost_matches}`,
        `Ghost orphans:            ${plan.total_ghost_orphans}`,
        `Merges planejados:        ${plan.total_merges_planned}`,
        '',
        'Nenhum dado foi modificado (--dry-run).',
        'Para executar: adicione --execute ao comando.',
        '=======================',
        '',
      ].join('\n'));

      if (plan.conflict_groups.length > 0) {
        process.stderr.write(
          `ATENÇÃO: ${plan.conflict_groups.length} grupo(s) com >1 Firebase real — requerem revisão humana.\n`,
        );
      }

      if (plan.ghost_orphans.length > 0) {
        process.stderr.write(
          `ATENÇÃO: ${plan.ghost_orphans.length} ghost(s) sem match — candidatos a desativar/excluir.\n`,
        );
      }
    } else {
      // mode === 'execute'
      process.stderr.write(
        '\n⚠ MODO EXECUTE: escrevendo no banco. Aguarde...\n',
      );

      const result = await service.execute();

      process.stdout.write(JSON.stringify(result, null, 2) + '\n');

      process.stderr.write([
        '',
        '=== EXECUTE SUMMARY ===',
        `Merges executados:  ${result.merges_executed}`,
        `Merges pulados:     ${result.merges_skipped}`,
        `Erros:              ${result.errors.length}`,
        `Início:             ${result.execution_started_at}`,
        `Fim:                ${result.execution_finished_at}`,
        '=======================',
        '',
      ].join('\n'));

      if (result.errors.length > 0) {
        process.stderr.write('ERROS ENCONTRADOS:\n');
        for (const err of result.errors) {
          process.stderr.write(
            `  phone=${err.phone_normalized} survivor=${err.survivor_id} absorbed=${err.absorbed_id}: ${err.error}\n`,
          );
        }
        process.exitCode = 1;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    reportError(error, { source: 'WorkerPhoneMergeOrchestrator:main', mode });
    process.stderr.write(`FATAL: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    // Fecha pool para o processo terminar limpo
    try {
      await DatabaseConnection.getInstance().getPool().end();
    } catch {
      // ignora erro no shutdown
    }
  }
}

// Só executa quando chamado diretamente (não em import de testes)
if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
