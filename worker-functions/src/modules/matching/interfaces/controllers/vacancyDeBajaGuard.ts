/**
 * Spec 084 (P4/R6): vaga dada de baja é SÓ CONSULTA — o Kanban abre, mas nada nele se move, e o Match não roda.
 * O que se guarda (candidatos, histórico) fica; o que se recusa é continuar TRABALHANDO uma vaga sem serviço contratado.
 */
import type { Response } from 'express';
import type { Pool } from 'pg';
import { BAJA_REFUSAL_MESSAGES, DE_BAJA_STATUS, type VacancyGuardCode } from '../../domain/VacancyBajaPolicy';

type Queryable = Pick<Pool, 'query'>;

/** Status da vaga viva (ou null se não existe/apagada). Tolerante a mocks que não devolvem linha. */
export async function vacancyStatusOf(db: Queryable, jobPostingId: string): Promise<string | null> {
  const res = await db.query<{ status: string | null }>(
    `SELECT status FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
    [jobPostingId],
  );
  return res?.rows?.[0]?.status ?? null;
}

export async function vacancyIsDeBaja(db: Queryable, jobPostingId: string): Promise<boolean> {
  return (await vacancyStatusOf(db, jobPostingId)) === DE_BAJA_STATUS;
}

/** 409 com código estável + es/pt-BR; a tela traduz pelo código. */
export function sendVacancyDeBajaReadOnly(res: Response): void {
  res.status(409).json({
    success: false,
    code: 'VACANCY_DE_BAJA_READ_ONLY',
    error: 'Vaga dada de baixa: só consulta.',
    messages: {
      es: 'Vacante dada de baja: solo consulta.',
      'pt-BR': 'Vaga dada de baixa: só consulta.',
    },
  });
}

/** 409 com código estável + mensagem es/pt-BR para as recusas da baixa que não são "só consulta" (Talentum, apagar). */
export function sendVacancyDeBajaRefusal(res: Response, code: Extract<VacancyGuardCode, 'VACANCY_DE_BAJA_TALENTUM_REFUSED' | 'VACANCY_DE_BAJA_NO_DELETE'>): void {
  const messages = BAJA_REFUSAL_MESSAGES[code];
  res.status(409).json({ success: false, code, error: messages['pt-BR'], messages });
}

export { BAJA_REFUSAL_MESSAGES };
