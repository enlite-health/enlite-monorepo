/**
 * ReconcileTalentumV2UseCase — spec 040 / F5 (decisão (b)).
 *
 * Na migração para a API v2 (01/10) TODOS os `talentum_project_id` de `job_postings` morreram e o link
 * gravado era `wa.me`. Esta reconciliação religa cada vaga ao projeto v2 e troca o link pelo WEB:
 *  1. por `publicId` (estável, 312/312 em prd): `talentum_project_id` = projeto cujo `publicId` é o da
 *     vaga; link/slug vêm do projeto;
 *  2. sem `publicId`: por TÍTULO exato (já truncado em 50 como a v2 grava), SÓ se 1:1 — 1 projeto v2 com
 *     aquele nome E 1 vaga publicada com aquele título; reportado à parte ("por título", menos confiável);
 *  3. o resto vai a relatório SEM alterar: `noMatch` (sem par), `ambiguous` (mais de um candidato, ou o
 *     projeto já pertence a outra vaga) e `invalid` (slug > 255 / publicId não-UUID — a coluna recusaria).
 *
 * `plan()` é SOMENTE LEITURA (lê a Talentum com GET e o banco com SELECT) — dry-run = `plan()`.
 * `applyReconcile()` e `restoreRollbackRows()` são as únicas escritas: UMA transação cada, com guarda otimista (a linha tem de estar como
 * o plano a viu), e tocam SÓ os 4 campos `talentum_*`. Idempotente: 2º run = 0 mudanças. O relatório tem
 * contagens e `job_posting_id` — nunca título/PII. Reaproveita o cliente v2 e `loadTalentumProjectDetail`
 * (a mesma regra do sync de vagas).
 */

import type { ITalentumApiClient, TalentumProject } from '../domain/ITalentumApiClient';
import { toV2ProjectName } from '../infrastructure/TalentumApiClient';
import { loadTalentumProjectDetail } from './loadTalentumProjectDetail';
import type { RollbackRow } from './ReconcileRollbackCsv';

export interface ReconcileQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface ReconcileDb extends ReconcileQueryable {
  connect(): Promise<ReconcileQueryable & { release(): void }>;
}

export interface TalentumRef {
  projectId: string | null;
  publicId: string | null;
  slug: string | null;
  whatsappUrl: string | null;
}

export interface ReconcileChange {
  jobPostingId: string;
  kind: 'publicId' | 'title';
  before: TalentumRef;
  after: TalentumRef;
}

export interface ReconcileReport {
  /** Projetos v2 lidos / vagas do banco com algum `talentum_*` (candidatas). */
  projects: number;
  vacancies: number;
  linkedByPublicId: number;
  linkedByTitle: number;
  noMatch: number;
  ambiguous: number;
  invalid: number;
  alreadyCorrect: number;
  /** Projetos v2 que nenhuma vaga ocupa depois da reconciliação (o que o sync de vagas criaria, no máx.). */
  projectsWithoutVacancy: number;
  /** `projectId` cujo detalhe falhou (≠ 400/PHONE_CALL): com erro o plano é incompleto e a escrita é recusada. */
  detailErrors: string[];
  noMatchIds: string[];
  ambiguousIds: string[];
  invalidIds: string[];
}

export interface ReconcilePlan {
  changes: ReconcileChange[];
  report: ReconcileReport;
}

interface VacancyRow {
  id: string;
  title: string | null;
  deleted: boolean;
  talentum_project_id: string | null;
  talentum_public_id: string | null;
  talentum_whatsapp_url: string | null;
  talentum_slug: string | null;
}

interface Candidate {
  vacancy: VacancyRow;
  kind: 'publicId' | 'title';
  project: TalentumProject;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `talentum_slug` é VARCHAR(255) (migration 119; era 20 na 106 — slugs reais da v2 chegam a ~140). */
const SLUG_MAX = 255;

const VACANCIES_SQL = `SELECT id, title, deleted_at IS NOT NULL AS deleted, talentum_project_id,
       talentum_public_id::text AS talentum_public_id, talentum_whatsapp_url, talentum_slug
  FROM job_postings
 WHERE talentum_project_id IS NOT NULL OR talentum_public_id IS NOT NULL
 ORDER BY id`;

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

function refOf(v: VacancyRow): TalentumRef {
  return {
    projectId: v.talentum_project_id,
    publicId: v.talentum_public_id,
    slug: v.talentum_slug,
    whatsappUrl: v.talentum_whatsapp_url,
  };
}

/** O que a vaga passa a ter: o projeto manda; o que o projeto não traz (ex.: sem link web) fica como está. */
function refAfter(before: TalentumRef, p: TalentumProject): TalentumRef {
  return {
    projectId: p.projectId,
    publicId: p.publicId.toLowerCase() || before.publicId, // uuid do Postgres é minúsculo
    slug: p.slug || before.slug,
    whatsappUrl: p.whatsappUrl || before.whatsappUrl,
  };
}

const same = (a: TalentumRef, b: TalentumRef) =>
  a.projectId === b.projectId && a.publicId === b.publicId && a.slug === b.slug && a.whatsappUrl === b.whatsappUrl;

export class ReconcileTalentumV2UseCase {
  constructor(
    private readonly db: ReconcileDb,
    private readonly client: Pick<ITalentumApiClient, 'listAllPrescreenings' | 'getPrescreening'>,
  ) {}

  /** SOMENTE LEITURA: GET na Talentum + SELECT no banco. Nunca escreve. */
  async plan(): Promise<ReconcilePlan> {
    const items = await this.client.listAllPrescreenings();
    const detailErrors: string[] = [];
    const details: TalentumProject[] = [];
    for (const item of items) {
      try {
        details.push((await loadTalentumProjectDetail(item, this.client)).project);
      } catch {
        detailErrors.push(item.projectId);
      }
    }

    const vacancies = (await this.db.query(VACANCIES_SQL)).rows as VacancyRow[];
    const byPublicId = groupBy(details.filter((p) => p.publicId), (p) => p.publicId.toLowerCase());
    const byName = groupBy(details, (p) => p.title);
    // Candidatas ao elo por título: publicadas (têm project_id) e sem publicId, não apagadas.
    const titled = vacancies.filter((v) => !v.talentum_public_id && !v.deleted);
    const vacanciesByTitle = groupBy(titled, (v) => toV2ProjectName(v.title ?? ''));

    const noMatch: string[] = [];
    const ambiguous: string[] = [];
    const invalid: string[] = [];
    const publicCands: Candidate[] = [];
    const titleCands: Candidate[] = [];

    for (const v of vacancies) {
      if (v.talentum_public_id) {
        const hits = byPublicId.get(v.talentum_public_id.toLowerCase()) ?? [];
        if (hits.length === 0) noMatch.push(v.id);
        else if (hits.length > 1) ambiguous.push(v.id);
        else publicCands.push({ vacancy: v, kind: 'publicId', project: hits[0] });
      } else if (v.deleted) {
        noMatch.push(v.id);
      } else {
        const name = toV2ProjectName(v.title ?? '');
        const hits = byName.get(name) ?? [];
        if (hits.length === 0) noMatch.push(v.id);
        else if (hits.length > 1 || vacanciesByTitle.get(name)!.length > 1) ambiguous.push(v.id);
        else titleCands.push({ vacancy: v, kind: 'title', project: hits[0] });
      }
    }

    // Dois candidatos para o MESMO projeto: ninguém é ligado (publicId repetido no banco, ou título
    // que aponta para um projeto que a vaga de publicId já ocupa).
    const claimedBy = groupBy([...publicCands, ...titleCands], (c) => c.project.projectId);
    const holders = groupBy(
      vacancies.filter((v) => v.talentum_project_id),
      (v) => v.talentum_project_id as string,
    );
    const accepted: Candidate[] = [];
    for (const c of [...publicCands, ...titleCands]) {
      const otherHolder = (holders.get(c.project.projectId) ?? []).some((h) => h.id !== c.vacancy.id);
      if (claimedBy.get(c.project.projectId)!.length > 1 || otherHolder) ambiguous.push(c.vacancy.id);
      else accepted.push(c);
    }

    const changes: ReconcileChange[] = [];
    let alreadyCorrect = 0;
    const used = new Set<string>();
    for (const c of accepted) {
      const before = refOf(c.vacancy);
      const after = refAfter(before, c.project);
      if ((after.publicId && !UUID.test(after.publicId)) || (after.slug ?? '').length > SLUG_MAX) {
        invalid.push(c.vacancy.id);
        continue;
      }
      used.add(c.project.projectId);
      if (same(before, after)) alreadyCorrect++;
      else changes.push({ jobPostingId: c.vacancy.id, kind: c.kind, before, after });
    }

    return {
      changes,
      report: {
        projects: items.length,
        vacancies: vacancies.length,
        linkedByPublicId: changes.filter((c) => c.kind === 'publicId').length,
        linkedByTitle: changes.filter((c) => c.kind === 'title').length,
        noMatch: noMatch.length,
        ambiguous: ambiguous.length,
        invalid: invalid.length,
        alreadyCorrect,
        projectsWithoutVacancy: items.filter((p) => !used.has(p.projectId)).length,
        detailErrors,
        noMatchIds: noMatch,
        ambiguousIds: ambiguous,
        invalidIds: invalid,
      },
    };
  }
}

/** CSV de rollback = os valores ANTIGOS das linhas que `applyReconcile` vai tocar. */
export function rollbackRowsOf(changes: ReconcileChange[]): RollbackRow[] {
  return changes.map((c) => ({
    jobPostingId: c.jobPostingId,
    projectId: c.before.projectId,
    publicId: c.before.publicId,
    slug: c.before.slug,
    whatsappUrl: c.before.whatsappUrl,
  }));
}

async function inTransaction<T>(db: ReconcileDb, work: (tx: ReconcileQueryable) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const out = await work(tx);
    await tx.query('COMMIT');
    return out;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}

/** ÚNICA escrita da reconciliação: 1 transação; a linha tem de estar como o plano a viu, senão ROLLBACK. */
export async function applyReconcile(db: ReconcileDb, changes: ReconcileChange[]): Promise<number> {
  return inTransaction(db, async (tx) => {
    for (const c of changes) {
      const r = await tx.query(
        `UPDATE job_postings
            SET talentum_project_id = $2, talentum_public_id = $3::uuid, talentum_slug = $4, talentum_whatsapp_url = $5
          WHERE id = $1
            AND talentum_project_id IS NOT DISTINCT FROM $6
            AND talentum_public_id::text IS NOT DISTINCT FROM $7
            AND talentum_slug IS NOT DISTINCT FROM $8
            AND talentum_whatsapp_url IS NOT DISTINCT FROM $9`,
        [
          c.jobPostingId, c.after.projectId, c.after.publicId, c.after.slug, c.after.whatsappUrl,
          c.before.projectId, c.before.publicId, c.before.slug, c.before.whatsappUrl,
        ],
      );
      if (r.rowCount !== 1) throw new Error(`reconcile: a vaga ${c.jobPostingId} mudou desde o plano (rowCount=${r.rowCount})`);
    }
    return changes.length;
  });
}

/** Restaura os 4 campos do CSV (valores antigos), 1 transação. Não lê a Talentum. */
export async function restoreRollbackRows(db: ReconcileDb, rows: RollbackRow[]): Promise<number> {
  return inTransaction(db, async (tx) => {
    for (const r of rows) {
      const res = await tx.query(
        `UPDATE job_postings
            SET talentum_project_id = $2, talentum_public_id = $3::uuid, talentum_slug = $4, talentum_whatsapp_url = $5
          WHERE id = $1`,
        [r.jobPostingId, r.projectId, r.publicId, r.slug, r.whatsappUrl],
      );
      if (res.rowCount !== 1) throw new Error(`rollback: a vaga ${r.jobPostingId} não existe (rowCount=${res.rowCount})`);
    }
    return rows.length;
  });
}
