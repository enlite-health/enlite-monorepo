/**
 * dateLocale — o mapa de idioma → locale de data, num lugar só.
 *
 * Ele estava copiado em TRÊS arquivos (`WorkersTable`, `ClinicalLongText`,
 * `PatientsTable`), e é exatamente o tipo de constante que derrapa em silêncio:
 * no dia em que entrar um terceiro idioma, quem esquecer um dos três não vê
 * erro nenhum — a tela só mostra a data no formato errado.
 *
 * ⚠️ O que NÃO mora aqui, de propósito: o fallback de valor ausente. As três
 * chamadoras querem coisas diferentes e as três estão certas — a `WorkersTable`
 * devolve `'—'` porque preenche uma COLUNA própria; a `PatientsTable` devolve
 * `null` porque a data é uma linha extra da célula e um traço solto ali vira
 * sujeira; a `ClinicalLongText` devolve o ISO cru para não esconder um dado
 * corrompido. Unificar isso seria juntar o que só PARECE igual.
 */

/** Locales suportados pelo painel. `i18n.language` é 'es' ou 'pt-BR' (ver i18n/config.ts). */
export type DateLocale = 'es-AR' | 'pt-BR';

/** Idioma da UI → locale de formatação de data. Qualquer coisa fora de 'es' cai em pt-BR. */
export function resolveDateLocale(language: string): DateLocale {
  return language === 'es' ? 'es-AR' : 'pt-BR';
}

/** dd/mm/aaaa — o formato curto usado nas tabelas do admin. */
export const SHORT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
};
