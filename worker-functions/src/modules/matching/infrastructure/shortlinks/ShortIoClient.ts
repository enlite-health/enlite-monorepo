export interface CreateShortLinkInput {
  domain: string;
  originalURL: string;
  title: string;
}

export interface CreateShortLinkResult {
  shortURL: string;
  id: string;
}

export interface ShortIoClientConfig {
  apiKey: string;
  domain: string;
  /** Default `https://api.short.io` (produção intacta). O e2e aponta para o stub local (`SHORT_IO_BASE_URL`): nenhum teste toca o Short.io real. */
  baseUrl?: string;
}

export const SHORT_IO_DEFAULT_BASE_URL = 'https://api.short.io';

export class ShortIoClient {
  constructor(readonly config: ShortIoClientConfig) {}

  private get baseUrl(): string {
    return (this.config.baseUrl ?? SHORT_IO_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async createLink(input: CreateShortLinkInput): Promise<CreateShortLinkResult> {
    const response = await fetch(`${this.baseUrl}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.config.apiKey },
      body: JSON.stringify({
        domain: input.domain,
        originalURL: input.originalURL,
        title: input.title,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Short.io ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { shortURL: string; id: string };
    return { shortURL: data.shortURL, id: String(data.id) };
  }

  /**
   * Deletes a link by its Short.io id. Idempotent: a 404 (link already gone)
   * is treated as success so cleanup jobs can be re-run safely.
   */
  async deleteLink(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/links/${id}`, {
      method: 'DELETE',
      headers: { Authorization: this.config.apiKey },
    });

    if (response.status === 404) return;

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Short.io ${response.status}: ${body}`);
    }
  }
}
