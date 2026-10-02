/**
 * SyncTalentumVacanciesUseCase
 *
 * Orchestrates: fetch all Talentum projects (API v2: `GET /projects`, paginado) → create or update
 * vacancies in job_postings with Talentum reference data and questions.
 *
 * Rules:
 *  - No LLM/Gemini — pure data sync from Talentum to DB
 *  - Errors on individual projects do not abort the sync
 *  - Always save Talentum reference columns (projectId, whatsappUrl, etc.)
 *  - Spec 040 (v2): o item da lista NÃO traz `publicId`/descrição/perguntas → 1 `getPrescreening` por
 *    projeto (2 GETs) para ligar por `publicId` (estável). Ordem de ligação: talentum_project_id →
 *    publicId → título EXATO 1:1 (duplicata → relatório, nada é ligado nem criado) → número do título
 *    (legado). Projeto `PHONE_CALL` ou com `/prescreening` 400 não tem link web: liga/cria sem apagar
 *    link/descrição existentes. T7.0: projeto sem par só vira vaga nova se `myRole === 'OWNER'`. A FAQ NÃO é tocada (a v2 não tem FAQ — decisão (g); fica só no banco).
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumApiClient, TALENTUM_PROJECT_NAME_MAX, toV2ProjectName } from '../infrastructure/TalentumApiClient';
import type { TalentumProject, TalentumQuestionWithId } from '../domain/ITalentumApiClient';
import {
  JobPostingAuditRepository,
} from '../../matching/infrastructure/JobPostingAuditRepository';
import { normalizePrescreeningResponseType } from '@shared/utils/normalizePrescreeningResponseType';
import { parseCaseTitleReference } from '@shared/utils/parseCaseTitleReference';
import { formatCaseTitle } from '@shared/utils/caseNumberFormat';
import { loadTalentumProjectDetail } from './loadTalentumProjectDetail';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface SyncReport {
  total: number;
  updated: number;
  created: number;
  skipped: number;
  /** Vagas ligadas só pelo título exato (menos confiável que o `publicId`). */
  linkedByTitle: number;
  /** Projetos sem link web (tipo `PHONE_CALL` ou `/prescreening` 400): ligados/criados sem `publicId`. */
  withoutWebLink: number;
  /** Projeto sem par que NÃO é nosso (`myRole` ≠ OWNER, ex. VIEWER): não cria vaga, só conta (T7.0). */
  ignoredNotOurs: number;
  /** Título que casa com mais de uma vaga do banco: nada é ligado nem criado, só relatado. */
  duplicateTitles: Array<{
    projectId: string;
    title: string;
    matches: number;
  }>;
  errors: Array<{
    projectId: string;
    title: string;
    error: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class SyncTalentumVacanciesUseCase {
  private db: Pool;
  private auditRepo: JobPostingAuditRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.auditRepo = new JobPostingAuditRepository();
  }

  async execute(opts?: { force?: boolean }): Promise<SyncReport> {
    const force = opts?.force ?? false;
    const report: SyncReport = {
      total: 0,
      updated: 0,
      created: 0,
      skipped: 0,
      linkedByTitle: 0,
      withoutWebLink: 0,
      ignoredNotOurs: 0,
      duplicateTitles: [],
      errors: [],
    };

    // 1. Fetch all projects from Talentum
    const talentumClient = await TalentumApiClient.create();
    const projects = await talentumClient.listAllPrescreenings();
    report.total = projects.length;

    console.log(`[SyncTalentum] Fetched ${projects.length} projects from Talentum (force=${force})`);

    // 2. Process each project sequentially
    for (const project of projects) {
      try {
        await this.processProject(project, talentumClient, report, force);
      } catch (err: any) {
        console.error(`[SyncTalentum] Error processing project ${project.projectId} ("${project.title}"):`, err.message);
        report.errors.push({
          projectId: project.projectId,
          title: project.title,
          error: err.message,
        });
      }
    }

    console.log(
      `[SyncTalentum] Done: total=${report.total} updated=${report.updated} ` +
      `created=${report.created} skipped=${report.skipped} linkedByTitle=${report.linkedByTitle} ` +
      `withoutWebLink=${report.withoutWebLink} ignoredNotOurs=${report.ignoredNotOurs} duplicateTitles=${report.duplicateTitles.length} errors=${report.errors.length}`,
    );

    return report;
  }

  private async processProject(
    project: TalentumProject,
    talentumClient: TalentumApiClient,
    report: SyncReport,
    force = false,
  ): Promise<void> {
    // 2b. Lookup in DB — 1º por talentum_project_id (já ligada → pula sem gastar GET na Talentum)
    let existing: { id: string; talentum_project_id: string | null } | null = null;

    const byTalentum = await this.db.query(
      'SELECT id, talentum_project_id FROM job_postings WHERE talentum_project_id = $1',
      [project.projectId],
    );
    existing = byTalentum.rows[0] ?? null;

    // 2b'. Skip if already synced with this Talentum project (unless force)
    if (!force && existing?.talentum_project_id === project.projectId) {
      console.log(`[SyncTalentum] Skipping "${project.title}" — already synced (talentum_project_id=${project.projectId})`);
      report.skipped++;
      return;
    }

    // 2c. Detalhe v2: o item da lista não traz publicId/descrição/perguntas. PHONE_CALL não tem link web
    //   (nem prescreening web) e um `/prescreening` 400 é projeto sem prescreening ativo: ambos seguem
    //   SEM publicId (liga/cria, sem apagar link/descrição já gravados).
    const source = await this.loadDetail(project, talentumClient, report);

    // 2b''. Sem par pelo project_id: publicId (estável) → título exato 1:1 → número do título (legado)
    if (!existing && source.publicId) {
      const byPublic = await this.db.query(
        'SELECT id, talentum_project_id FROM job_postings WHERE talentum_public_id = $1 AND deleted_at IS NULL',
        [source.publicId],
      );
      existing = byPublic.rows[0] ?? null;
    }

    if (!existing) {
      // Mesma regra da reconciliação (ReconcileTalentumV2UseCase): a v2 grava o nome cortado em 50, então a
      // vaga liga quando `toV2ProjectName(título da vaga) === título do projeto`. O SQL só estreita pelo prefixo;
      // quem decide a igualdade é a função compartilhada.
      const candidates = await this.db.query(
        `SELECT id, talentum_project_id, title FROM job_postings
         WHERE starts_with(left(title, ${TALENTUM_PROJECT_NAME_MAX}), $1) AND deleted_at IS NULL AND (talentum_public_id IS NULL OR talentum_public_id = $2)`,
        [project.title, source.publicId || null],
      );
      const byTitle = { rows: candidates.rows.filter((r: { title: string }) => toV2ProjectName(r.title ?? '') === project.title) };
      if (byTitle.rows.length > 1) {
        report.duplicateTitles.push({ projectId: project.projectId, title: project.title, matches: byTitle.rows.length });
        return;
      }
      if (byTitle.rows.length === 1) {
        existing = byTitle.rows[0];
        report.linkedByTitle++;
      }
    }

    // T063: tolera os formatos "CASO N[-M]" (legado) e "EN N#M" / "N#M" (novo, ver parser compartilhado
    //   para por que o segundo número tem dois significados).
    //   "CASO 230"    → case_number=230, nova vacante
    //   "CASO 230-42" → case_number=230, vacancy_number=42 (vacante existente)
    const { caseNumber, ordinal: parsedVacancyNumber } = parseCaseTitleReference(project.title);

    if (!existing && parsedVacancyNumber != null) {
      const byVacancy = await this.db.query(
        'SELECT id, talentum_project_id FROM job_postings WHERE vacancy_number = $1',
        [parsedVacancyNumber],
      );
      existing = byVacancy.rows[0] ?? null;
    }
    if (!existing && caseNumber != null) {
      const byCaseNumber = await this.db.query(
        `SELECT id, talentum_project_id FROM job_postings
         WHERE case_number = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [caseNumber],
      );
      existing = byCaseNumber.rows[0] ?? null;
    }

    // 2d. Create or update (no LLM — just save Talentum data directly)
    let jobPostingId: string;
    let wasCreated = false;

    if (existing) {
      jobPostingId = existing.id;
      report.updated++;
    } else {
      // T7.0 (decisão do Gabriel, 02/10): o sync NÃO cria vaga para projeto que não é nosso.
      if (project.myRole !== 'OWNER') {
        console.log(`[SyncTalentum] Ignorado "${project.title}" — sem par e myRole=${project.myRole ?? 'ausente'} (não é nosso)`);
        report.ignoredNotOurs++;
        return;
      }
      jobPostingId = await this.createFromSync(caseNumber);
      report.created++;
      wasCreated = true;
    }

    // 2e. Save Talentum reference
    await this.saveTalentumReference(jobPostingId, wasCreated, {
      talentum_project_id: source.projectId,
      // '' (item da lista / sem link web) → NULL: o COALESCE do UPDATE mantém o que já está gravado.
      talentum_public_id: source.publicId || null,
      talentum_whatsapp_url: source.whatsappUrl || null,
      talentum_slug: source.slug || null,
      talentum_published_at: source.timestamp || null,
      talentum_description: source.description || null,
    });

    // 2f. Sync questions from Talentum. A FAQ NÃO é tocada: a v2 não tem FAQ (decisão (g)) e a do
    //   banco (`job_posting_prescreening_faq`) é a única cópia.
    if (source.questions?.length) {
      await this.syncQuestions(jobPostingId, source.questions);
    }

    console.log(
      `[SyncTalentum] ${existing ? 'Updated' : 'Created'} vacancy for "${project.title}" ` +
      `case_number=${caseNumber ?? 'null'} (id=${jobPostingId})`,
    );
  }

  /**
   * Detalhe do projeto (publicId, link web, descrição, perguntas) — regra compartilhada em
   * `loadTalentumProjectDetail`. Sem link web (`PHONE_CALL`/400) conta em `withoutWebLink`; qualquer outro
   * erro propaga (o `execute` o registra no relatório sem abortar o sync).
   */
  private async loadDetail(
    project: TalentumProject,
    talentumClient: TalentumApiClient,
    report: SyncReport,
  ): Promise<TalentumProject> {
    const { project: detail, webLink } = await loadTalentumProjectDetail(project, talentumClient);
    if (!webLink) report.withoutWebLink++;
    return detail;
  }

  /**
   * Creates a new vacancy with basic data from Talentum title.
   * No LLM parsing — fields will be filled manually or via other flows.
   * Audit CREATED inside the same transaction.
   */
  private async createFromSync(caseNumber: number | null): Promise<string> {
    const vnResult = await this.db.query<{ vn: string }>(
      "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
    );
    const vacancyNumber = parseInt(vnResult.rows[0].vn);
    const title = caseNumber != null
      ? formatCaseTitle(caseNumber, vacancyNumber)
      : `VACANTE ${vacancyNumber}`;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        `INSERT INTO job_postings (
           vacancy_number, case_number, title, description, country, status
         ) VALUES ($1, $2, $3, '', 'AR', 'SEARCHING')
         RETURNING id`,
        [vacancyNumber, caseNumber, title],
      );
      const jobPostingId = result.rows[0].id;
      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the job_posting INSERT above) intact.
      await this.auditRepo.logEventSafe(client, {
        jobPostingId,
        eventType: 'CREATED',
        changes: { before: null, after: { vacancyNumber, caseNumber, title, status: 'SEARCHING' } },
        actorUserId: null,
        actorType: 'WEBHOOK',
        actorLabel: 'talentum_sync',
      });
      await client.query('COMMIT');
      return jobPostingId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Persists Talentum reference columns on the job_posting.
   * When wasCreated=false (update path), audits UPDATED best-effort.
   */
  private async saveTalentumReference(
    jobPostingId: string,
    wasCreated: boolean,
    ref: {
      talentum_project_id: string;
      talentum_public_id: string | null;
      talentum_whatsapp_url: string | null;
      talentum_slug: string | null;
      talentum_published_at: string | null;
      talentum_description: string | null;
    },
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE job_postings
         SET talentum_project_id   = $1,
             talentum_public_id    = COALESCE($2, talentum_public_id),
             talentum_whatsapp_url = COALESCE($3, talentum_whatsapp_url),
             talentum_slug         = COALESCE($4, talentum_slug),
             talentum_published_at = COALESCE($5, talentum_published_at),
             talentum_description  = COALESCE($6, talentum_description),
             updated_at            = NOW()
         WHERE id = $7`,
        [
          ref.talentum_project_id, ref.talentum_public_id, ref.talentum_whatsapp_url,
          ref.talentum_slug, ref.talentum_published_at, ref.talentum_description, jobPostingId,
        ],
      );
      // Only audit on update path — CREATED path already audited in createFromSync.
      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the UPDATE above) intact.
      if (!wasCreated) {
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'UPDATED',
          fieldName: 'talentum_project_id',
          changes: { before: null, after: ref.talentum_project_id },
          actorUserId: null,
          actorType: 'WEBHOOK',
          actorLabel: 'talentum_sync',
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Replaces prescreening questions for a job posting with those from Talentum.
   * Uses DELETE + INSERT to keep it simple and idempotent.
   */
  private async syncQuestions(
    jobPostingId: string,
    questions: TalentumQuestionWithId[],
  ): Promise<void> {
    await this.db.query(
      'DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1',
      [jobPostingId],
    );

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await this.db.query(
        `INSERT INTO job_posting_prescreening_questions
           (job_posting_id, question_order, question, response_type,
            desired_response, weight, required, analyzed, early_stoppage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          jobPostingId,
          i + 1,
          q.question,
          // Ticket 86ajfm80t: respeita o formato da Talentum; default seguro
          // ['text','audio'] só quando ausente/vazio/inválido.
          normalizePrescreeningResponseType(q.responseType),
          q.desiredResponse,
          q.weight,
          q.required,
          q.analyzed,
          q.earlyStoppage,
        ],
      );
    }
  }
}
