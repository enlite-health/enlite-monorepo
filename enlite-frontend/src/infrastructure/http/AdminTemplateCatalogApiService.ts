/**
 * AdminTemplateCatalogApiService — o catálogo de plantillas (spec 010, F1).
 *
 * Serviço próprio, mesmo padrão do AdminFunnelStageMessagesApiService, para não
 * engordar o AdminApiService.
 *
 * F1 é ESPELHO: só leitura. Não existe método de escrita aqui, e o teste assere
 * isso — criar e submeter template é F2, sai do nosso perímetro e depende de
 * parecer do `lex`. Acrescentar um método de escrita sem passar por lá quebra o
 * teste de propósito.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

/**
 * Uma linha do catálogo.
 *
 * ⚠️ `metaStatus` e `eligible` respondem perguntas DIFERENTES e nunca devem ser
 * fundidos na tela:
 *   - `metaStatus` — a Meta autorizou? Vem da Meta, 10 estados possíveis, e
 *     inclui os de desligamento pós-aprovação (PAUSED, DISABLED).
 *   - `eligible`   — nós sabemos usar isso numa mensagem por etapa? Regra
 *     NOSSA. Um template pode estar APPROVED e ser inelegível (posicionais).
 *
 * `null` em `metaStatus` é "nunca verificado", não "pendente" — a tela diz que
 * não sabe em vez de inventar.
 */
export interface TemplateCatalogRow {
  slug: string;
  name: string;
  /** Texto APROVADO na Meta. É o único texto que a tela mostra. */
  bodyTwilio: string | null;
  category: string | null;
  isActive: boolean;
  contentSid: string | null;
  metaStatus: string | null;
  /** Código do motivo da recusa (conjunto fechado de 8 da Meta). */
  metaReason: string | null;
  /** Explicação em prosa da Meta, quando ela manda. */
  metaDetail: string | null;
  metaCheckedAt: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
  placeholders: string[];
  /** Etapas do Kanban que disparam esta mensagem. Leitura — decide-se em outra tela. */
  usedInStages: string[];
}

export interface TemplateCatalog {
  templates: TemplateCatalogRow[];
}

const authService = new FirebaseAuthService();

function getBaseURL(): string {
  return (import.meta as { env?: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
}

async function request<T>(method: string, path: string): Promise<T> {
  const token = await authService.getIdToken();
  const response = await fetch(`${getBaseURL()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json.data as T;
}

export const AdminTemplateCatalogApiService = {
  async getTemplateCatalog(): Promise<TemplateCatalog> {
    return request<TemplateCatalog>('GET', '/api/admin/template-catalog');
  },
};
