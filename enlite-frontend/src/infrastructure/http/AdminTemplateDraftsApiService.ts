/**
 * AdminTemplateDraftsApiService — escrever e salvar a mensagem (spec 010, F2 2.1/2.2).
 *
 * Serviço próprio, mesmo padrão do AdminTemplateCatalogApiService, para não
 * engordar o AdminApiService.
 *
 * 🔒 REGISTRO: `submitDraft` escreve para FORA do perímetro (cria Content na
 * Twilio e submete à Meta) e o parecer do `lex` NÃO foi emitido. O Gabriel
 * determinou construir assim em 31/08/2026.
 *
 * ⚠️ `submitDraft` é IRREVERSÍVEL e exige `confirmado: true` — a confirmação
 * viaja no corpo, não é só um diálogo na tela: uma chamada direta à API sem ela
 * é recusada com 400.
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
  /** SID do Content na Twilio. `null` = nunca submetido. */
  contentSid: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  /** Última falha de submissão, em texto. */
  submissionError: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** 'draft' | 'submitted'. Explícito: a tela muda o que permite conforme ele. */
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
    /** Do 503: 'flag_desligada' | 'sem_credencial'. A tela diz QUAL é. */
    readonly motivo: string | null = null,
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
      typeof json.motivo === 'string' ? json.motivo : null,
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

  /**
   * ⚠️ IRREVERSÍVEL. O `confirmado: true` é exigido pelo servidor: sem ele a
   * chamada é recusada, mesmo que a tela ache que confirmou.
   */
  async submitDraft(id: string): Promise<{ submission: { contentSid: string; slug: string } }> {
    return request<{ submission: { contentSid: string; slug: string } }>(
      'POST', `/api/admin/template-drafts/${id}/submit`, { confirmado: true },
    );
  },

  async duplicateDraft(id: string): Promise<{ draft: TemplateDraft }> {
    return request<{ draft: TemplateDraft }>('POST', `/api/admin/template-drafts/${id}/duplicate`);
  },
};
