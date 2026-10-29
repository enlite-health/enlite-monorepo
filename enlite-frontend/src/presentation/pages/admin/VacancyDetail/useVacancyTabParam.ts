/**
 * useVacancyTabParam — a aba ativa do detalhe da vaga NA URL (`?tab=`), para que um link (a lista global de enquadres, spec 076)
 * abra direto a aba certa. `tab` ausente ou inválido = `'encuadres'` (o comportamento de antes). Trocar de aba usa `replace`
 * (não suja o histórico) e APAGA `event`: o evento pertence à aba Enquadre. Se a pessoa não tem a célula da aba, quem decide é
 * `shownTab` na página (FR-17): cai na 1ª visível.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VACANCY_TABS, type VacancyTab } from '@presentation/components/features/admin/VacancyDetail/vacancyTabs';

export function useVacancyTabParam(): [VacancyTab, (tab: VacancyTab) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: VacancyTab = VACANCY_TABS.find((t) => t === raw) ?? 'encuadres';

  const setTab = useCallback(
    (next: VacancyTab): void => {
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.set('tab', next);
          n.delete('event');
          return n;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [tab, setTab];
}
