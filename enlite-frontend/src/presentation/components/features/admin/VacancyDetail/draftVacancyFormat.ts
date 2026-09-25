/**
 * draftVacancyFormat — as duas datas que a tela do rascunho mostra (fase 2). Extraído de
 * `DraftVacancyPage.tsx` (gate parcial 25/09, achado #10): puras, sem React, testáveis sozinhas.
 */

/**
 * `new Date('lixo')` não lança — vira um `Invalid Date` que `toLocaleDateString` formata como a
 * STRING literal "Invalid Date". `try/catch` sozinho não pega isso; o `isNaN(getTime())` pega.
 */
function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

/** `Date` no fuso `es-AR`, só dia+mês ("23 de septiembre") — o mesmo formato do protótipo v3. */
export function formatDayMonth(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (!isValidDate(d)) return null;
    return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
  } catch {
    return null;
  }
}

/** Data + hora, para "Última edición" (F27 — o dado liga de verdade na Fase 4). */
export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (!isValidDate(d)) return null;
    return d.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}
