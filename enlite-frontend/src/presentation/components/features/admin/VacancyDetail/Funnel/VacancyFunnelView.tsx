import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useVacancyFunnelTable } from '@hooks/admin/useVacancyFunnelTable';
import { VacancyFunnelToggle } from './VacancyFunnelToggle';
import type { FunnelView } from './VacancyFunnelToggle';
import { VacancyFunnelFilters } from './VacancyFunnelFilters';
import {
  DEFAULT_FUNNEL_ROW_FILTERS,
  filterFunnelRows,
  hasActiveFilters,
  type FunnelRowFilters,
} from './funnelRowFilter';
import { VacancyFunnelTable } from './VacancyFunnelTable';
import { VacancyFunnelKanban } from './VacancyFunnelKanban';
import { InviteEntryButton } from './InviteEntryButton';
import { VACANCY_FUNNEL_COLUMNS } from './funnelTabsConfig';
import type { FunnelTableTab } from '@hooks/admin/useVacancyFunnelTable';

// A Lista pede TODAS as colunas do Kanban de uma vez (`?columns=` com as sources das 8 colunas,
// incluindo IN_PROGRESS): mostra os mesmos prestadores do Kanban, tentativas bloqueadas inclusive.
const ALL_COLUMNS_TAB: FunnelTableTab = {
  key: 'ALL_COLUMNS',
  kind: 'column',
  column: { sources: VACANCY_FUNNEL_COLUMNS.flatMap((c) => c.sources) },
};

// 054: chave v2 — a antiga (`vacancy-funnel-view-${id}`) não é lida nem apagada, então todo mundo
// recomeça no Kanban (padrão) e depois vale a escolha de cada um.
const viewStorageKey = (vacancyId: string): string =>
  `vacancy-funnel-view-v2-${vacancyId}`;

function getPersistedView(vacancyId: string): FunnelView {
  if (typeof window === 'undefined') return 'kanban';
  try {
    const stored = localStorage.getItem(viewStorageKey(vacancyId));
    if (stored === 'kanban' || stored === 'list') return stored;
  } catch {
    // ignore storage errors
  }
  return 'kanban';
}

function persistView(vacancyId: string, view: FunnelView): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(viewStorageKey(vacancyId), view);
  } catch {
    // ignore storage errors
  }
}

interface VacancyFunnelViewProps {
  vacancyId: string;
  /** Spec 084 (P4/R6): vaga dada de baja — o funil abre só para consulta (sem Match, sem envio, sem arrasto). */
  readOnly?: boolean;
}

export function VacancyFunnelView({
  vacancyId,
  readOnly = false,
}: VacancyFunnelViewProps): JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<FunnelView>(() =>
    getPersistedView(vacancyId),
  );
  // Filtros só da Lista; não são salvos (voltam ao padrão ao recarregar).
  const [filters, setFilters] = useState<FunnelRowFilters>(DEFAULT_FUNNEL_ROW_FILTERS);

  const isListView = view === 'list';

  const { data, isLoading, error, refetch } = useVacancyFunnelTable(
    vacancyId,
    ALL_COLUMNS_TAB,
    isListView,
  );

  function handleViewChange(newView: FunnelView) {
    setView(newView);
    persistView(vacancyId, newView);
  }

  const visibleRows = filterFunnelRows(data?.rows ?? [], filters);

  return (
    <div data-testid="vacancy-funnel-view" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      {/* Linha 1: toggle (esquerda) + ações (direita, nas duas visões — 054 item 6) */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <VacancyFunnelToggle view={view} onChange={handleViewChange} />
        {!readOnly && <InviteEntryButton vacancyId={vacancyId} />}
      </div>

      {/* List view content */}
      {isListView && (
        <>
          <VacancyFunnelFilters filters={filters} onChange={setFilters} />
          {/* Falha de carga: banner de erro (padrão do Kanban, VacancyFunnelKanban) com reintentar.
              Sem dados ainda, o erro substitui a tabela — senão o 4xx/5xx aparece como "Sin candidatos".
              Com dados já carregados, mantém a tabela e mostra o aviso (poll em silêncio não gera erro). */}
          {error && (
            <div
              role="alert"
              data-testid="funnel-table-error"
              className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center justify-between gap-3"
            >
              <Text size="sm" color="inherit" className="text-red-700">
                {t('admin.vacancyDetail.funnelTable.loadError')}
              </Text>
              <Button
                variant="outline"
                size="sm"
                data-testid="funnel-table-retry"
                onClick={() => refetch()}
                disabled={isLoading}
              >
                {t('admin.vacancyDetail.funnelTable.retry')}
              </Button>
            </div>
          )}
          {!(error && !data) && (
            <VacancyFunnelTable
              vacancyId={vacancyId}
              rows={visibleRows}
              isLoading={isLoading}
              isFiltered={hasActiveFilters(filters)}
            />
          )}
          {isLoading && data && (
            <div className="flex items-center justify-end">
              <span className="text-xs text-gray-800 font-lexend flex items-center gap-1">
                <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary inline-block" />
                {t('common.loading')}
              </span>
            </div>
          )}
        </>
      )}

      {/* Kanban view content */}
      {!isListView && <VacancyFunnelKanban vacancyId={vacancyId} readOnly={readOnly} />}
    </div>
  );
}
