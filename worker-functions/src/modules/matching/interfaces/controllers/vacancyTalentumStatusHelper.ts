/**
 * vacancyTalentumStatusHelper
 *
 * Module-level helper for VacancyTalentumController.getTalentumStatus.
 * Extracted to keep VacancyTalentumController within the 400-line limit.
 */

import type { Pool } from 'pg';
import { TalentumApiClient } from '@modules/integration';

export type TalentumStatusResult =
  | { kind: 'not_found' }
  | {
      kind: 'ok';
      published: boolean;
      exists: boolean;
      whatsappUrl?: string;
      /**
       * true quando TODA pergunta do projeto na Talentum aceita áudio
       * (responseType contém 'audio'). Fonte de verdade externa — usado pelo
       * synthetic monitoring (ticket 86ajfm80t) para provar, contra a Talentum
       * real, que a vaga publicada nasceu aceitando áudio. `undefined` quando o
       * projeto não existe/não está publicado (não há perguntas para avaliar).
       */
      audioEnabled?: boolean;
    }
  | { kind: 'error'; message: string };

/**
 * Verifica se a vaga está realmente publicada no Talentum (fonte de
 * verdade externa), não apenas se `talentum_project_id` está preenchido
 * no nosso banco.
 *
 *   - vaga não encontrada             → { kind: 'not_found' }
 *   - talentum_project_id NULL        → { kind: 'ok', published: false, exists: false }
 *   - projectId presente + GET ok     → { kind: 'ok', published: true, exists: true, whatsappUrl }
 *   - projectId presente + GET 404    → { kind: 'ok', published: true, exists: false } (não é erro)
 *   - qualquer outro erro do Talentum → { kind: 'error', message }
 */
export async function getVacancyTalentumStatus(
  db: Pool,
  vacancyId: string,
): Promise<TalentumStatusResult> {
  const jpResult = await db.query<{ talentum_project_id: string | null }>(
    `SELECT talentum_project_id FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
    [vacancyId],
  );
  if (jpResult.rows.length === 0) {
    return { kind: 'not_found' };
  }

  const projectId = jpResult.rows[0].talentum_project_id;
  if (!projectId) {
    return { kind: 'ok', published: false, exists: false };
  }

  try {
    const talentumClient = await TalentumApiClient.create();
    const project = await talentumClient.getPrescreening(projectId);
    // audioEnabled: todas as perguntas aceitam áudio na Talentum (fonte externa).
    // Só é significativo se houver perguntas; projeto sem perguntas → undefined.
    const questions = project.questions ?? [];
    const audioEnabled =
      questions.length > 0 && questions.every((q) => (q.responseType ?? []).includes('audio'));
    return {
      kind: 'ok',
      published: true,
      exists: true,
      whatsappUrl: project.whatsappUrl,
      audioEnabled,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HTTP 404')) {
      return { kind: 'ok', published: true, exists: false };
    }
    return { kind: 'error', message: msg };
  }
}
