/**
 * Casca de linha de comando da reconciliação Talentum v2 (spec 040 / F5). O script
 * `scripts/reconcile-talentum-v2.ts` só liga as dependências reais; toda a decisão mora aqui, testável.
 *
 *   (sem flag)              DRY-RUN: lê, planeja, imprime contagens. Conexão `default_transaction_read_only=on`
 *                           PROVADA antes (SHOW + escrita de teste que TEM de falhar) e 0 escritas na Talentum
 *                           (contador de métodos). Falha (rc 1) se a contagem `wa.me` mudar ou houver escrita.
 *   --csv-out <arq>         grava o CSV de rollback (valores antigos das linhas que seriam alteradas).
 *   --execute --csv-out X   ESCREVE: grava o CSV (recusa sobrescrever), confere que existe, e só então aplica
 *                           numa transação. Recusa se algum detalhe de projeto falhou (plano incompleto).
 *   --rollback <csv>        restaura os 4 campos do CSV, numa transação.
 *
 * Saída: só contagens e `job_posting_id` — nunca título, nome ou PII.
 */

import type { ITalentumApiClient } from '../domain/ITalentumApiClient';
import { parseRollbackCsv, serializeRollbackCsv } from './ReconcileRollbackCsv';
import {
  ReconcileTalentumV2UseCase,
  applyReconcile,
  restoreRollbackRows,
  rollbackRowsOf,
  type ReconcileDb,
} from './ReconcileTalentumV2UseCase';
import type { FetchStats } from './fetchMethodCounter';

export interface CliDeps {
  openDb(readOnly: boolean): ReconcileDb & { end(): Promise<void> };
  openClient(): Promise<Pick<ITalentumApiClient, 'listAllPrescreenings' | 'getPrescreening'>>;
  fs: { exists(path: string): boolean; write(path: string, text: string): void; read(path: string): string };
  httpStats(): FetchStats;
  log(line: string): void;
}

const WA_ME_SQL = `SELECT count(*)::int AS n FROM job_postings WHERE talentum_whatsapp_url LIKE 'https://wa.me/%'`;
const READ_ONLY_PROBE = 'CREATE TEMP TABLE reconcile_ro_probe(i int)';

function parseArgs(argv: string[]): { execute: boolean; rollback?: string; csvOut?: string } | string {
  const execute = argv.includes('--execute');
  const valueOf = (flag: string): string | undefined | null => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : null;
  };
  const rollback = valueOf('--rollback');
  const csvOut = valueOf('--csv-out');
  if (rollback === null) return '--rollback exige o caminho do CSV';
  if (csvOut === null) return '--csv-out exige o caminho do CSV';
  if (execute && rollback) return '--execute e --rollback não combinam';
  if (execute && !csvOut) return '--execute exige --csv-out <arquivo> (rollback pronto ANTES de escrever)';
  return { execute, rollback, csvOut };
}

async function proveReadOnly(db: ReconcileDb, log: (l: string) => void): Promise<void> {
  const show = await db.query('SHOW default_transaction_read_only');
  const value = show.rows[0].default_transaction_read_only;
  log(`default_transaction_read_only = ${value}`);
  if (value !== 'on') throw new Error('dry-run recusado: a conexão NÃO está read-only');
  try {
    await db.query(READ_ONLY_PROBE);
  } catch (err) {
    log(`prova read-only: ${READ_ONLY_PROBE} -> ${(err as Error).message}`);
    return;
  }
  throw new Error('dry-run recusado: a escrita de teste NÃO falhou (read-only não provado)');
}

async function countWaMe(db: ReconcileDb): Promise<number> {
  return (await db.query(WA_ME_SQL)).rows[0].n as number;
}

export async function runReconcileCli(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    deps.log(`uso: reconcile-talentum-v2 [--execute --csv-out <csv>] [--csv-out <csv>] [--rollback <csv>] — ${args}`);
    return 2;
  }
  const { log, fs } = deps;
  const db = deps.openDb(!args.execute && !args.rollback);
  try {
    if (args.rollback) {
      const rows = parseRollbackCsv(fs.read(args.rollback));
      const restored = await restoreRollbackRows(db, rows);
      log(`ROLLBACK: ${restored} vagas restauradas de ${args.rollback}`);
      return 0;
    }

    if (!args.execute) await proveReadOnly(db, log);
    const waBefore = await countWaMe(db);
    const useCase = new ReconcileTalentumV2UseCase(db, await deps.openClient());
    const { changes, report } = await useCase.plan();
    const mode = args.execute ? 'EXECUTE' : 'DRY-RUN';
    log(`${mode} — projetos v2=${report.projects} | vagas candidatas=${report.vacancies}`);
    log(`ligadas por publicId: ${report.linkedByPublicId} · por título: ${report.linkedByTitle} · sem par: ${report.noMatch} · ambíguas: ${report.ambiguous} · inválidas: ${report.invalid} · já corretas: ${report.alreadyCorrect}`);
    log(`projetos v2 sem vaga par (o sync de vagas criaria, no máx.): ${report.projectsWithoutVacancy}`);
    log(`erros de detalhe (projectId): ${report.detailErrors.length}${report.detailErrors.length ? ` ${report.detailErrors.join(',')}` : ''}`);
    log(`sem par (job_posting_id): ${report.noMatchIds.join(',') || '-'}`);
    log(`ambíguas (job_posting_id): ${report.ambiguousIds.join(',') || '-'}`);
    log(`inválidas (job_posting_id): ${report.invalidIds.join(',') || '-'}`);

    if (args.execute && report.detailErrors.length > 0) {
      log('EXECUTE recusado: o plano está incompleto (detalhe de projeto falhou) — nada foi escrito');
      return 1;
    }
    if (args.csvOut) {
      if (fs.exists(args.csvOut)) {
        log(`recusado: ${args.csvOut} já existe (não sobrescrevo rollback)`);
        return 1;
      }
      fs.write(args.csvOut, serializeRollbackCsv(rollbackRowsOf(changes)));
      if (!fs.exists(args.csvOut)) {
        log('recusado: o CSV de rollback não foi gravado');
        return 1;
      }
      log(`rollback CSV: ${args.csvOut} (${changes.length} linhas)`);
    }
    if (args.execute) log(`aplicadas: ${await applyReconcile(db, changes)}`);

    const waAfter = await countWaMe(db);
    const http = deps.httpStats();
    log(`wa.me antes: ${waBefore} · depois: ${waAfter}`);
    log(`Talentum HTTP por método: ${JSON.stringify(http.byMethod)} · escritas (≠GET, fora do login): ${http.writes}`);
    if (!args.execute && (waAfter !== waBefore || http.writes > 0)) {
      log('FALHA: o dry-run alterou algo');
      return 1;
    }
    return 0;
  } catch (err) {
    log(`ERRO: ${(err as Error).message}`);
    return 1;
  } finally {
    await db.end();
  }
}
