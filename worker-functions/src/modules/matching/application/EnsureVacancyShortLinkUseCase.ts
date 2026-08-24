import { Pool } from 'pg';
import { ShortLinkService, type SocialChannel } from '../infrastructure/shortlinks/ShortLinkService';

interface StoredLink {
  url: string;
  id: string;
}

export class EnsureVacancyShortLinkUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly shortLinkService: ShortLinkService,
  ) {}

  async execute(
    vacancyId: string,
    channel: SocialChannel = 'site',
  ): Promise<{ shortURL: string; alreadyExisted: boolean }> {
    const result = await this.pool.query<{
      case_number: number;
      vacancy_number: number;
      country: string | null;
      social_short_links: Record<string, string | StoredLink>;
    }>(
      `SELECT jp.case_number, jp.vacancy_number, jp.country,
              COALESCE(jp.social_short_links, '{}'::jsonb) AS social_short_links
       FROM job_postings jp
       WHERE jp.id = $1 AND jp.deleted_at IS NULL`,
      [vacancyId],
    );

    if (result.rows.length === 0) throw new Error(`Vacancy ${vacancyId} not found`);

    const { case_number, vacancy_number, country, social_short_links } = result.rows[0];

    const existing = social_short_links[channel];
    if (existing) {
      const url = typeof existing === 'string' ? existing : existing.url;
      return { shortURL: url, alreadyExisted: true };
    }

    const { shortURL, id } = await this.shortLinkService.buildAndCreate({
      caseNumber: case_number,
      vacancyNumber: vacancy_number,
      channel,
      country,
    });

    const updatedLinks: Record<string, StoredLink> = {};
    for (const [key, val] of Object.entries(social_short_links)) {
      updatedLinks[key] = typeof val === 'string' ? { url: val, id: '' } : (val as StoredLink);
    }
    updatedLinks[channel] = { url: shortURL, id };

    await this.pool.query(
      `UPDATE job_postings SET social_short_links = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updatedLinks), vacancyId],
    );

    return { shortURL, alreadyExisted: false };
  }
}
