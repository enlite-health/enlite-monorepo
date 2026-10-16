/**
 * GoogleDocsPromptProvider
 *
 * Fetches prompt content from Google Docs via the Drive export API.
 * Uses Application Default Credentials (same service account as Cloud Run).
 * Caches content in memory with a configurable TTL to avoid calling
 * the API on every vacancy parse.
 *
 * Throws a descriptive error if the Google Drive API call fails.
 */

import { GoogleAuth } from 'google-auth-library';

interface CacheEntry {
  content: string;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class GoogleDocsPromptProvider {
  private auth: GoogleAuth;
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    this.ttlMs = ttlMs;
  }

  async getPrompt(docId: string): Promise<string> {
    if (!docId) {
      throw new Error(
        'Prompt document ID não configurado. Verifique as variáveis PROMPT_DOC_ID_AT e PROMPT_DOC_ID_CUIDADOR.',
      );
    }

    const cached = this.cache.get(docId);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.content;
    }

    try {
      const content = await this.fetchDocContent(docId);
      this.cache.set(docId, { content, fetchedAt: Date.now() });
      console.log(
        `[GoogleDocsPrompt] Fetched doc ${docId} (${content.length} chars)`,
      );
      return content;
    } catch (err) {
      // If we have stale cache, use it and warn
      if (cached) {
        console.warn(
          `[GoogleDocsPrompt] Failed to refresh doc ${docId}, using cached version:`,
          err instanceof Error ? err.message : err,
        );
        return cached.content;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Erro ao buscar prompt do Google Drive (doc: ${docId}): ${detail}. ` +
          'Verifique se o documento foi compartilhado com o service account e se a Drive API está habilitada.',
      );
    }
  }

  private async fetchDocContent(docId: string): Promise<string> {
    const client = await this.auth.getClient();
    const url = `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`;

    const response = await client.request<string>({ url });
    const content =
      typeof response.data === 'string'
        ? response.data.trim()
        : String(response.data).trim();

    if (!content) {
      throw new Error(`Documento vazio no Google Drive (doc: ${docId})`);
    }
    return content;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
