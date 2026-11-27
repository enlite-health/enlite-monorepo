/**
 * Leitor de "esta vaga pode receber candidatura?" — semaforo-da-vaga F4 (I4). A decisão NÃO é daqui: vem do dono de publicável
 * (`vagaPublicavelSql`, `domain/vacancyPublication.ts`), com a opção `incluirTeste` (a vaga de teste existe para ser exercida de
 * ponta a ponta em produção: página pública e candidatura a servem; feed, raio e Luz não).
 */
import type { Pool } from 'pg';
import { vagaPublicavelSql } from '../domain/vacancyPublication';
import { DE_BAJA_STATUS } from '../domain/VacancyBajaPolicy';

export type VacancyApplicability = 'APPLICABLE' | 'DE_BAJA' | 'NOT_PUBLISHABLE';

/** Sem linha (inexistente) = `NOT_PUBLISHABLE`: nada que o dono publique. `DE_BAJA` segue distinto (código estável da spec 084). */
export async function readVacancyApplicability(db: Pick<Pool, 'query'>, jobPostingId: string): Promise<VacancyApplicability> {
  const res = await db.query<{ status: string | null; publicavel: boolean }>(
    `SELECT jp.status, ${vagaPublicavelSql('jp', 'p', { incluirTeste: true })} AS publicavel
       FROM job_postings jp
       LEFT JOIN patients p ON p.id = jp.patient_id
      WHERE jp.id = $1`,
    [jobPostingId],
  );
  const row = res?.rows?.[0];
  if (!row) return 'NOT_PUBLISHABLE';
  if (row.status === DE_BAJA_STATUS) return 'DE_BAJA';
  return row.publicavel === true ? 'APPLICABLE' : 'NOT_PUBLISHABLE';
}
