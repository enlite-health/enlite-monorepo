/**
 * reconciliar-talentum-sem-worker.ts — CLI: re-resolve `talentum_prescreenings.worker_id IS NULL` (vaga viva) e avança o funil.
 * A lógica mora em `reconciliar-talentum-sem-worker-lib.ts`; aqui só composição (Pool, Talentum read-only, relatório).
 *
 * Uso:
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/reconciliar-talentum-sem-worker.ts --dry-run
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/reconciliar-talentum-sem-worker.ts --apply
 *
 * `--dry-run` executa cada linha inteira e dá ROLLBACK. Talentum: só GET (`TalentumApiClient.listCandidates` /
 * `listReadyForInterview`). Caso ambíguo (>1 worker) não é aplicado. Sem mensagem: não emite domain_event nem Pub/Sub.
 * Saída: só IDs, etapas e contagens.
 */
import { Pool, type PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { TalentumApiClient } from '@modules/integration/infrastructure/TalentumApiClient';
import type { TalentumCandidate } from '@modules/integration/domain/ITalentumApiClient';
import { formatTotals, parseReconcileArgs, PENDING_SQL, reconcile, type PendingRow, type TalentumReader } from './reconciliar-talentum-sem-worker-lib';

const JOB = 'reconciliar-talentum-sem-worker';
const MAX_PAGES = 50;

function target(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}${u.pathname} user=${u.username}`;
}

async function readAll(fetchPage: (page: number) => Promise<{ candidates: TalentumCandidate[]; total: number }>): Promise<TalentumCandidate[]> {
  const all: TalentumCandidate[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchPage(page);
    if (res.candidates.length === 0) break;
    all.push(...res.candidates);
    if (all.length >= res.total) break;
  }
  return all;
}

async function main(): Promise<void> {
  const { mode } = parseReconcileArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente');
  console.log(`alvo=${target(url)} modo=${mode}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const client = await TalentumApiClient.create();
  const talentum: TalentumReader = {
    candidates: (projectId) => readAll((p) => client.listCandidates(projectId, p)),
    readyForInterview: (projectId) => readAll((p) => client.listReadyForInterview(projectId, p)),
  };
  try {
    const outcomes = await reconcile({
      talentum,
      runInTransaction: <T,>(fn: (c: PoolClient) => Promise<T>) => withActorContext(pool, fn, systemActor(JOB)),
      listPending: async () => {
        const r = await pool.query(PENDING_SQL);
        return r.rows.map((x): PendingRow => ({
          id: x.id, talentumPrescreeningId: x.talentum_prescreening_id, talentumProfileId: x.talentum_profile_id,
          status: x.status, jobPostingId: x.job_posting_id, talentumProjectId: x.talentum_project_id,
        }));
      },
      log: console.log,
    }, mode);
    for (const l of formatTotals(outcomes, mode)) console.log(l);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`${JOB} falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
