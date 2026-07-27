import { ENV } from '../config/env';

type ClarityFn = { (...args: unknown[]): void; q?: unknown[][] };

declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

const CLARITY_TAG_BASE_URL = 'https://www.clarity.ms/tag/';

/**
 * Injeta o snippet do Microsoft Clarity (mapeamento de tela/heatmaps).
 * No-op quando VITE_CLARITY_PROJECT_ID não está definido — dev, stage e E2E
 * não devem poluir os dados de sessão de produção.
 */
export function initClarity(projectId: string = ENV.CLARITY_PROJECT_ID): void {
  if (!projectId) return;
  if (document.querySelector(`script[src^="${CLARITY_TAG_BASE_URL}"]`)) return;

  const stub: ClarityFn = (...args: unknown[]) => {
    (stub.q = stub.q ?? []).push(args);
  };
  window.clarity = window.clarity ?? stub;

  const script = document.createElement('script');
  script.async = true;
  script.src = `${CLARITY_TAG_BASE_URL}${projectId}`;

  const firstScript = document.getElementsByTagName('script')[0];
  if (firstScript?.parentNode) {
    firstScript.parentNode.insertBefore(script, firstScript);
  } else {
    document.head.appendChild(script);
  }
}

/**
 * Amarra a sessão atual do Clarity a um id estável e, opcionalmente, a tags
 * customizadas filtráveis no dashboard — para achar a sessão de um usuário
 * específico ao dar suporte (hoje as sessões são anônimas e não-buscáveis).
 *
 * ⚠️ PRIVACIDADE (Ley 25.326 / regra "nunca logar PII"): passe SOMENTE
 * identificadores OPACOS — Firebase uid, workerId (UUID), status. NUNCA
 * email, nome, telefone, endereço ou qualquer dado pessoal/clínico.
 *
 * No-op seguro quando o Clarity não foi inicializado (project id vazio):
 * `window.clarity` é undefined e a função retorna sem efeito. Antes do script
 * real carregar, o stub criado por initClarity enfileira as chamadas.
 */
export function identifyClarity(
  userId: string,
  tags: Record<string, string> = {},
): void {
  if (!userId) return;
  const clarity = window.clarity;
  if (typeof clarity !== 'function') return;

  clarity('identify', userId);
  for (const [key, value] of Object.entries(tags)) {
    if (value) clarity('set', key, value);
  }
}
