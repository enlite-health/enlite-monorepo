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

interface SearchResponseBody {
  success: boolean;
  data?: { candidates: TerminologyCandidate[] };
  error?: string;
  code?: string;
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
      throw new Error(json.error || `HTTP ${response.status}`);
    }
    return (json.data?.candidates ?? []).map((c) => ({ uri: c.uri, title: c.title }));
  }
}

export const AdminTerminologyApiService = new AdminTerminologyApiServiceClass();
