/** Leitura das perguntas do NOSSO banco no formato do Talentum (único mapeador: publish, sync e edição de descrição). */
import type { Pool } from 'pg';
import type { TalentumQuestion } from '../domain/ITalentumApiClient';
import { normalizePrescreeningResponseType } from '@shared/utils/normalizePrescreeningResponseType';

export interface PrescreeningQuestionRow {
  question: string;
  response_type: unknown;
  desired_response: string;
  weight: number;
  required: boolean;
  analyzed: boolean;
  early_stoppage: boolean;
}

export function rowToTalentumQuestion(row: PrescreeningQuestionRow): TalentumQuestion {
  return {
    question: row.question,
    type: 'text' as const,
    // Ticket 86ajfm80t: envia o formato configurado (respeita só-texto
    // deliberado); default seguro ['text','audio'] quando o dado é nulo/vazio.
    responseType: normalizePrescreeningResponseType(row.response_type),
    desiredResponse: row.desired_response,
    weight: row.weight,
    required: row.required,
    analyzed: row.analyzed,
    earlyStoppage: row.early_stoppage,
  };
}

export async function loadLocalPrescreeningQuestions(
  db: Pick<Pool, 'query'>,
  jobPostingId: string,
): Promise<TalentumQuestion[]> {
  const result = await db.query(
    `SELECT id, question, response_type, desired_response, weight,
            required, analyzed, early_stoppage
     FROM job_posting_prescreening_questions
     WHERE job_posting_id = $1
     ORDER BY question_order ASC`,
    [jobPostingId],
  );
  return result.rows.map(rowToTalentumQuestion);
}
