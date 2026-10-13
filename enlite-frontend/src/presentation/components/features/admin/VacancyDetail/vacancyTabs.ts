/** As abas do detalhe da vaga, na ordem. `enquadre` (spec 052) ainda não está no `screenRegistry`: aba sem container existe sempre (`tabsVisibleFor`). */
export type VacancyTab = 'encuadres' | 'enquadre' | 'talentum' | 'links' | 'notes';

export const VACANCY_TABS: readonly VacancyTab[] = ['encuadres', 'enquadre', 'talentum', 'links', 'notes'];
