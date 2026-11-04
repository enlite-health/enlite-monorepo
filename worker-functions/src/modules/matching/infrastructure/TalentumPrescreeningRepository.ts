import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  TalentumPrescreening,
  TalentumQuestion,
  TalentumPrescreeningResponse,
  UpsertTalentumPrescreeningDTO,
  UpsertTalentumQuestionDTO,
  UpsertTalentumResponseDTO,
  InsertTalentumDivergenceDTO,
} from '../domain/TalentumPrescreening';

export class TalentumPrescreeningRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  // upsertPrescreening
  //   ON CONFLICT (talentum_prescreening_id, talentum_profile_id):
  //     prescreening_id = fila (processo seletivo), profile_id = candidato
  //     status         → sempre sobrescreve (INITIATED → IN_PROGRESS → COMPLETED → ANALYZED)
  //     worker_id      → COALESCE: preenche se era null; não regride para null em POSTs posteriores
  //     job_posting_id → a vaga DONA (resolvida pelo talentum_prescreening_id, `jobPostingResolvedById`)
  //                      vence a gravada; resolução por título/null mantém o COALESCE (título nunca
  //                      sobrescreve uma resolução por id — M2)
  //     updated_at     → sempre NOW()
  //   `previousJobPostingId` = a vaga gravada ANTES deste evento (null se a linha é nova).
  //   `client` opcional: roda dentro da transação do chamador (card + divergência atômicos).
  async upsertPrescreening(
    dto: UpsertTalentumPrescreeningDTO,
    client?: { query: Pool['query'] },
  ): Promise<{ prescreening: TalentumPrescreening; created: boolean; previousJobPostingId: string | null }> {
    const environment = dto.environment ?? 'production';
    const db = client || this.pool;
    const result = await db.query(
      `WITH prev AS (
         SELECT job_posting_id FROM talentum_prescreenings
         WHERE talentum_prescreening_id = $1 AND talentum_profile_id = $2
       )
       INSERT INTO talentum_prescreenings (
         talentum_prescreening_id,
         talentum_profile_id,
         worker_id,
         job_posting_id,
         job_case_name,
         status,
         environment
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (talentum_prescreening_id, talentum_profile_id) DO UPDATE SET
         status         = EXCLUDED.status,
         worker_id      = COALESCE(talentum_prescreenings.worker_id,      EXCLUDED.worker_id),
         job_posting_id = CASE
           WHEN $8::boolean AND EXCLUDED.job_posting_id IS NOT NULL THEN EXCLUDED.job_posting_id
           ELSE COALESCE(talentum_prescreenings.job_posting_id, EXCLUDED.job_posting_id)
         END,
         environment    = EXCLUDED.environment,
         updated_at     = NOW()
       RETURNING *, (xmax = 0) AS inserted, (SELECT job_posting_id FROM prev) AS previous_job_posting_id`,
      [
        dto.talentumPrescreeningId,
        dto.talentumProfileId,
        dto.workerId,
        dto.jobPostingId,
        dto.jobCaseName,
        dto.status,
        environment,
        dto.jobPostingResolvedById === true,
      ],
    );

    return {
      prescreening: this.mapPrescreeningRow(result.rows[0]),
      created: result.rows[0].inserted,
      previousJobPostingId: result.rows[0].previous_job_posting_id ?? null,
    };
  }

  // Linha de divergência webhook × card (tabela `talentum_webhook_divergences`, migration 563).
  // Só ids, tipo e ambiente — nunca telefone/e-mail/nome. Roda no `client` da transação do chamador.
  async insertDivergence(dto: InsertTalentumDivergenceDTO, client?: { query: Pool['query'] }): Promise<void> {
    const db = client || this.pool;
    await db.query(
      `INSERT INTO talentum_webhook_divergences
         (kind, talentum_prescreening_id, talentum_profile_id, prescreening_id, worker_id,
          job_posting_id, expected_job_posting_id, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        dto.kind,
        dto.talentumPrescreeningId,
        dto.talentumProfileId,
        dto.prescreeningId,
        dto.workerId,
        dto.jobPostingId,
        dto.expectedJobPostingId,
        dto.environment,
      ],
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // upsertQuestion
  //   ON CONFLICT (question_id):
  //     question      → sempre sobrescreve (texto pode mudar no Talentum)
  //     response_type → sempre sobrescreve (idem)
  //     updated_at    → sempre NOW()
  // ─────────────────────────────────────────────────────────────────
  async upsertQuestion(
    dto: UpsertTalentumQuestionDTO,
  ): Promise<{ question: TalentumQuestion; created: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO talentum_questions (question_id, question, response_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (question_id) DO UPDATE SET
         question      = EXCLUDED.question,
         response_type = EXCLUDED.response_type,
         updated_at    = NOW()
       RETURNING *, (xmax = 0) AS inserted`,
      [dto.questionId, dto.question, dto.responseType],
    );

    return {
      question: this.mapQuestionRow(result.rows[0]),
      created: result.rows[0].inserted,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // upsertResponse
  //   ON CONFLICT (prescreening_id, question_id, response_source):
  //     answer     → sempre sobrescreve (worker pode editar antes do COMPLETED)
  //     updated_at → sempre NOW()
  // ─────────────────────────────────────────────────────────────────
  async upsertResponse(
    dto: UpsertTalentumResponseDTO,
  ): Promise<{ response: TalentumPrescreeningResponse; created: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO talentum_prescreening_responses
         (prescreening_id, question_id, answer, response_source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (prescreening_id, question_id, response_source) DO UPDATE SET
         answer     = EXCLUDED.answer,
         updated_at = NOW()
       RETURNING *, (xmax = 0) AS inserted`,
      [dto.prescreeningId, dto.questionId, dto.answer, dto.responseSource],
    );

    return {
      response: this.mapResponseRow(result.rows[0]),
      created: result.rows[0].inserted,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // upsertWorkerJobApplicationFromTalentum
  //   ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET:
  //     application_funnel_stage → sempre sobrescreve com o statusLabel do Talentum
  //                                (Talentum é a fonte de verdade para a etapa do funil)
  //     match_score              → sempre sobrescreve com o score do Talentum
  //                                (score pode mudar a cada POST ANALYZED)
  //     updated_at               → sempre NOW()
  //     acquisition_channel      → NUNCA modificado aqui (first-touch wins via track-channel
  //                                endpoint; Talentum não conhece canal social)
  //   F7.c (ADR-004): application_status removido — funnel_stage + source carregam toda a informação.
  //   Retorna previousStage para detectar transições (ex: SCREENED → QUALIFIED)
  //   Aceita client opcional para executar dentro de uma transação existente.
  // ─────────────────────────────────────────────────────────────────
  async upsertWorkerJobApplicationFromTalentum(
    dto: {
      workerId: string;
      jobPostingId: string;
      applicationFunnelStage: string;
      matchScore: number;
    },
    client?: { query: Pool['query'] },
  ): Promise<{ previousStage: string | null }> {
    const db = client || this.pool;

    const result = await db.query(
      `WITH previous AS (
         SELECT application_funnel_stage
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2
       )
       INSERT INTO worker_job_applications (
         worker_id,
         job_posting_id,
         application_funnel_stage,
         match_score,
         source
       ) VALUES ($1, $2, $3, $4, 'talentum')
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         application_funnel_stage = CASE
           WHEN funnel_stage_precedence(EXCLUDED.application_funnel_stage)
                >= funnel_stage_precedence(worker_job_applications.application_funnel_stage)
           THEN EXCLUDED.application_funnel_stage
           ELSE worker_job_applications.application_funnel_stage
         END,
         match_score              = EXCLUDED.match_score,
         source                   = COALESCE(NULLIF(worker_job_applications.source, 'manual'), EXCLUDED.source),
         updated_at               = NOW()
       RETURNING (SELECT application_funnel_stage FROM previous) AS previous_stage`,
      [dto.workerId, dto.jobPostingId, dto.applicationFunnelStage, dto.matchScore],
    );

    return { previousStage: result.rows[0]?.previous_stage ?? null };
  }

  // ─────────────────────────────────────────────────────────────────
  // findByTalentumId — busca por talentum_prescreening_id (chave externa)
  // ─────────────────────────────────────────────────────────────────
  async findByTalentumId(talentumPrescreeningId: string): Promise<TalentumPrescreening | null> {
    const result = await this.pool.query(
      `SELECT * FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`,
      [talentumPrescreeningId],
    );
    return result.rows.length > 0 ? this.mapPrescreeningRow(result.rows[0]) : null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Row mappers (snake_case → camelCase)
  // ─────────────────────────────────────────────────────────────────

  private mapPrescreeningRow(row: any): TalentumPrescreening {
    return {
      id:                     row.id,
      talentumPrescreeningId: row.talentum_prescreening_id,
      talentumProfileId:      row.talentum_profile_id,
      workerId:               row.worker_id,
      jobPostingId:           row.job_posting_id,
      jobCaseName:            row.job_case_name,
      status:                 row.status,
      createdAt:              row.created_at,
      updatedAt:              row.updated_at,
    };
  }

  private mapQuestionRow(row: any): TalentumQuestion {
    return {
      id:           row.id,
      questionId:   row.question_id,
      question:     row.question,
      responseType: row.response_type,
      createdAt:    row.created_at,
      updatedAt:    row.updated_at,
    };
  }

  private mapResponseRow(row: any): TalentumPrescreeningResponse {
    return {
      id:             row.id,
      prescreeningId: row.prescreening_id,
      questionId:     row.question_id,
      answer:         row.answer,
      responseSource: row.response_source,
      createdAt:      row.created_at,
      updatedAt:      row.updated_at,
    };
  }
}
