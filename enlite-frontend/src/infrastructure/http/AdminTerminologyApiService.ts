/**
 * AdminTerminologyApiService — cliente de `GET /api/admin/terminology/search` (spec 016 F3).
 * Extraído em arquivo próprio (molde `AdminContractedServicesApiService.ts`): componente importa
 * DIRETO, sem passar pelo `AdminApiService` monolítico.
 *
 * 🔴 REQ-21 — este client NUNCA lê nem propaga `code`/`chapter`/`release`: o `.map` abaixo
 * projeta explicitamente só `{ uri, title }`, mesmo que o corpo do servidor um dia vaze mais
 * campos por engano. O código do CID para AQUI, não só no componente que renderiza.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { TerminologyCandidate } from '@domain/entities/Terminology';

/**
 * US-4 (spec 016): "catálogo indisponível" (503) precisa de tratamento DISTINTO de "sem
 * resultado" (200 com `candidates: []`) — o combobox decide a mensagem certa pelo TIPO do erro,
 * nunca por um catch genérico que trata os dois casos igual (a régua da casa: "contagem zero é
 * falha, nunca sucesso" — aqui o análogo é "erro de rede não é lista vazia").
 */
export class TerminologyUnavailableError extends Error {
  constructor(message = 'TERMINOLOGY_UNAVAILABLE') {
    super(message);
    this.name = 'TerminologyUnavailableError';
  }
}

/**
 * F7 (spec 016): o piso de tamanho da busca vivia em DUAS fontes — `MIN_CHARS` guardado no
 * componente e `MIN_SEARCH_QUERY_LENGTH` no backend. Hoje concordam; voltam a divergir no dia em
 * que alguém mudar um dos dois, e o sintoma é mudo ("não perguntei" indistinguível de "não há").
 * O backend passou a DIZER o número no corpo do 400 (`details: { fields:['q'], minQueryLength }`);
 * este client transporta o valor para quem chama, que passa a CONSUMIR em vez de guardar.
 */
export class TerminologyMinQueryLengthError extends Error {
  constructor(readonly minQueryLength: number, message = 'TERMINOLOGY_MIN_QUERY_LENGTH') {
    super(message);
    this.name = 'TerminologyMinQueryLengthError';
  }
}

interface SearchResponseBody {
  success: boolean;
  data?: { candidates: TerminologyCandidate[] };
  error?: string;
  code?: string;
  details?: { fields?: string[]; minQueryLength?: unknown };
}

class AdminTerminologyApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * `chapters` — filtro padrão de TELA (SUP-1, `"06,08"`); `undefined` alarga para o catálogo
   * inteiro. `signal` — o chamador (combobox) aborta a busca anterior a cada tecla nova; este
   * client só precisa REPASSAR o `AbortSignal` ao `fetch` para o cancelamento ser real.
   */
  async search(
    q: string,
    opts: { chapters?: string; signal?: AbortSignal } = {},
  ): Promise<TerminologyCandidate[]> {
    const headers = await this.getAuthHeaders();
    const params = new URLSearchParams({ q, lang: 'es' });
    if (opts.chapters) params.set('chapters', opts.chapters);

    const response = await fetch(
      `${this.baseURL}/api/admin/terminology/search?${params.toString()}`,
      { headers, signal: opts.signal },
    );

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Erro ao conectar ao servidor (HTTP ${response.status})`);
    }

    const json: SearchResponseBody = await response.json();
    if (!json.success) {
      if (json.code === 'TERMINOLOGY_UNAVAILABLE') {
        throw new TerminologyUnavailableError(json.error);
      }
      // F7: o 400 de validação carrega o piso quando é o `q` que está curto demais. Só um NÚMERO
      // conta como piso — `details.minQueryLength` de outro tipo é contrato quebrado, e contrato
      // quebrado vira erro comum, nunca um piso inventado.
      const min = json.details?.minQueryLength;
      if (typeof min === 'number') {
        throw new TerminologyMinQueryLengthError(min, json.error);
      }
      throw new Error(json.error || `HTTP ${response.status}`);
    }
    return (json.data?.candidates ?? []).map((c) => ({ uri: c.uri, title: c.title }));
  }
}

export const AdminTerminologyApiService = new AdminTerminologyApiServiceClass();
