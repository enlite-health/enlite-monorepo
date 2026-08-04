import { Pool } from 'pg';
import { formatSlotOption } from '@shared/index';

export interface InterviewSlotOption {
  /** 1..3 — posição meet_link_N/meet_datetime_N na vaga (o índice que o book usa). */
  index: number;
  /** Legível es-AR, ex.: "Lun 07/04 10:00" (mesma formatação do convite por botão). */
  label: string;
  /** ISO do horário. */
  iso: string;
}

export type ListInterviewSlotsResult =
  | { ok: true; caseNumber: number | null; slots: InterviewSlotOption[] }
  | { ok: false; reason: 'job_not_found' };

/**
 * ListInterviewSlotsForVacancyUseCase — horários de entrevista de uma vaga,
 * SÓ slots futuros (lição do PR #177: prod oferecia horários passados).
 *
 * Dado moldado para a Luz comunicar e o notário verificar; os meet_links NÃO
 * saem daqui (o book resolve o link no servidor — a Luz nunca vê/inventa link).
 */
export class ListInterviewSlotsForVacancyUseCase {
  constructor(private readonly db: Pool) {}

  async execute(jobPostingId: string): Promise<ListInterviewSlotsResult> {
    const result = await this.db.query(
      `SELECT case_number,
              meet_link_1, meet_datetime_1,
              meet_link_2, meet_datetime_2,
              meet_link_3, meet_datetime_3
       FROM job_postings
       WHERE id = $1 AND deleted_at IS NULL`,
      [jobPostingId],
    );

    if (result.rows.length === 0) {
      return { ok: false, reason: 'job_not_found' };
    }

    const row = result.rows[0] as Record<string, string | number | null>;
    const slots: InterviewSlotOption[] = [];

    for (const n of [1, 2, 3]) {
      const link = row[`meet_link_${n}`];
      const datetime = row[`meet_datetime_${n}`];
      if (!link || !datetime) continue;
      const iso = new Date(datetime as string).toISOString();
      if (new Date(iso).getTime() <= Date.now()) continue;
      slots.push({ index: n, label: formatSlotOption(iso), iso });
    }

    return {
      ok: true,
      caseNumber: (row.case_number as number | null) ?? null,
      slots,
    };
  }
}
