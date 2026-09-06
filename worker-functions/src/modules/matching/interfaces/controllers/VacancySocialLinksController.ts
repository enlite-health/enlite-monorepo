import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { loggingAls, reportError } from '@shared/logging';
import { JobPostingAuditRepository } from '../../infrastructure/JobPostingAuditRepository';

const SOCIAL_CHANNELS = ['facebook', 'instagram', 'whatsapp', 'linkedin', 'site'] as const;
type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

interface StoredLink {
  url: string;
  id: string;
}

const GenerateLinkBodySchema = z.object({
  channel: z.enum(SOCIAL_CHANNELS),
});

/**
 * VacancySocialLinksController
 *
 * Gera links encurtados via Short.io com UTM tracking por canal social
 * e consulta estatísticas de cliques.
 *
 * Endpoints:
 *   POST /api/admin/vacancies/:id/social-links       — Gera short link para um canal
 *   GET  /api/admin/vacancies/:id/social-links-stats  — Retorna cliques por canal
 */
export class VacancySocialLinksController {
  private db: Pool;
  private auditRepo: JobPostingAuditRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.auditRepo = new JobPostingAuditRepository();
  }

  async generateSocialLink(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const parseResult = GenerateLinkBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Invalid request body. Expected { channel: "facebook" | "instagram" | "whatsapp" | "linkedin" | "site" }',
          details: parseResult.error.flatten().fieldErrors,
        });
        return;
      }

      const { channel } = parseResult.data;

      const vacancyResult = await this.db.query<{
        case_number: number | null;
        vacancy_number: number;
        country: string | null;
        social_short_links: Record<string, string | StoredLink>;
      }>(
        `SELECT jp.case_number, jp.vacancy_number, jp.country,
                COALESCE(jp.social_short_links, '{}'::jsonb) as social_short_links
         FROM job_postings jp
         WHERE jp.id = $1 AND jp.deleted_at IS NULL`,
        [id],
      );

      if (vacancyResult.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const { case_number, vacancy_number, country, social_short_links } = vacancyResult.rows[0];

      if (case_number == null) {
        res.status(400).json({ success: false, error: 'Vacancy has no case_number' });
        return;
      }

      // Já existe link para esse canal — não permitir regerar
      const existing = social_short_links[channel];
      if (existing) {
        const url = typeof existing === 'string' ? existing : existing.url;
        res.status(409).json({ success: false, error: `Link for ${channel} already exists: ${url}` });
        return;
      }

      // UTM padrão GA4 definido pelo marketing (Diego)
      const utmSource = channel === 'site' ? 'portal_jobs' : channel;
      const baseUrl = `https://app.enlite.health/vacantes/caso${case_number}-${vacancy_number}`;
      const utmParams = new URLSearchParams({
        utm_source: utmSource,
        utm_medium: 'vacante',
        utm_campaign: String(case_number),
        utm_id: 'recrutamento',
        ...(country ? { utm_term: country } : {}),
      });
      const originalURL = `${baseUrl}?${utmParams.toString()}`;

      const apiKey = process.env.SHORT_IO_API_KEY;
      const domain = process.env.SHORT_IO_DOMAIN;

      if (!apiKey || !domain) {
        res.status(500).json({ success: false, error: 'Short.io not configured' });
        return;
      }

      const shortIoResponse = await fetch('https://api.short.io/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({
          domain,
          originalURL,
          title: `Caso ${case_number}-${vacancy_number} — ${channel}`,
        }),
      });

      if (!shortIoResponse.ok) {
        const errorBody = await shortIoResponse.text();
        console.error('[VacancySocialLinksController] Short.io error:', shortIoResponse.status, errorBody);
        res.status(502).json({ success: false, error: 'Failed to create short link', details: errorBody });
        return;
      }

      const shortIoData = await shortIoResponse.json() as { shortURL: string; id: string };

      // Salva url + id para poder consultar stats depois
      const updatedLinks: Record<string, StoredLink> = {};
      for (const [key, val] of Object.entries(social_short_links)) {
        updatedLinks[key] = typeof val === 'string' ? { url: val, id: '' } : val as StoredLink;
      }
      updatedLinks[channel] = { url: shortIoData.shortURL, id: String(shortIoData.id) };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (req as any).user as { uid?: string } | undefined;
      const actorUserId = user?.uid ?? null;
      const traceId = loggingAls.getStore()?.traceId ?? null;

      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the UPDATE above) intact.
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE job_postings SET social_short_links = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(updatedLinks), id],
        );
        await this.auditRepo.logEventSafe(client, {
          jobPostingId: id,
          eventType: 'UPDATED',
          fieldName: 'social_short_links',
          changes: { before: null, after: { channel, shortURL: shortIoData.shortURL } },
          actorUserId,
          actorType: 'HUMAN',
          actorLabel: 'admin_panel',
          traceId,
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.status(200).json({
        success: true,
        data: { channel, shortURL: shortIoData.shortURL, social_short_links: updatedLinks },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[VacancySocialLinksController] Error generating social link:', message);
      res.status(500).json({ success: false, error: 'Failed to generate social link', details: message });
    }
  }

  /**
   * GET /api/admin/vacancies/:id/social-links-stats
   *
   * Para cada link armazenado, consulta Short.io /links/{id} para obter totalClicks.
   */
  async getSocialLinksStats(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const vacancyResult = await this.db.query<{
        social_short_links: Record<string, string | StoredLink>;
      }>(
        `SELECT COALESCE(social_short_links, '{}'::jsonb) as social_short_links
         FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (vacancyResult.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const apiKey = process.env.SHORT_IO_API_KEY;
      if (!apiKey) {
        res.status(500).json({ success: false, error: 'Short.io not configured' });
        return;
      }

      const links = vacancyResult.rows[0].social_short_links;
      const stats: Record<string, { url: string; clicks: number }> = {};

      const entries = Object.entries(links).filter(([, val]) => {
        const linkId = typeof val === 'string' ? '' : val.id;
        return !!linkId;
      });

      const results = await Promise.allSettled(
        entries.map(async ([channel, val]) => {
          const stored = val as StoredLink;
          const resp = await fetch(`https://api.short.io/links/${stored.id}`, {
            headers: { Authorization: apiKey },
          });
          if (!resp.ok) return { channel, url: stored.url, clicks: 0 };
          const data = await resp.json() as { clicks: number };
          return { channel, url: stored.url, clicks: data.clicks ?? 0 };
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { channel, url, clicks } = result.value;
          stats[channel] = { url, clicks };
        }
      }

      // Inclui links sem ID (legado) com clicks = 0
      for (const [channel, val] of Object.entries(links)) {
        if (!stats[channel]) {
          const url = typeof val === 'string' ? val : val.url;
          stats[channel] = { url, clicks: 0 };
        }
      }

      res.status(200).json({ success: true, data: stats });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[VacancySocialLinksController] Error fetching stats:', message);
      res.status(500).json({ success: false, error: 'Failed to fetch stats', details: message });
    }
  }
}
