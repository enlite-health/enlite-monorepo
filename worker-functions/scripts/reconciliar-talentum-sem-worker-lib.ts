/**
 * Lógica do CLI `reconciliar-talentum-sem-worker.ts` (orquestrador com Pool fica no CLI).
 *
 * Contexto (prd, 04/11): o webhook do Talentum procurava o worker pelo telefone CRU (sem o 9 do celular AR),
 * não achava, e gravava `talentum_prescreenings.worker_id = NULL`; a candidata ficava QUALIFIED no Talentum e
 * "Iniciados" no app. Este script re-resolve o worker dessas linhas e avança o funil SEM enviar mensagem:
 * não insere `domain_events` (`funnel_stage.qualified` dispara mensagem/agenda entrevista) nem publica no Pub/Sub.
 *
 * Reuso do webhook (`matching/application/talentumFunnel.ts`, uma só implementação): mapeamento de etapa (ANALYZED usa o
 * statusLabel), transição NOT_QUALIFIED (WJA REJECTED + encuadre RECHAZADO, eventos audit-only, sem mensagem) e auto-create
 * do worker (colisão/falha → lista, sem insistir). Ambíguo (>1 worker) continua só na lista.
 *
 * Saída: só IDs, etapas e contagens — nunca nome, telefone ou e-mail.
 */
import * as crypto from 'crypto';
import type { PoolClient } from 'pg';
import { resolveCanonicalWorkerId } from '../src/shared/database/resolveCanonicalWorkerId';
import { resolveLiveCanonicalWorkerIds } from '../src/shared/database/resolveLiveCanonicalWorkerIds';
import { generatePhoneCandidates, normalizePhoneAR } from '../src/shared/utils/phoneNormalization';
import type { TalentumCandidate } from '../src/modules/integration/domain/ITalentumApiClient';
// Implementação ÚNICA do webhook (não duplicada aqui): mapeamento de etapa, transição NOT_QUALIFIED e auto-create.
import {
  applyNotQualifiedTransition, funnelStageFromStoredStatus, insertTalentumWorker, toPersistedFunnelStage,
} from '../src/modules/matching/application/talentumFunnel';
import { vacancyIsDeBaja } from '../src/modules/matching/interfaces/controllers/vacancyDeBajaGuard';

export type ReconcileMode = 'dry-run' | 'apply';

/** Exatamente um de `--dry-run` / `--apply`. Sem modo explícito, recusa (nunca grava por omissão). */
export function parseReconcileArgs(argv: readonly string[]): { mode: ReconcileMode } {
  const dry = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  if (dry === apply) throw new Error('use exatamente um de --dry-run ou --apply');
  return { mode: apply ? 'apply' : 'dry-run' };
}

export interface PendingRow {
  id: string;
  talentumPrescreeningId: string;
  talentumProfileId: string;
  status: string;
  jobPostingId: string;
  talentumProjectId: string;
}

/** Leitura SOMENTE-LEITURA do Talentum (GET), por projeto. */
export interface TalentumReader {
  candidates(projectId: string): Promise<TalentumCandidate[]>;
  /** Qualificados do projeto — única listagem que traz e-mail. */
  readyForInterview(projectId: string): Promise<TalentumCandidate[]>;
}

export type Outcome =
  | { kind: 'RESOLVED'; rowId: string; workerId: string; stage: string | null; committed: boolean }
  | { kind: 'AMBIGUOUS'; rowId: string; workerIds: string[] }
  | { kind: 'NO_WORKER'; rowId: string; reason?: string }
  | { kind: 'NOT_IN_TALENTUM'; rowId: string }
  | { kind: 'DEFERRED'; rowId: string; reason: string }
  | { kind: 'ERROR'; rowId: string; error: string };

/** Sinal interno: desfaz a transação (dry-run) devolvendo o desfecho. */
export class RollbackWith extends Error {
  constructor(readonly outcome: Outcome) {
    super('reconcile rollback');
  }
}

export type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/** `statusLabel` do Talentum para o ANALYZED: o campo da candidata, ou QUALIFIED se está na lista de qualificados. */
export function analyzedLabel(candidate: TalentumCandidate, qualified: boolean): string | null {
  const own = candidate['statusLabel'];
  if (typeof own === 'string' && ['QUALIFIED', 'NOT_QUALIFIED', 'IN_DOUBT', 'PENDING'].includes(own)) return own;
  return qualified ? 'QUALIFIED' : null;
}

/** Causa SEM PII: erro do pg (tem `code`) → só code/constraint (a mensagem pode ecoar valor); erro nosso → 1ª linha. */
export function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e?.code) return [`code=${e.code}`, e.constraint ? `constraint=${e.constraint}` : null].filter(Boolean).join(' ');
  return (e?.message ?? String(err)).split('\n')[0];
}

export const PENDING_SQL = `
  SELECT tp.id, tp.talentum_prescreening_id, tp.talentum_profile_id, tp.status, tp.job_posting_id, jp.talentum_project_id
    FROM talentum_prescreenings tp
    JOIN job_postings jp ON jp.id = tp.job_posting_id AND jp.deleted_at IS NULL
   WHERE tp.worker_id IS NULL
     AND tp.environment = 'production'
     AND jp.talentum_project_id IS NOT NULL
   ORDER BY tp.created_at, tp.id`;

/**
 * Workers que casam por e-mail, telefone (com/sem o 9) ou o auth_uid sintético do auto-create. Mesma regra do webhook
 * (D111): inclui FUNDIDOS, exclui deletados, segue a cadeia até o sobrevivente vivo e deduplica
 * (`resolveLiveCanonicalWorkerIds`). Devolve os sobreviventes distintos: mais de um = ambíguo (o script não escolhe).
 * Cadeia que não resolve (ciclo) descarta o id: o script nunca grava em cadastro fundido.
 */
export async function findLiveWorkerIds(
  client: Pick<PoolClient, 'query'>, candidate: TalentumCandidate, email: string | null, profileId: string,
): Promise<string[]> {
  const phones = candidate.phoneNumber ? generatePhoneCandidates(candidate.phoneNumber) : [];
  const res = await client.query<{ id: string }>(
    `SELECT DISTINCT id FROM workers
      WHERE deleted_at IS NULL
        AND ( auth_uid = $1
           OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2))
           OR (cardinality($3::text[]) > 0 AND phone = ANY($3::text[])) )`,
    [`talentum_${profileId}`, email, phones],
  );
  return resolveLiveCanonicalWorkerIds(client, res.rows.map((r) => r.id), (id) => resolveCanonicalWorkerId(client as PoolClient, id));
}

async function applyRow(
  client: PoolClient, row: PendingRow, workerId: string, candidate: TalentumCandidate, stage: string | null,
): Promise<void> {
  await client.query(
    `UPDATE talentum_prescreenings SET worker_id = $1, updated_at = NOW() WHERE id = $2 AND worker_id IS NULL`,
    [workerId, row.id],
  );
  // Mesmo insert do `ensureEncuadre` do webhook (visibilidade no Kanban).
  const workerName = `${candidate.firstName ?? ''} ${candidate.lastName ?? ''}`.trim();
  const dedupHash = crypto.createHash('md5').update(`talentum|${row.talentumPrescreeningId}|${row.talentumProfileId}`).digest('hex');
  await client.query(
    `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
     VALUES ($1, $2, $3, $4, 'Talentum', $5)
     ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
       worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
    [workerId, row.jobPostingId, workerName, normalizePhoneAR(candidate.phoneNumber) || null, dedupHash],
  );
  if (stage === null) return;
  // Etapa anterior (para a transição NOT_QUALIFIED, como o `previousStage` do webhook).
  const prev = await client.query<{ application_funnel_stage: string }>(
    `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
    [workerId, row.jobPostingId],
  );
  const previousStage = prev.rows[0]?.application_funnel_stage ?? null;
  // Mesma regra de precedência do `upsertWorkerJobApplicationFromTalentum`, mas SEM zerar um match_score já gravado.
  await client.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, match_score, source)
     VALUES ($1, $2, $3, 0, 'talentum')
     ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
       application_funnel_stage = CASE
         WHEN EXCLUDED.application_funnel_stage = 'REJECTED'
            AND funnel_stage_precedence(worker_job_applications.application_funnel_stage) > funnel_stage_precedence('QUALIFIED')
         THEN worker_job_applications.application_funnel_stage
         WHEN funnel_stage_precedence(EXCLUDED.application_funnel_stage)
              >= funnel_stage_precedence(worker_job_applications.application_funnel_stage)
         THEN EXCLUDED.application_funnel_stage
         ELSE worker_job_applications.application_funnel_stage
       END,
       updated_at = NOW()`,
    [workerId, row.jobPostingId, toPersistedFunnelStage(stage)],
  );
  // NOT_QUALIFIED: a MESMA transição do webhook (encuadre RECHAZADO + WJA REJECTED + eventos audit-only, sem mensagem).
  await applyNotQualifiedTransition(client, workerId, row.jobPostingId, stage, previousStage, row.id);
}

export interface ReconcileDeps {
  talentum: TalentumReader;
  runInTransaction: TransactionRunner;
  /** Lista as linhas pendentes (leitura, fora da transação por linha). */
  listPending: () => Promise<PendingRow[]>;
  log?: (line: string) => void;
}

/** Uma linha por transação. `dry-run` executa tudo e dá ROLLBACK; erro numa linha desfaz só ela e segue. */
export async function reconcile(deps: ReconcileDeps, mode: ReconcileMode): Promise<Outcome[]> {
  const log = deps.log ?? (() => undefined);
  const rows = await deps.listPending();
  const byProject = new Map<string, PendingRow[]>();
  for (const r of rows) byProject.set(r.talentumProjectId, [...(byProject.get(r.talentumProjectId) ?? []), r]);

  const outcomes: Outcome[] = [];
  for (const [projectId, projectRows] of byProject) {
    let candidates: Map<string, TalentumCandidate>;
    let emails: Map<string, string>;
    const qualifiedIds = new Set<string>();
    try {
      candidates = new Map((await deps.talentum.candidates(projectId)).map((c) => [c.profileId, c]));
      emails = new Map();
      if (projectRows.some((r) => r.status === 'QUALIFIED' || r.status === 'ANALYZED')) {
        for (const q of await deps.talentum.readyForInterview(projectId)) {
          qualifiedIds.add(q.profileId);
          if (q.email) emails.set(q.profileId, q.email);
        }
      }
    } catch (err) {
      // O erro do client carrega só método/path/HTTP — sem dado de candidato.
      for (const r of projectRows) {
        const o: Outcome = { kind: 'ERROR', rowId: r.id, error: `talentum GET: ${describeError(err)}` };
        outcomes.push(o);
        log(formatOutcome(o));
      }
      continue;
    }
    for (const row of projectRows) {
      const outcome = await reconcileRow(
        deps, row, candidates.get(row.talentumProfileId), emails.get(row.talentumProfileId) ?? null,
        qualifiedIds.has(row.talentumProfileId), mode,
      );
      outcomes.push(outcome);
      log(formatOutcome(outcome));
    }
  }
  return outcomes;
}

async function reconcileRow(
  deps: ReconcileDeps, row: PendingRow, candidate: TalentumCandidate | undefined, email: string | null,
  qualified: boolean, mode: ReconcileMode,
): Promise<Outcome> {
  if (!candidate) return { kind: 'NOT_IN_TALENTUM', rowId: row.id };
  const stage = funnelStageFromStoredStatus(row.status, analyzedLabel(candidate, qualified));
  try {
    return await deps.runInTransaction(async (client) => {
      // Vaga DE_BAJA (guard do #811): não vincula nem avança o funil — vai para a lista.
      if (await vacancyIsDeBaja(client, row.jobPostingId)) return { kind: 'DEFERRED', rowId: row.id, reason: 'VAGA_DE_BAJA' } as Outcome;
      const ids = await findLiveWorkerIds(client, candidate, email ?? candidate.email ?? null, row.talentumProfileId);
      if (ids.length > 1) return { kind: 'AMBIGUOUS', rowId: row.id, workerIds: ids } as Outcome;
      let workerId = ids[0];
      if (!workerId) {
        const created = await createWorker(client, candidate, email, row.talentumProfileId);
        if (created.kind !== 'CREATED') return { kind: 'NO_WORKER', rowId: row.id, reason: created.reason } as Outcome;
        workerId = created.id;
      }
      await applyRow(client, row, workerId, candidate, stage);
      const resolved: Outcome = { kind: 'RESOLVED', rowId: row.id, workerId, stage: stage === null ? null : toPersistedFunnelStage(stage), committed: mode === 'apply' };
      if (mode !== 'apply') throw new RollbackWith(resolved);
      return resolved;
    });
  } catch (err) {
    if (err instanceof RollbackWith) return err.outcome;
    return { kind: 'ERROR', rowId: row.id, error: describeError(err) };
  }
}

/**
 * Sem worker vivo: cria pelo MESMO caminho do webhook (`insertTalentumWorker`). Colisão ou falha → lista, sem insistir.
 * SAVEPOINT: o erro do INSERT não pode abortar a transação da linha.
 */
async function createWorker(
  client: PoolClient, candidate: TalentumCandidate, email: string | null, profileId: string,
): Promise<{ kind: 'CREATED'; id: string } | { kind: 'FAILED'; reason: string }> {
  const mail = email ?? candidate.email ?? null;
  if (!mail || !candidate.phoneNumber) return { kind: 'FAILED', reason: 'sem e-mail/telefone do Talentum para criar' };
  await client.query('SAVEPOINT reconcile_create_worker');
  const res = await insertTalentumWorker(client, { id: profileId, email: mail, phoneNumber: candidate.phoneNumber });
  if (res.kind === 'CREATED') {
    await client.query('RELEASE SAVEPOINT reconcile_create_worker');
    return res;
  }
  await client.query('ROLLBACK TO SAVEPOINT reconcile_create_worker');
  return { kind: 'FAILED', reason: res.kind === 'COLLISION' ? 'colisão ao criar (cadastro existente fora do match)' : `falha ao criar: ${res.message}` };
}

export function formatOutcome(o: Outcome): string {
  switch (o.kind) {
    case 'RESOLVED': return `RESOLVED row=${o.rowId} worker=${o.workerId} stage=${o.stage ?? 'inalterado'} committed=${o.committed}`;
    case 'NO_WORKER': return `NO_WORKER row=${o.rowId}${o.reason ? ` (${o.reason}; LISTA)` : ''}`;
    case 'AMBIGUOUS': return `AMBIGUOUS row=${o.rowId} workers=${o.workerIds.join(',')} (LISTA, nada aplicado)`;
    case 'DEFERRED': return `DEFERRED row=${o.rowId} (${o.reason})`;
    case 'ERROR': return `ERROR row=${o.rowId} ${o.error}`;
    default: return `${o.kind} row=${o.rowId}`;
  }
}

export function formatTotals(outcomes: readonly Outcome[], mode: ReconcileMode): string[] {
  const n = (k: Outcome['kind']) => outcomes.filter((o) => o.kind === k).length;
  return [
    `modo=${mode} linhas=${outcomes.length} resolvidas=${n('RESOLVED')} ambiguas=${n('AMBIGUOUS')} sem_worker=${n('NO_WORKER')} ` +
      `fora_do_talentum=${n('NOT_IN_TALENTUM')} adiadas=${n('DEFERRED')} erros=${n('ERROR')}`,
    mode === 'dry-run' ? 'dry-run: tudo desfeito (ROLLBACK); nada gravado.' : 'apply: resolvidas gravadas; ambiguas/sem_worker/adiadas ficam na lista.',
  ];
}
