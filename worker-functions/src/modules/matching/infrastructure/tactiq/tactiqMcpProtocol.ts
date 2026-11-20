/**
 * Partes PURAS do cliente MCP do Tactiq — separadas do transporte para serem testadas sem rede.
 * Nada aqui devolve ou registra conteúdo de reunião; só desfechos fechados.
 */
import {
  sanitizeAccessAction,
  sanitizeAccessTitle,
  TactiqTransientError,
  TactiqUnauthorizedError,
  type AccessVerdict,
  type TactiqMeetingItem,
} from '../../application/ports/TactiqPorts';

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
 * Veredito do `get_access_options` (F0.4: objeto `access` com `action`; `ready` = "You already have access"). DONO ÚNICO do
 * veredito de ping, 3 valores: `ready`; `denied(action, title?)` (action string ≠ `ready`, ambos sanitizados); `unrecognized`
 * (sem `action` string — formato nunca medido: cada ponto de uso decide a política, ver design D4).
 */
export function pingVerdict(result: unknown): AccessVerdict {
  const parsed = parseMcpJson(result) as { access?: { action?: unknown; title?: unknown }; action?: unknown; title?: unknown } | null;
  const action = parsed?.access?.action ?? parsed?.action;
  if (typeof action !== 'string') return { kind: 'unrecognized' };
  if (action === 'ready') return { kind: 'ready' };
  return { kind: 'denied', action: sanitizeAccessAction(action), title: sanitizeAccessTitle(parsed?.access?.title ?? parsed?.title) };
}

/** Erro do transporte/SDK → erro de domínio. 401/403 = vínculo caído; o resto é transitório. Nunca copia a mensagem. */
export function classifyMcpFailure(err: unknown): Error {
  if (err instanceof TactiqUnauthorizedError || err instanceof TactiqTransientError) return err;
  const e = err as { code?: unknown; name?: string };
  if (e?.name === 'UnauthorizedError' || e?.code === 401 || e?.code === 403) return new TactiqUnauthorizedError({ kind: 'mcp_transport' });
  return new TactiqTransientError(typeof e?.code === 'number' ? `mcp_http_${e.code}` : 'mcp_transport');
}

/**
 * Corpo do `search_meetings` → itens. Formato real do MCP (medido 27/10): `{ results: [{ id, title, createdAt,
 * durationSeconds, attendees, url, snippet? }] }`. `meetings` e array cru ficam por compat. Item sem id/title/createdAt cai.
 */
export function parseMeetingSearch(raw: unknown): TactiqMeetingItem[] {
  const envelope = raw as { results?: unknown; meetings?: unknown } | null;
  const items = ([envelope?.results, envelope?.meetings, raw].find(Array.isArray) as unknown[] | undefined) ?? [];
  return items.flatMap((m) => {
    const r = m as Record<string, unknown>;
    return typeof r?.id === 'string' && typeof r.title === 'string' && typeof r.createdAt === 'string'
      ? [{ id: r.id, title: r.title, createdAt: r.createdAt, durationSeconds: Number(r.durationSeconds) || 0 }]
      : [];
  });
}
