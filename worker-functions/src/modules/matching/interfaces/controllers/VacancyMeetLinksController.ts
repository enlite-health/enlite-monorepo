import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { googleCalendarService } from '../../infrastructure/GoogleCalendarService';

/**
 * VacancyMeetLinksController
 *
 * Responsável por gerenciar os Google Meet links vinculados a vagas (job_postings).
 * Separado de VacanciesController para respeitar o limite de 400 linhas por arquivo.
 *
 * Endpoints:
 *   PUT /api/admin/vacancies/:id/meet-links — Salva até 3 Meet links com datetime resolvido
 */

const MeetLinksBodySchema = z.object({
  meet_links: z.tuple([
    z.string().nullable(),
    z.string().nullable(),
    z.string().nullable(),
  ]),
});

const MeetLinkLookupSchema = z.object({
  link: z.string().min(1),
});

/**
 * Normalize "meet.google.com/abc-defg-hij" (with optional `https://` and
 * `www.`) to the canonical form. Returns the trimmed input untouched when
 * no match is found.
 */
function normalizeMeetLink(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i);
  if (!match) return trimmed;
  return `https://meet.google.com/${match[1].toLowerCase()}`;
}

export class VacancyMeetLinksController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  /**
   * PUT /api/admin/vacancies/:id/meet-links
   *
   * Recebe até 3 Google Meet links, valida formato, resolve datetime
   * via Google Calendar API (em paralelo) e persiste na job_posting.
   *
   * Body: { meet_links: [string|null, string|null, string|null] }
   *
   * Retorna:
   *   200 — { success: true, data: { meet_link_1..3, meet_datetime_1..3 } }
   *   400 — link com formato inválido ou body inválido
   *   404 — vaga não encontrada
   *   500 — erro inesperado
   */
  async updateMeetLinks(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Validação do body com Zod
      const parseResult = MeetLinksBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Invalid request body',
          details: parseResult.error.flatten().fieldErrors,
        });
        return;
      }

      const [link1, link2, link3] = parseResult.data.meet_links;

      // Valida o formato de cada link não-nulo antes de qualquer I/O
      const linksToValidate: { slot: number; link: string }[] = [];
      if (link1 !== null) linksToValidate.push({ slot: 1, link: link1 });
      if (link2 !== null) linksToValidate.push({ slot: 2, link: link2 });
      if (link3 !== null) linksToValidate.push({ slot: 3, link: link3 });

      for (const { slot, link } of linksToValidate) {
        if (!googleCalendarService.isValidMeetLink(link)) {
          res.status(400).json({
            success: false,
            error: `meet_links[${slot - 1}] has an invalid Google Meet URL format`,
          });
          return;
        }
      }

      // Verifica existência da vaga antes de ir ao Calendar
      const existsResult = await this.db.query<{ id: string }>(
        'SELECT id FROM job_postings WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );
      if (existsResult.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      // Resolve datetimes em paralelo (falha silenciosa: retorna null se não achar)
      const [datetime1, datetime2, datetime3] = await Promise.all([
        link1 !== null ? googleCalendarService.resolveDateTime(link1) : Promise.resolve(null),
        link2 !== null ? googleCalendarService.resolveDateTime(link2) : Promise.resolve(null),
        link3 !== null ? googleCalendarService.resolveDateTime(link3) : Promise.resolve(null),
      ]);

      // Persiste os 6 campos na vaga
      await this.db.query(
        `UPDATE job_postings
         SET meet_link_1     = $1,
             meet_datetime_1 = $2,
             meet_link_2     = $3,
             meet_datetime_2 = $4,
             meet_link_3     = $5,
             meet_datetime_3 = $6,
             updated_at      = NOW()
         WHERE id = $7`,
        [link1, datetime1, link2, datetime2, link3, datetime3, id]
      );

      res.status(200).json({
        success: true,
        data: {
          meet_link_1:     link1,
          meet_datetime_1: datetime1,
          meet_link_2:     link2,
          meet_datetime_2: datetime2,
          meet_link_3:     link3,
          meet_datetime_3: datetime3,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[VacancyMeetLinksController] Error updating meet links:', message);
      res.status(500).json({
        success: false,
        error: 'Failed to update meet links',
        details: message,
      });
    }
  }

  /**
   * POST /api/admin/vacancies/meet-links/lookup
   *
   * Wrapper fino sobre `googleCalendarService.resolveDateTime()` (a mesma
   * rotina já consumida pelo PUT /:id/meet-links). Não persiste nada — só
   * permite que o form de criação de vaga (que ainda não tem vacancyId)
   * mostre a data/hora do evento ao perder o foco do input.
   *
   * Body: { link: string }
   *
   * Retorna:
   *   200 — { success: true, data: { normalized: string, datetime: string | null } }
   *   400 — link com formato inválido (mesmo após normalização)
   */
  async lookupMeetDatetime(req: Request, res: Response): Promise<void> {
    try {
      const parseResult = MeetLinkLookupSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Invalid request body',
          details: parseResult.error.flatten().fieldErrors,
        });
        return;
      }

      const normalized = normalizeMeetLink(parseResult.data.link);

      if (!googleCalendarService.isValidMeetLink(normalized)) {
        res.status(400).json({
          success: false,
          error: 'invalid_meet_link',
          data: { normalized, datetime: null },
        });
        return;
      }

      const datetime = await googleCalendarService.resolveDateTime(normalized);

      res.status(200).json({
        success: true,
        data: { normalized, datetime },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[VacancyMeetLinksController] Error looking up meet link:', message);
      res.status(500).json({
        success: false,
        error: 'Failed to lookup meet link',
        details: message,
      });
    }
  }
}
