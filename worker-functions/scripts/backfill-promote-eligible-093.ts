/**
 * backfill-promote-eligible-093.ts — spec 093 (DF-12, SUP-2, RF-6/RF-7): carga ÚNICA que promove as
 * tentativas bloqueadas (worker_blocked_applications) de workers que JÁ estão elegíveis
 * (status='REGISTERED', não fundido) e nunca foram promovidas nem dispensadas.
 *
 * ⚠️ Roda 1×, MANUAL, com o "vai" do Gabriel. NUNCA no deploy, nunca em workflow, nunca em cron.
 *
 * Padrão é DRY-RUN (só lê). Só escreve com `--execute` explícito.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-promote-eligible-093.ts            # dry-run
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-promote-eligible-093.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-promote-eligible-093.ts --execute
 *
 * Em prd: subir o cloud-sql-proxy da instância de produção na porta 5436 (conforme a memória
 * `acesso-operacional-prod.md`) e exportar DATABASE_URL apontando para ela, com a credencial lida do
 * Secret Manager NA HORA — a senha nunca vai para este arquivo, para o shell history nem para o chat.
 * Rodar o dry-run primeiro e conferir `would_promote` antes do `--execute`.
 *
 * O que ela faz com cada tentativa: `PromoteBlockedApplicationsUseCase.executeForBlockedApplication`
 * (a mesma porta do botão "Promover"), que revalida vaga válida, WJA já existente, elegibilidade do
 * worker e OPT-OUT (SUP-2: quem está em `messaging_opt_out` é pulado com reason `worker_opted_out`).
 * Promover só cria WJA + encuadre + carimba a tentativa; NÃO envia mensagem ao prestador (RF-7).
 *
 * Saída (RF-6): UMA linha JSON, só contagens. `--execute`: `{scanned, promoted, skipped, reasons}`.
 * Dry-run: `{scanned, skipped_opt_out, candidates}` — `candidates` é um TETO (universo menos opt-out), não
 * previsão: as guardas de vaga válida e de WJA existente são do use case (dono único) e o dry-run não as
 * reescreve; o que o `--execute` promove de fato pode ser menor. Sem id, nome, telefone ou e-mail. O logger é silenciado aqui
 * porque o use case loga `workerId`/`blockedApplicationId`.
 *
 * Esta carga não muda `workers.status` (por isso não declara `app.status_flow`).
 */
import { Pool } from 'pg';
import { systemActor } from '@shared/audit/actorSource';
import { logger } from '@shared/logging';
import { optedOutExistsSql } from '@shared/database/messagingOptOutFilter';
import { PromoteBlockedApplicationsUseCase } from '@modules/matching/application/PromoteBlockedApplicationsUseCase';

const ACTOR = systemActor('promote-blocked-backfill-093');

export interface BackfillResult {
  scanned: number;
  promoted: number;
  skipped: number;
  reasons: Record<string, number>;
}

/** Saída do dry-run: `candidates` é TETO (universo menos opt-out), nunca previsão exata. */
export interface DryRunResult {
  scanned: number;
  skipped_opt_out: number;
  candidates: number;
}

interface CandidateRow {
  id: string;
  opted_out: boolean;
}

/** Pendentes de worker elegível; `opted_out` vem do predicado único `optedOutExistsSql`. */
async function listCandidates(pool: Pool): Promise<CandidateRow[]> {
  const { rows } = await pool.query<CandidateRow>(
    `SELECT b.id, ${optedOutExistsSql('b.worker_id')} AS opted_out
       FROM worker_blocked_applications b
       JOIN workers w ON w.id = b.worker_id
      WHERE w.status = 'REGISTERED' AND w.merged_into_id IS NULL
        AND b.promoted_at IS NULL AND b.dismissed_at IS NULL
      ORDER BY b.created_at, b.id`,
  );
  return rows;
}

function bump(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

export async function runBackfill(pool: Pool, opts: { execute: true }): Promise<BackfillResult>;
export async function runBackfill(pool: Pool, opts: { execute: false }): Promise<DryRunResult>;
export async function runBackfill(pool: Pool, opts: { execute: boolean }): Promise<BackfillResult | DryRunResult>;
export async function runBackfill(pool: Pool, opts: { execute: boolean }): Promise<BackfillResult | DryRunResult> {
  const candidates = await listCandidates(pool);

  if (!opts.execute) {
    const optedOut = candidates.filter((c) => c.opted_out).length;
    return { scanned: candidates.length, skipped_opt_out: optedOut, candidates: candidates.length - optedOut };
  }

  const result: BackfillResult = { scanned: candidates.length, promoted: 0, skipped: 0, reasons: {} };
  const useCase = new PromoteBlockedApplicationsUseCase(pool);
  for (const c of candidates) {
    const r = await useCase.executeForBlockedApplication(c.id, ACTOR);
    if (!r) { result.skipped += 1; bump(result.reasons, 'not_pending_anymore'); continue; }
    result.promoted += r.promoted;
    result.skipped += r.skipped;
    for (const [reason, n] of Object.entries(r.reasons)) result.reasons[reason] = (result.reasons[reason] ?? 0) + n;
    if (r.promoted === 0 && r.skipped === 0) { result.skipped += 1; bump(result.reasons, 'no_effect'); }
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--dry-run' && a !== '--execute');
  if (unknown.length > 0 || (args.includes('--dry-run') && args.includes('--execute'))) {
    throw new Error('uso: [--dry-run | --execute]');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente');

  logger.level = 'silent'; // RF-6: stdout só com o JSON de contagens
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runBackfill(pool, { execute: args.includes('--execute') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // Nunca `console.error(err)`: o erro do pg carrega `detail` com a linha. Só nome e code.
    const e = err as { name?: string; code?: string };
    process.stderr.write(`falhou: ${e?.name ?? 'Error'}${e?.code ? ` code=${e.code}` : ''}\n`);
    process.exit(1);
  });
}
