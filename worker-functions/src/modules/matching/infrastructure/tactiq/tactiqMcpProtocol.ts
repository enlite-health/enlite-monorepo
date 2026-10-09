/**
 * Partes PURAS do cliente MCP do Tactiq — separadas do transporte para serem testadas sem rede.
 * Nada aqui devolve ou registra conteúdo de reunião; só desfechos fechados.
 */
import { TactiqTransientError, TactiqUnauthorizedError } from '../../application/ports/TactiqPorts';

/** O texto JSON do primeiro bloco `text` de um resultado de tool (formato do MCP). `null` se não houver/não parsear. */
export function parseMcpJson(result: unknown): unknown {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  const block = content.find((c) => (c as { type?: string })?.type === 'text') as { text?: unknown } | undefined;
  if (!block || typeof block.text !== 'string') return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return null;
  }
}

/**
 * Veredito do `get_access_options` (F0.4: objeto `access` com `action`; `ready` = "You already have access").
 * `action` presente e diferente de `ready` → o token não dá acesso (`denied`). Formato não reconhecido → `ok`: a
 * chamada AUTENTICADA voltou sem erro, e a 401/403 já teria virado `TactiqUnauthorizedError` no transporte.
 */
export function pingVerdict(result: unknown): 'ok' | 'denied' {
  const parsed = parseMcpJson(result) as { access?: { action?: unknown }; action?: unknown } | null;
  const action = parsed?.access?.action ?? parsed?.action;
  if (typeof action === 'string' && action !== 'ready') return 'denied';
  return 'ok';
}

/** Erro do transporte/SDK → erro de domínio. 401/403 = vínculo caído; o resto é transitório. Nunca copia a mensagem. */
export function classifyMcpFailure(err: unknown): Error {
  if (err instanceof TactiqUnauthorizedError || err instanceof TactiqTransientError) return err;
  const e = err as { code?: unknown; name?: string };
  if (e?.name === 'UnauthorizedError' || e?.code === 401 || e?.code === 403) return new TactiqUnauthorizedError();
  return new TactiqTransientError(typeof e?.code === 'number' ? `mcp_http_${e.code}` : 'mcp_transport');
}
