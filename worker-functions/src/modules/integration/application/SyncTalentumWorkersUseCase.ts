/**
 * SyncTalentumWorkersUseCase (spec 040 / F3 — API v2 da Talentum)
 *
 * Lê os candidatos dos projetos IN_PROGRESS que correspondem a uma vaga NOSSA e os grava na tabela
 * `workers`. Existe para compensar falha de webhook — preenche só o que FALTA, nunca sobrescreve.
 *
 * Fonte (v2): `GET /projects` (lista) → por projeto com vaga par: `candidates?page=N` até `total`
 * (traz telefone, NÃO traz e-mail) e, só se houver qualificado, `ready-for-interview` (traz e-mail) como
 * complemento. Nunca `responses/:id` por candidato (5425 requests). O projeto É o contexto: a vaga vem do
 * `talentum_project_id` do PRÓPRIO projeto (não por título, como na v1).
 *
 * Por candidato:
 *   1. Casa o worker por telefone normalizado (`normalizePhoneAR`) → e-mail → auth_uid `talentum_<profileId>`
 *   2. Não achou → cria com INCOMPLETE_REGISTER (e-mail pode ser NULL: migration 499)
 *   3. Achou → completa o que está NULL/vazio (nome, telefone, e-mail)
 *   4. Liga `worker_job_applications` (INVITED) à vaga do projeto
 *
 * Telefone DIFERENTE do cadastrado (achado por e-mail/auth_uid) NÃO duplica nem sobrescreve: vira linha em
 * `report.conflicts` (só profileId). Log: só `profileId`, ids e contagens — NUNCA telefone, e-mail ou nome.
 *
 * application_funnel_stage = INVITED nas linhas novas (ON CONFLICT DO NOTHING preserva o que o webhook
 * PRESCREENING_RESPONSE já subiu para INITIATED+).
 */

import * as crypto from 'crypto';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import { logger, safeErrorFields } from '@shared/logging';
import type { ITalentumApiClient, TalentumCandidate } from '../domain/ITalentumApiClient';

const TAG = '[SyncTalentumWorkers]';
const IN_PROGRESS = 'IN_PROGRESS';
/** Trava contra loop infinito se a API devolver `total` inconsistente (12 por página → 6000 candidatos). */
const MAX_PAGES_PER_PROJECT = 500;

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface WorkerSyncConflict {
  profileId: string;
  /** Achado por e-mail/auth_uid, mas o telefone do candidato difere do cadastrado: não duplica, não sobrescreve. */
  reason: 'PHONE_DIFFERS_FROM_REGISTERED';
}

/**
 * Lote por projeto (T3.4). Medido na Talentum real: ~0,25 s por GET → 625 requests de candidatos (+ até ~290 de
 * `ready-for-interview`) + ~5 idas ao banco por candidato ≈ 240–310 s, contra o `server.timeout` de 300 s da API
 * (o Cloud Run aceita 600 s, mas o Node derruba a conexão ociosa aos 300 s). Sem `maxProjects` lê TUDO (comportamento
 * antigo); com `maxProjects`, lê só `[cursor, cursor+maxProjects)` e devolve `nextCursor` (null = terminou).
 */
export interface WorkerSyncOptions {
  cursor?: number;
  maxProjects?: number;
}

/** Aceita só inteiros >= 0 (cursor) / >= 1 (maxProjects); qualquer outra coisa é ignorada (= sem lote). */
export function parseSyncOptions(body: unknown): WorkerSyncOptions {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const opts: WorkerSyncOptions = {};
  if (Number.isInteger(b.cursor) && (b.cursor as number) >= 0) opts.cursor = b.cursor as number;
  if (Number.isInteger(b.maxProjects) && (b.maxProjects as number) >= 1) opts.maxProjects = b.maxProjects as number;
  return opts;
}

export interface WorkerSyncReport {
  /** Candidatos lidos (soma dos projetos). */
  total: number;
  created: number;
  updated: number;
  skipped: number;
  linked: number;
  /** Workers cujo link à vaga foi pulado porque status != REGISTERED (cadastro/docs incompletos) */
  skippedIncompleteRegistration: number;
  /** Projetos IN_PROGRESS lidos NESTA chamada (têm vaga par). */
  projects: number;
  /** Projetos IN_PROGRESS com vaga par no total (o lote é uma fatia deles). */
  projectsEligible: number;
  /** Cursor da próxima chamada; `null` = não há mais projetos (sync completo). */
  nextCursor: number | null;
  /** Projetos IN_PROGRESS SEM vaga par (talentum_project_id não ligado): ignorados, candidatos não lidos. */
  projectsWithoutVacancy: number;
  /** Requests de leitura de candidatos feitos à Talentum (candidates + ready-for-interview; a lista de projetos não entra). */
  requests: number;
  conflicts: WorkerSyncConflict[];
  errors: Array<{ profileId: string; error: string }>;
}

interface LinkedVacancy {
  id: string;
  caseNumber: number | null;
}

interface WorkerSeed {
  profileId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  rawPhone: string | null;
}

interface WorkerMatch {
  id: string;
  by: 'phone' | 'email' | 'auth_uid';
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class SyncTalentumWorkersUseCase {
  private db: Pool;
  private encryptionService: KMSEncryptionService;
  private blindIndexService: BlindIndexService;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
  }

  async execute(opts: WorkerSyncOptions = {}): Promise<WorkerSyncReport> {
    const report: WorkerSyncReport = {
      total: 0, created: 0, updated: 0, skipped: 0, linked: 0,
      skippedIncompleteRegistration: 0, projects: 0, projectsEligible: 0, nextCursor: null,
      projectsWithoutVacancy: 0, requests: 0, conflicts: [], errors: [],
    };

    const talentumClient = await TalentumApiClient.create();
    const allProjects = await talentumClient.listAllPrescreenings();
    const inProgress = allProjects.filter((p) => p.status === IN_PROGRESS);
    const vacancies = await this.loadLinkedVacancies(inProgress.map((p) => p.projectId));
    logger.info({
      msg: `${TAG} Listed projects`, projects: allProjects.length, inProgress: inProgress.length, linkedToVacancy: vacancies.size,
    });

    // Ordem estável (por id) para o cursor valer entre chamadas.
    const eligible = inProgress.filter((p) => vacancies.has(p.projectId)).sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
    report.projectsEligible = eligible.length;
    report.projectsWithoutVacancy = inProgress.length - eligible.length;
    const start = opts.cursor ?? 0;
    const end = opts.maxProjects ? start + opts.maxProjects : eligible.length;
    report.nextCursor = end < eligible.length ? end : null;

    for (const project of eligible.slice(start, end)) {
      const vacancy = vacancies.get(project.projectId)!;
      report.projects++;
      try {
        await this.processProject(talentumClient, project.projectId, vacancy, report);
      } catch (err: unknown) {
        // O erro da API v2 carrega só método/path/HTTP (path tem o projectId) — nada de candidato.
        logger.error({ msg: `${TAG} Error reading project ${project.projectId}`, ...safeErrorFields(err) });
        report.errors.push({ profileId: `project:${project.projectId}`, error: err instanceof Error ? err.message : String(err) });
      }
    }

    logger.info({
      msg: `${TAG} Done`,
      projects: report.projects, projectsEligible: report.projectsEligible, nextCursor: report.nextCursor,
      projectsWithoutVacancy: report.projectsWithoutVacancy, requests: report.requests,
      total: report.total, created: report.created,
      updated: report.updated, skipped: report.skipped, linked: report.linked,
      skippedIncompleteRegistration: report.skippedIncompleteRegistration,
      conflicts: report.conflicts.length, errors: report.errors.length,
    });
    return report;
  }

  // ── Projects → vacancies ─────────────────────────────────────────

  /** `talentum_project_id` → vaga nossa. Projeto sem vaga par fica de fora (e é ignorado). */
  private async loadLinkedVacancies(projectIds: string[]): Promise<Map<string, LinkedVacancy>> {
    const map = new Map<string, LinkedVacancy>();
    if (projectIds.length === 0) return map;
    const r = await this.db.query<{ id: string; talentum_project_id: string; case_number: number | null }>(
      `SELECT id, talentum_project_id, case_number FROM job_postings
        WHERE talentum_project_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [projectIds],
    );
    for (const row of r.rows) map.set(row.talentum_project_id, { id: row.id, caseNumber: row.case_number });
    return map;
  }

  // ── Project reading ──────────────────────────────────────────────

  private async processProject(
    client: ITalentumApiClient, projectId: string, vacancy: LinkedVacancy, report: WorkerSyncReport,
  ): Promise<void> {
    const candidates = await this.readAllPages(client, 'candidates', projectId, report);
    if (candidates.length === 0) return;
    report.total += candidates.length;

    // E-mail só existe para os qualificados: 1 leitura por projeto, e só se houver algum.
    const emailByProfile = new Map<string, string>();
    if (candidates.some((c) => qualified(c))) {
      for (const q of await this.readAllPages(client, 'ready-for-interview', projectId, report)) {
        if (q.email) emailByProfile.set(q.profileId, q.email);
      }
    }

    for (const candidate of candidates) {
      try {
        await this.processCandidate(candidate, emailByProfile.get(candidate.profileId), vacancy, report);
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        // PII: nunca nome/telefone/e-mail no log — profileId é o id estável; `error`/`stack` crus também não.
        logger.error({ msg: `${TAG} Error processing profile ${candidate.profileId}`, ...safeErrorFields(err) });
        report.errors.push({ profileId: candidate.profileId, error: e.message });
      }
    }
  }

  private async readAllPages(
    client: ITalentumApiClient, kind: 'candidates' | 'ready-for-interview', projectId: string, report: WorkerSyncReport,
  ): Promise<TalentumCandidate[]> {
    const all: TalentumCandidate[] = [];
    for (let page = 1; page <= MAX_PAGES_PER_PROJECT; page++) {
      const res = kind === 'candidates'
        ? await client.listCandidates(projectId, page)
        : await client.listReadyForInterview(projectId, page);
      report.requests++;
      if (res.candidates.length === 0) break;
      all.push(...res.candidates);
      if (all.length >= res.total) break;
    }
    return all;
  }

  // ── Candidate processing ─────────────────────────────────────────

  private async processCandidate(
    candidate: TalentumCandidate, email: string | undefined, vacancy: LinkedVacancy, report: WorkerSyncReport,
  ): Promise<void> {
    const rawPhone = candidate.phoneNumber || null;
    const seed: WorkerSeed = {
      profileId: candidate.profileId,
      firstName: candidate.firstName?.trim() || null,
      lastName: candidate.lastName?.trim() || null,
      email: (email ?? candidate.email)?.toLowerCase().trim() || null,
      phone: rawPhone ? normalizePhoneAR(rawPhone) || null : null,
      rawPhone,
    };

    if (!seed.email && !seed.phone) {
      report.skipped++;
      return;
    }

    let match = await this.findExistingWorker(seed);
    if (match) {
      const didUpdate = await this.fillMissingData(match.id, seed, match.by, report);
      if (didUpdate) { report.updated++; } else { report.skipped++; }
    } else {
      const id = await this.createWorker(seed);
      match = { id, by: 'phone' };
      report.created++;
    }

    report.linked += await this.linkToVacancy(match.id, seed, vacancy, report);
  }

  // ── Worker lookup ────────────────────────────────────────────────

  /** telefone normalizado → e-mail → auth_uid. Informa por qual chave achou (para o relatório de conflito). */
  private async findExistingWorker(seed: WorkerSeed): Promise<WorkerMatch | null> {
    if (seed.phone) {
      const candidates = generatePhoneCandidates(seed.phone);
      if (candidates.length > 0) {
        const r = await this.db.query(
          'SELECT id FROM workers WHERE phone = ANY($1::text[]) AND merged_into_id IS NULL LIMIT 1',
          [candidates],
        );
        if (r.rows[0]) return { id: r.rows[0].id, by: 'phone' };
      }
    }
    if (seed.email) {
      const r = await this.db.query('SELECT id FROM workers WHERE LOWER(email) = LOWER($1) AND merged_into_id IS NULL LIMIT 1', [seed.email]);
      if (r.rows[0]) return { id: r.rows[0].id, by: 'email' };
    }
    const r = await this.db.query(
      'SELECT id FROM workers WHERE auth_uid = $1 AND merged_into_id IS NULL LIMIT 1',
      [`talentum_${seed.profileId}`],
    );
    return r.rows[0] ? { id: r.rows[0].id, by: 'auth_uid' } : null;
  }

  // ── Worker creation ──────────────────────────────────────────────

  private async createWorker(seed: WorkerSeed): Promise<string> {
    const authUid = `talentum_${seed.profileId}`;

    const [firstNameEnc, lastNameEnc, nameBidxBuffers] = await Promise.all([
      seed.firstName ? this.encryptionService.encrypt(seed.firstName) : Promise.resolve(null),
      seed.lastName ? this.encryptionService.encrypt(seed.lastName) : Promise.resolve(null),
      this.blindIndexService.generateNameTrigramBidx(seed.firstName, seed.lastName),
    ]);
    const nameBidxLiteral = this.blindIndexService.serializeForPg(nameBidxBuffers);

    try {
      const result = await this.db.query(
        `INSERT INTO workers (auth_uid, email, phone, first_name_encrypted, last_name_encrypted, name_trgm_bidx, status, country)
         VALUES ($1, $2, $3, $4, $5, $6::bytea[], 'INCOMPLETE_REGISTER', 'AR')
         RETURNING id`,
        [authUid, seed.email, seed.phone, firstNameEnc, lastNameEnc, nameBidxLiteral],
      );
      return result.rows[0].id;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        // Unique violation — race condition, worker was created concurrently
        const existing = await this.db.query(
          'SELECT id FROM workers WHERE auth_uid = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
          [authUid, seed.email],
        );
        if (existing.rows[0]) return existing.rows[0].id;
      }
      throw err;
    }
  }

  // ── Fill missing data ────────────────────────────────────────────

  private async fillMissingData(
    workerId: string, seed: WorkerSeed, matchedBy: WorkerMatch['by'], report: WorkerSyncReport,
  ): Promise<boolean> {
    // Read current state to decide what's missing
    const current = await this.db.query(
      `SELECT email, phone, first_name_encrypted, last_name_encrypted, auth_uid
       FROM workers WHERE id = $1`,
      [workerId],
    );
    const row = current.rows[0];
    if (!row) return false;

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    // Email — fill only if missing
    if (!row.email && seed.email) {
      updates.push(`email = $${paramIdx++}`);
      values.push(seed.email);
    }

    // Phone — fill only if missing; telefone DIFERENTE do cadastrado (achado por outra chave) vira relatório
    if (!row.phone && seed.phone) {
      updates.push(`phone = $${paramIdx++}`);
      values.push(seed.phone);
    } else if (row.phone && seed.phone && matchedBy !== 'phone') {
      report.conflicts.push({ profileId: seed.profileId, reason: 'PHONE_DIFFERS_FROM_REGISTERED' });
    }

    // First name — fill only if missing/empty
    const fillFirstName = (!row.first_name_encrypted || row.first_name_encrypted === '') && seed.firstName !== null;
    if (fillFirstName) {
      const enc = await this.encryptionService.encrypt(seed.firstName);
      updates.push(`first_name_encrypted = $${paramIdx++}`);
      values.push(enc);
    }

    // Last name — fill only if missing/empty
    const fillLastName = (!row.last_name_encrypted || row.last_name_encrypted === '') && seed.lastName !== null;
    if (fillLastName) {
      const enc = await this.encryptionService.encrypt(seed.lastName);
      updates.push(`last_name_encrypted = $${paramIdx++}`);
      values.push(enc);
    }

    // Blind index: recalculate if either name is being written
    if (fillFirstName || fillLastName) {
      const [currentFirstName, currentLastName] = await Promise.all([
        row.first_name_encrypted
          ? this.encryptionService.decrypt(row.first_name_encrypted)
          : Promise.resolve(null),
        row.last_name_encrypted
          ? this.encryptionService.decrypt(row.last_name_encrypted)
          : Promise.resolve(null),
      ]);
      const finalFirstName = fillFirstName ? seed.firstName : (currentFirstName ?? null);
      const finalLastName  = fillLastName  ? seed.lastName  : (currentLastName  ?? null);
      const bidxBuffers = await this.blindIndexService.generateNameTrigramBidx(finalFirstName, finalLastName);
      const bidxLiteral = this.blindIndexService.serializeForPg(bidxBuffers);
      updates.push(`name_trgm_bidx = $${paramIdx++}::bytea[]`);
      values.push(bidxLiteral);
    }

    // auth_uid — fill if missing (worker was created from import, not Talentum)
    if (!row.auth_uid) {
      updates.push(`auth_uid = $${paramIdx++}`);
      values.push(`talentum_${seed.profileId}`);
    }

    if (updates.length === 0) return false;

    updates.push(`updated_at = NOW()`);
    values.push(workerId);
    await this.db.query(
      `UPDATE workers SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values,
    );
    return true;
  }

  // ── Vacancy linking ──────────────────────────────────────────────

  /**
   * Garante WJA + encuadre do (worker, vaga do PRÓPRIO projeto).
   *
   * WJA INSERT usa ON CONFLICT DO NOTHING: linha nova → INVITED; existente → sem mutação (o stage que o
   * webhook canônico subiu para INITIATED+ é preservado). Worker precisa estar com cadastro + documentos
   * completos (status='REGISTERED') — o sync não cria application para worker incompleto.
   * Retorna 1 se criou a WJA, 0 caso contrário.
   */
  private async linkToVacancy(
    workerId: string, seed: WorkerSeed, vacancy: LinkedVacancy, report: WorkerSyncReport,
  ): Promise<number> {
    const statusRow = await this.db.query<{ status: string }>('SELECT status FROM workers WHERE id = $1', [workerId]);
    if (statusRow.rows[0]?.status !== 'REGISTERED') {
      // Só a contagem (no log final `Done`): 1 aviso por candidato daria milhares de linhas por sync.
      report.skippedIncompleteRegistration++;
      return 0;
    }

    const wjaResult = await this.db.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'talentum')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING
       RETURNING id`,
      [workerId, vacancy.id],
    );

    // encuadre — idempotente via dedup_hash (mesma fórmula do sync legado: reaproveita as linhas antigas)
    const workerName = [seed.firstName, seed.lastName].filter(Boolean).join(' ');
    const dedupHash = crypto.createHash('md5')
      .update(`dashboard|${seed.profileId}|${vacancy.caseNumber}`)
      .digest('hex');
    await this.db.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
       VALUES ($1, $2, $3, $4, 'Talentum', $5)
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
      [workerId, vacancy.id, workerName, seed.rawPhone, dedupHash],
    );

    logger.info({ msg: `${TAG} ensured WJA + encuadre bond`, profileId: seed.profileId, workerId, jobPostingId: vacancy.id });
    return wjaResult.rowCount && wjaResult.rowCount > 0 ? 1 : 0;
  }
}

/** `status.value === 'qualified'` (medido: qualified | in_doubt | in_progress). */
function qualified(candidate: TalentumCandidate): boolean {
  const status = candidate.status as { value?: unknown } | undefined;
  return status?.value === 'qualified';
}
