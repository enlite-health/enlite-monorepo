import { ShortIoClient } from './ShortIoClient';

export type SocialChannel = 'facebook' | 'instagram' | 'whatsapp' | 'linkedin' | 'site';

export interface BuildShortLinkInput {
  caseNumber: number;
  vacancyNumber: number;
  channel: SocialChannel;
  country?: string | null;
}

export interface BuildShortLinkResult {
  shortURL: string;
  id: string;
  originalURL: string;
}

export class ShortLinkService {
  private readonly client: ShortIoClient;
  private readonly domain: string;

  constructor(apiKey: string, domain: string) {
    this.client = new ShortIoClient({ apiKey, domain });
    this.domain = domain;
  }

  static fromEnv(): ShortLinkService | null {
    const apiKey = process.env.SHORT_IO_API_KEY;
    const domain = process.env.SHORT_IO_DOMAIN;
    if (!apiKey || !domain) return null;
    return new ShortLinkService(apiKey, domain);
  }

  async buildAndCreate(input: BuildShortLinkInput): Promise<BuildShortLinkResult> {
    const utmSource = input.channel === 'site' ? 'portal_jobs' : input.channel;
    const baseUrl = `https://app.enlite.health/vacantes/caso${input.caseNumber}-${input.vacancyNumber}`;
    const utmParams = new URLSearchParams({
      utm_source: utmSource,
      utm_medium: 'vacante',
      utm_campaign: String(input.caseNumber),
      utm_id: 'recrutamento',
      ...(input.country ? { utm_term: input.country } : {}),
    });
    const originalURL = `${baseUrl}?${utmParams.toString()}`;

    const result = await this.client.createLink({
      domain: this.domain,
      originalURL,
      title: `Caso ${input.caseNumber}-${input.vacancyNumber} — ${input.channel}`,
    });

    return { ...result, originalURL };
  }

  /** Deletes a stored short link from Short.io by its id. Idempotent. */
  async delete(id: string): Promise<void> {
    await this.client.deleteLink(id);
  }
}
