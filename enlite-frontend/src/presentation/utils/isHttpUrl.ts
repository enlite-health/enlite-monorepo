/**
 * `true` só para uma URL absoluta http(s) bem formada. Rejeita o que parece URL mas não é:
 * string vazia, JSON cru (`{"id": ..., "url": ...}` — o defeito do "Ver Detalles" da home),
 * `javascript:`, caminho relativo.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
