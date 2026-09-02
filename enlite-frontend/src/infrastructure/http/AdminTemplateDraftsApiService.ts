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
  /**
   * A chave que une a versão espanhola e a portuguesa (migration 302).
   *
   * Vem do banco já com `COALESCE(base_name, slug)`, então nunca é null —
   * mesma garantia que o catálogo dá. Rascunho antigo, de antes da 301, tem
   * base igual ao próprio slug: não pareia, mas também nunca pareia errado.
   */
  baseName: string;
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
  /**
   * O veredito da META. Vem por LEFT JOIN com `message_templates` — NÃO da
   * tabela de rascunho. `null` = enviado e ela ainda não respondeu.
   */
  metaStatus: string | null;
  metaReason: string | null;
  /** Explicação em prosa da Meta, quando ela manda. */
  metaDetail: string | null;
  metaCheckedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * 'draft' | 'submitted' | 'decided'.
   *   draft     — escrito, não enviado
   *   submitted — enviado, a Meta AINDA não respondeu
   *   decided   — a Meta respondeu; `metaStatus` diz o quê
   * Antes de 01/09 tudo que fora enviado ficava 'submitted' para sempre.
   */
  status: string;
}

export interface DraftEntrada {
  slug: string;
  name: string;
  body: string;
  category: string;
  language: string;
}

/**
 * Uma regra de plataforma violada, como o backend a nomeia.
 *
 * `gravidade` é o que separa as duas coisas que chegam por aqui:
 *   bloqueia → veio num 422, a gravação não aconteceu;
 *   aviso    → veio num 200/201, JÁ gravou, e a tela mostra sem travar nada.
 * Sem esse campo o aviso não teria por onde chegar — era travar ou sumir.
 */
/**
 * O que o servidor respondeu sobre um texto ainda não gravado.
 *
 * 🔒 `bloqueios` e `avisos` chegam SEPARADOS, e continuam separados na tela:
 * "não vai gravar" e "vai gravar e mesmo assim falta isto" são coisas
 * diferentes. Fundi-las pintaria de vermelho um salvamento que deu certo — e a
 * pessoa passaria a ignorar o vermelho.
 */
export interface ResultadoDaValidacao {
  slug: string;
  bloqueios: ProblemaDeRegra[];
  avisos: ProblemaDeRegra[];
}

export interface ProblemaDeRegra {
  campo: 'slug' | 'name' | 'body' | 'category' | 'language';
  regra: string;
  gravidade: 'bloqueia' | 'aviso';
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
  /**
   * Roda as regras SEM gravar — alimenta a lista de verificação ao vivo.
   *
   * 🔒 Não existe régua no cliente: quem responde é `validarRascunho`, a mesma
   * função que decide no `create` e no `submit`. Ver `templateDraftsRoutes.ts`.
   */
  async validarRascunho(entrada: DraftEntrada): Promise<ResultadoDaValidacao> {
    return request<ResultadoDaValidacao>('POST', '/api/admin/template-drafts/validar', entrada);
  },

  async listDrafts(): Promise<{ drafts: TemplateDraft[] }> {
    return request<{ drafts: TemplateDraft[] }>('GET', '/api/admin/template-drafts');
  },

  async createDraft(entrada: DraftEntrada): Promise<{ draft: TemplateDraft; avisos?: ProblemaDeRegra[] }> {
    return request<{ draft: TemplateDraft; avisos?: ProblemaDeRegra[] }>('POST', '/api/admin/template-drafts', entrada);
  },

  async updateDraft(id: string, entrada: DraftEntrada & { version: number }): Promise<{ draft: TemplateDraft; avisos?: ProblemaDeRegra[] }> {
    return request<{ draft: TemplateDraft; avisos?: ProblemaDeRegra[] }>('PUT', `/api/admin/template-drafts/${id}`, entrada);
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
