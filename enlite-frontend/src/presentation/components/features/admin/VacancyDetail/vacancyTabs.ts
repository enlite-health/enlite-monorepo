/** As abas do detalhe da vaga, na ordem. `enquadre` (spec 052) aparece só para quem tem `enquadre_event`/`enquadre_result` (containers em `screenRegistry`, `tabsVisibleFor`). */
export type VacancyTab = 'encuadres' | 'enquadre' | 'talentum' | 'links' | 'notes';

export const VACANCY_TABS: readonly VacancyTab[] = ['encuadres', 'enquadre', 'talentum', 'links', 'notes'];
