/**
 * SyncVacancyContentToTalentumUseCase — caminho ÚNICO de envio, ao Talentum, do conteúdo de uma vaga JÁ PUBLICADA
 * (perguntas do prescreening + descrição). O nosso banco é a fonte: lê as NOSSAS perguntas e a `talentum_description`,
 * lê do Talentum só os `questionId` remotos (para o casamento) e faz UM PATCH+PUT in-place (`updatePrescreening`).
 *
 * Nunca lança: o resultado volta como `TalentumSyncResult` (o chamador grava local ANTES e só reporta o envio).
 * Sem `talentum_project_id` → NOT_PUBLISHED e nenhuma chamada ao cliente. Log sem PII (só id da vaga, etapa e status HTTP).
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumApiClient, toV2ProjectName } from '../infrastructure/TalentumApiClient';
import type { ITalentumApiClient } from '../domain/ITalentumApiClient';
import { DEAD_PROJECT_MESSAGE, isDeadProjectError, isOtherAccountError, OTHER_ACCOUNT_MESSAGE } from '../domain/talentumErrors';
import { matchQuestionIds } from '../domain/talentumQuestionMatching';
import { loadLocalPrescreeningQuestions } from './prescreeningQuestionRows';

export type TalentumSyncStatus = 'OK' | 'NOT_PUBLISHED' | 'OTHER_ACCOUNT' | 'FAILED';

export interface TalentumSyncResult {
  status: TalentumSyncStatus;
  message?: string;
}

type ContentClient = Pick<ITalentumApiClient, 'getPrescreening' | 'updatePrescreening'>;

/** Traduz o erro de uma chamada ao Talentum no resultado de sync (compartilhado entre os passos). */
export function toSyncFailure(jobPostingId: string, step: string, err: unknown): TalentumSyncResult {
  const raw = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(raw)?.[1] ?? 'n/a';
  console.error(`[SyncVacancyContent] vacancy=${jobPostingId} step=${step} http=${http}`);
  if (isOtherAccountError(err)) return { status: 'OTHER_ACCOUNT', message: OTHER_ACCOUNT_MESSAGE };
  if (isDeadProjectError(err)) return { status: 'FAILED', message: DEAD_PROJECT_MESSAGE };
  return { status: 'FAILED', message: `Talentum API error (${step}) HTTP ${http}` };
}

export class SyncVacancyContentToTalentumUseCase {
  constructor(
    private readonly db: Pick<Pool, 'query'> = DatabaseConnection.getInstance().getPool(),
    private readonly clientFactory: () => Promise<ContentClient> = () => TalentumApiClient.create(),
  ) {}

  async propagate(jobPostingId: string, actor?: { traceId?: string | null }): Promise<TalentumSyncResult> {
    try {
      return await this.run(jobPostingId);
    } catch (err) {
      console.error(`[SyncVacancyContent] vacancy=${jobPostingId} trace=${actor?.traceId ?? 'n/a'} unexpected`);
      return toSyncFailure(jobPostingId, 'unexpected', err);
    }
  }

  private async run(jobPostingId: string): Promise<TalentumSyncResult> {
    const jp = await this.db.query(
      `SELECT title, talentum_project_id, talentum_description
         FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
      [jobPostingId],
    );
    const vacancy = jp.rows[0] as
      | { title: string | null; talentum_project_id: string | null; talentum_description: string | null }
      | undefined;
    if (!vacancy?.talentum_project_id) return { status: 'NOT_PUBLISHED' };
    const projectId = vacancy.talentum_project_id;

    const local = await loadLocalPrescreeningQuestions(this.db, jobPostingId);
    if (local.length === 0) {
      // Mandar [] apagaria todas as perguntas do projeto no ar.
      return { status: 'FAILED', message: 'Sin preguntas de prescreening configuradas; no se envió nada a Talentum.' };
    }

    let client: ContentClient;
    try {
      client = await this.clientFactory();
    } catch (err) {
      return toSyncFailure(jobPostingId, 'client', err);
    }

    let project;
    try {
      project = await client.getPrescreening(projectId);
    } catch (err) {
      return toSyncFailure(jobPostingId, 'get', err);
    }

    const questions = matchQuestionIds(local, project.questions);
    const description = vacancy.talentum_description?.trim() || project.description;
    try {
      await client.updatePrescreening(projectId, {
        title: toV2ProjectName(vacancy.title ?? project.title),
        description,
        questions,
      });
    } catch (err) {
      return toSyncFailure(jobPostingId, 'update', err);
    }
    return { status: 'OK' };
  }
}
