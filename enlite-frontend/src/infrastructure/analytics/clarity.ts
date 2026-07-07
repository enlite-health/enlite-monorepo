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
