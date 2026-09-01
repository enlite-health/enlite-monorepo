/**
 * AdminTemplateDraftsApiService — escrever e salvar a mensagem (spec 010, F2 2.1/2.2).
 *
 * Serviço próprio, mesmo padrão do AdminTemplateCatalogApiService, para não
 * engordar o AdminApiService.
 *
 * 🔒 NÃO existe método de submissão, e a ausência é o portão: submeter à Meta
 * sai do nosso perímetro (F2 2.4) e depende de parecer do `lex`. O teste deste
 * serviço assere que a superfície pública tem exatamente 4 métodos — acrescentar
 * um quinto sem passar pelo `lex` reprova.
 *
 * ⚠️ Por que este serviço não reusa o `request` do catálogo: aquele descarta o
 * corpo do erro (`throw new Error(json.error)`), e aqui o corpo É a informação —
 * o 422 traz a LISTA de regras violadas e o 409 traz a versão atual de quem
 * gravou antes. Jogar isso fora deixaria a tela sem ter o que dizer à pessoa.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

export interface TemplateDraft {
  id: string;
  slug: string;
  name: string;
  body: string;
  category: string;
  language: string;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Sempre 'draft' enquanto a submissão não existir. Guardado ≠ submetido. */
  status: string;
}

export interface DraftEntrada {
  slug: string;
  name: string;
  body: string;
  category: string;
  language: string;
}

/** Uma regra de plataforma violada, como o backend a nomeia. */
export interface ProblemaDeRegra {
  campo: 'slug' | 'name' | 'body' | 'category' | 'language';
  regra: string;
}

/**
 * O erro que a tela sabe ler.
 *
 * Classe e não objeto solto porque o `catch` precisa distinguir "a plataforma
 * recusou o texto" (que a pessoa conserta) de "a rede caiu" (que ela não).
 */
export class DraftApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codigo: string | null = null,
    readonly problemas: ProblemaDeRegra[] = [],
    readonly versaoAtual: number | null = null,
  ) {
    super(message);
    this.name = 'DraftApiError';
  }
}

const authService = new FirebaseAuthService();

function getBaseURL(): string {
  return (import.meta as { env?: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await authService.getIdToken();
  const response = await fetch(`${getBaseURL()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const json = await response.json().catch(() => ({}));
  if (!json.success) {
    throw new DraftApiError(
      json.error || `HTTP ${response.status}`,
      response.status,
      typeof json.error === 'string' ? json.error : null,
      Array.isArray(json.problemas) ? json.problemas : [],
      typeof json.versaoAtual === 'number' ? json.versaoAtual : null,
    );
  }
  return json.data as T;
}

export const AdminTemplateDraftsApiService = {
  async listDrafts(): Promise<{ drafts: TemplateDraft[] }> {
    return request<{ drafts: TemplateDraft[] }>('GET', '/api/admin/template-drafts');
  },

  async createDraft(entrada: DraftEntrada): Promise<{ draft: TemplateDraft }> {
    return request<{ draft: TemplateDraft }>('POST', '/api/admin/template-drafts', entrada);
  },

  async updateDraft(id: string, entrada: DraftEntrada & { version: number }): Promise<{ draft: TemplateDraft }> {
    return request<{ draft: TemplateDraft }>('PUT', `/api/admin/template-drafts/${id}`, entrada);
  },

  async archiveDraft(id: string): Promise<void> {
    await request<unknown>('DELETE', `/api/admin/template-drafts/${id}`);
  },
};
