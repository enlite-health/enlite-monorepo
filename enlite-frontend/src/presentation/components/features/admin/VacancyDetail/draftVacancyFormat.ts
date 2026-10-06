import { formatInstant } from '@presentation/utils/dateTimeFormat';

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

/** `Date` no locale do ator, só dia+mês ("23 de septiembre") — o mesmo formato do protótipo v3. */
export function formatDayMonth(iso: string | null | undefined, language: string | undefined): string | null {
  return formatInstant(iso, { day: 'numeric', month: 'long' }, localeForLanguage(language));
}

/** Data + hora, para "Última edición" (F27 — o dado liga de verdade na Fase 4). */
export function formatDateTime(iso: string | null | undefined, language: string | undefined): string | null {
  return formatInstant(
    iso,
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' },
    localeForLanguage(language),
  );
}
