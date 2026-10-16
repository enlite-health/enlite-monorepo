import { useState, useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActionButton } from '@presentation/components/features/access';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useVacancyFunnelTable } from '@hooks/admin/useVacancyFunnelTable';
import { useInvitedPendingCandidates } from '@hooks/admin/useInvitedPendingCandidates';
import type { InviteTarget } from '../../VacancyMatch/inviteTypes';
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
import { DispatchConfirmModal } from './DispatchConfirmModal';
import { MatchVacancyModal } from '../../VacancyMatch/MatchVacancyModal';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';
import type { VacancyForMatch } from '../../VacancyMatch/matchModalHelpers';
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
  vacancy?: VacancyForMatch;
}

export function VacancyFunnelView({
  vacancyId,
  vacancy,
}: VacancyFunnelViewProps): JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<FunnelView>(() =>
    getPersistedView(vacancyId),
  );
  // Filtros só da Lista; não são salvos (voltam ao padrão ao recarregar).
  const [filters, setFilters] = useState<FunnelRowFilters>(DEFAULT_FUNNEL_ROW_FILTERS);
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false);
  const [dispatchSnapshot, setDispatchSnapshot] = useState<InviteTarget[]>([]);

  const enqueueInvites = useInviteProgressStore((s) => s.enqueue);
  const isSendingInvites = useInviteProgressStore((s) => s.isSending);

  const isListView = view === 'list';

  const { data, isLoading, error, refetch } = useVacancyFunnelTable(
    vacancyId,
    ALL_COLUMNS_TAB,
    isListView,
  );

  const {
    candidates: pendingCandidates,
    pendingCount,
    refetch: refetchPending,
  } = useInvitedPendingCandidates(vacancyId);

  function handleViewChange(newView: FunnelView) {
    setView(newView);
    persistView(vacancyId, newView);
  }

  function handleDispatchInvites() {
    if (pendingCount === 0) return;
    setDispatchSnapshot(pendingCandidates);
    setShowDispatchConfirm(true);
  }

  function handleConfirmDispatch() {
    setShowDispatchConfirm(false);
    // Envio em background — o painel flutuante mostra o progresso e o operador
    // segue trabalhando (não trava mais a tela).
    enqueueInvites(vacancyId, dispatchSnapshot);
  }

  // Ao concluir um lote de envio (isSending true → false), recarrega a lista de
  // pendentes pra refletir os que saíram (equivale ao antigo refetch-on-close).
  const wasSending = useRef(false);
  useEffect(() => {
    if (wasSending.current && !isSendingInvites) {
      refetchPending();
    }
    wasSending.current = isSendingInvites;
  }, [isSendingInvites, refetchPending]);

  const visibleRows = filterFunnelRows(data?.rows ?? [], filters);

  return (
    <div data-testid="vacancy-funnel-view" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      {/* Linha 1: toggle (esquerda) + ações (direita, nas duas visões — 054 item 6) */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <VacancyFunnelToggle view={view} onChange={handleViewChange} />
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* POST /vacancies/:id/match → match:execute · POST /messaging/whatsapp/vacancy-match →
              messaging:send (D286 fase 2 — a rota já decidia; sem a célula o botão SOME). */}
          <ActionButton
            resource="match"
            action="execute"
            variant="outline"
            size="md"
            onClick={() => setShowMatchModal(true)}
          >
            <Sparkles size={16} aria-hidden="true" />
            Hacer match
          </ActionButton>
          <ActionButton
            resource="messaging"
            action="send"
            variant="primary"
            size="md"
            onClick={handleDispatchInvites}
            disabled={pendingCount === 0}
          >
            {t('admin.vacancyDetail.funnelView.dispatchInvitesButtonCount', {
              count: pendingCount,
            })}
          </ActionButton>
        </div>
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
      {!isListView && <VacancyFunnelKanban vacancyId={vacancyId} />}

      {showMatchModal && (
        <MatchVacancyModal
          vacancyId={vacancyId}
          vacancy={vacancy}
          onClose={() => setShowMatchModal(false)}
        />
      )}

      {showDispatchConfirm && (
        <DispatchConfirmModal
          pendingCount={dispatchSnapshot.length}
          onConfirm={handleConfirmDispatch}
          onCancel={() => setShowDispatchConfirm(false)}
        />
      )}
    </div>
  );
}
