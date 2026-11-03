/**
 * Backfill de `job_postings.talentum_prescreening_id` (migration 558). O webhook PRESCREENING_RESPONSE traz
 * `data.prescreening.id` ≠ `talentum_project_id`; a ligação é `GET /projects/{talentum_project_id}/prescreening`
 * → `_id`. Para cada vaga VIVA com projeto e sem prescreening id, lê o `_id` e grava.
 *
 *   --dry-run   só GET + relatório (candidatas, obtidos, não-200, colisões). Conexão read-only PROVADA.
 *   --apply     grava (UPDATE só onde a coluna ainda é NULL), pulando colisões.
 *
 * Outbound: só GET na Talentum (mais o login), provado pelo contador de métodos (`writes` tem de ser 0).
 * Saída: contagens e `job_posting_id` — nunca título, nome ou PII.
 */

import type { ITalentumApiClient } from '../domain/ITalentumApiClient';
import type { FetchStats } from './fetchMethodCounter';

export interface BackfillDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export interface BackfillDeps {
  openDb(readOnly: boolean): BackfillDb;
  openClient(): Promise<Pick<ITalentumApiClient, 'getPrescreening'>>;
  httpStats(): FetchStats;
  log(line: string): void;
}

const CANDIDATES_SQL = `SELECT id, talentum_project_id FROM job_postings
  WHERE deleted_at IS NULL AND talentum_project_id IS NOT NULL AND talentum_prescreening_id IS NULL
  ORDER BY id`;
const TAKEN_SQL = `SELECT talentum_prescreening_id FROM job_postings
  WHERE deleted_at IS NULL AND talentum_prescreening_id IS NOT NULL`;
const UPDATE_SQL = `UPDATE job_postings SET talentum_prescreening_id = $1, updated_at = NOW()
  WHERE id = $2 AND talentum_prescreening_id IS NULL AND deleted_at IS NULL`;
const READ_ONLY_PROBE = 'CREATE TEMP TABLE backfill_ro_probe(i int)';

async function proveReadOnly(db: BackfillDb, log: (l: string) => void): Promise<void> {
  const show = await db.query('SHOW default_transaction_read_only');
  if (show.rows[0].default_transaction_read_only !== 'on') {
    throw new Error('dry-run recusado: a conexão NÃO está read-only');
  }
  try {
    await db.query(READ_ONLY_PROBE);
  } catch (err) {
    log(`prova read-only: a escrita de teste falhou como devia (${(err as Error).message})`);
    return;
  }
  throw new Error('dry-run recusado: a escrita de teste NÃO falhou (read-only não provado)');
}

export async function runBackfillCli(argv: string[], deps: BackfillDeps): Promise<number> {
  const apply = argv.includes('--apply');
  const dry = argv.includes('--dry-run');
  const { log } = deps;
  if (apply === dry) {
    log('uso: backfill-talentum-prescreening-id (--dry-run | --apply) — exatamente um dos dois');
    return 2;
  }

  const db = deps.openDb(dry);
  try {
    if (dry) await proveReadOnly(db, log);
    const client = await deps.openClient();
    const candidates = (await db.query(CANDIDATES_SQL)).rows as Array<{ id: string; talentum_project_id: string }>;
    const taken = new Set((await db.query(TAKEN_SQL)).rows.map((r) => String(r.talentum_prescreening_id)));

    const fetched: Array<{ jobPostingId: string; prescreeningId: string }> = [];
    const notOk: string[] = [];
    for (const c of candidates) {
      try {
        const detail = await client.getPrescreening(c.talentum_project_id);
        if (detail.projectId === c.talentum_project_id && detail.prescreeningId) {
          fetched.push({ jobPostingId: c.id, prescreeningId: detail.prescreeningId });
        } else {
          notOk.push(c.id);
        }
      } catch {
        notOk.push(c.id);
      }
    }

    const perId = new Map<string, number>();
    for (const f of fetched) perId.set(f.prescreeningId, (perId.get(f.prescreeningId) ?? 0) + 1);
    const colliding = fetched.filter((f) => taken.has(f.prescreeningId) || perId.get(f.prescreeningId)! > 1);
    const writable = fetched.filter((f) => !colliding.includes(f));

    log(`${apply ? 'APPLY' : 'DRY-RUN'} — vagas candidatas=${candidates.length} | obtidos=${fetched.length} | não-200/sem _id=${notOk.length} | colidiriam no índice=${colliding.length}`);
    log(`não obtidos (job_posting_id): ${notOk.join(',') || '-'}`);
    log(`colisões (job_posting_id): ${colliding.map((c) => c.jobPostingId).join(',') || '-'}`);

    let written = 0;
    if (apply) {
      for (const w of writable) {
        const r = await db.query(UPDATE_SQL, [w.prescreeningId, w.jobPostingId]);
        written += (r as { rowCount?: number }).rowCount ?? 0;
      }
      log(`gravadas: ${written}`);
    }

    const http = deps.httpStats();
    log(`HTTP por método: ${JSON.stringify(http.byMethod)} | escritas na Talentum: ${http.writes}`);
    return http.writes === 0 ? 0 : 1;
  } finally {
    await db.end();
  }
}
