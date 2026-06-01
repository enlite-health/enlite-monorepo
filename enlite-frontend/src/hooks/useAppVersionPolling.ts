import { useEffect, useState } from 'react';

const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 min

/**
 * Extrai o hash do bundle Vite do HTML servido em `/`.
 *
 * Vite emite `<script type="module" crossorigin src="/assets/index-<HASH>.js">` no
 * `<head>` do `index.html`. Cada build gera um hash diferente (cache-busting nativo).
 * Comparando o hash da página em memória com o do `index.html` atual no servidor,
 * detectamos que o operador está rodando uma versão antiga do bundle JS — algo que
 * acontece quando ele deixa a aba aberta por horas/dias após um deploy.
 *
 * Sem isso, qualquer fix de frontend só "entra em vigor" quando o operador
 * recarrega a página por conta própria. Operadores não-técnicos não fazem isso,
 * e o backend novo pode rejeitar requests do front antigo (caso vacancy
 * is_draft=false + payload completo → 403).
 */
function extractBundleHash(html: string): string | null {
  const match = html.match(/\/assets\/index-([a-zA-Z0-9_-]+)\.js/);
  return match ? match[1] : null;
}

function readCurrentBundleHash(): string | null {
  if (typeof document === 'undefined') return null;
  const scripts = Array.from(document.querySelectorAll('script[src*="/assets/index-"]'));
  for (const script of scripts) {
    const src = (script as HTMLScriptElement).src;
    const match = src.match(/\/assets\/index-([a-zA-Z0-9_-]+)\.js/);
    if (match) return match[1];
  }
  return null;
}

async function fetchLatestBundleHash(): Promise<string | null> {
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    return extractBundleHash(html);
  } catch {
    return null;
  }
}

interface UseAppVersionPollingOptions {
  intervalMs?: number;
}

/**
 * Retorna `true` quando o bundle JS em memória diverge do servido por `/`.
 *
 * Comportamento:
 *   - Faz o primeiro check 30s após o mount (evita custo durante o cold start).
 *   - Polla a cada `intervalMs` (default: 60s).
 *   - Para de pollar assim que detecta divergência (não há motivo para continuar).
 *   - Se algum check falhar (rede, parsing), apenas ignora — preserva idle.
 */
export function useAppVersionPolling(
  options: UseAppVersionPollingOptions = {},
): boolean {
  const { intervalMs = DEFAULT_POLL_INTERVAL_MS } = options;
  const [hasNewVersion, setHasNewVersion] = useState(false);

  useEffect(() => {
    if (hasNewVersion) return;

    const currentHash = readCurrentBundleHash();
    if (!currentHash) return; // dev mode (Vite não usa hash) ou DOM inesperado

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const check = async (): Promise<void> => {
      const latest = await fetchLatestBundleHash();
      if (cancelled) return;
      if (latest && latest !== currentHash) {
        setHasNewVersion(true);
        return;
      }
      timerId = setTimeout(check, intervalMs);
    };

    timerId = setTimeout(check, 30_000);

    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [hasNewVersion, intervalMs]);

  return hasNewVersion;
}
