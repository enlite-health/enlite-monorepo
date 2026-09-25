/**
 * draftVacancyFormat — as duas datas que a tela do rascunho mostra (fase 2). Extraído de
 * `DraftVacancyPage.tsx` (gate parcial 25/09, achado #10): puras, sem React, testáveis sozinhas.
 *
 * Locale derivado de `i18n.language` (achado #4 do gate parcial 25/09 — antes era `'es-AR'` fixo,
 * sobrevivendo até num viewer pt-BR). `i18n.language` só vale `'es'` ou `'pt-BR'`
 * (`infrastructure/i18n/config.ts`); `es-AR` é o formato REGIONAL que `'es'` vira — CLAUDE.md
 * do front pede es-AR como padrão de formatação de data, não `pt-BR` para o resto.
 */

/** `i18n.language` ('es' | 'pt-BR') → locale de `Intl`/`toLocaleDateString`. */
export function localeForLanguage(language: string | undefined): string {
  return language === 'pt-BR' ? 'pt-BR' : 'es-AR';
}

/**
 * `new Date('lixo')` não lança — vira um `Invalid Date` que `toLocaleDateString` formata como a
 * STRING literal "Invalid Date". `try/catch` sozinho não pega isso; o `isNaN(getTime())` pega.
 */
function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

/** `Date` no locale do ator, só dia+mês ("23 de septiembre") — o mesmo formato do protótipo v3. */
export function formatDayMonth(iso: string | null | undefined, language: string | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (!isValidDate(d)) return null;
    return d.toLocaleDateString(localeForLanguage(language), { day: 'numeric', month: 'long' });
  } catch {
    return null;
  }
}

/** Data + hora, para "Última edición" (F27 — o dado liga de verdade na Fase 4). */
export function formatDateTime(iso: string | null | undefined, language: string | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (!isValidDate(d)) return null;
    return d.toLocaleString(localeForLanguage(language), {
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
