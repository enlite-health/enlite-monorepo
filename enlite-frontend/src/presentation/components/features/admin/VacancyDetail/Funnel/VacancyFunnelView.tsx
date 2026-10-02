import { useState, useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActionButton } from '@presentation/components/features/access';
import { useVacancyFunnelTable } from '@hooks/admin/useVacancyFunnelTable';
import { useInvitedPendingCandidates } from '@hooks/admin/useInvitedPendingCandidates';
import type { InviteTarget } from '../../VacancyMatch/inviteTypes';
import { VacancyFunnelToggle } from './VacancyFunnelToggle';
import type { FunnelView } from './VacancyFunnelToggle';
import { VacancyFunnelTabs } from './VacancyFunnelTabs';
import { VacancyFunnelTable } from './VacancyFunnelTable';
import { VacancyFunnelKanban } from './VacancyFunnelKanban';
import { DispatchConfirmModal } from './DispatchConfirmModal';
import { MatchVacancyModal } from '../../VacancyMatch/MatchVacancyModal';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';
import type { VacancyForMatch } from '../../VacancyMatch/matchModalHelpers';
import { FUNNEL_TABS, type FunnelTab } from './funnelTabsConfig';

const DEFAULT_TAB_KEY: FunnelTab['key'] = 'INVITED';

function getPersistedView(vacancyId: string): FunnelView {
  if (typeof window === 'undefined') return 'list';
  try {
    const stored = localStorage.getItem(`vacancy-funnel-view-${vacancyId}`);
    if (stored === 'kanban' || stored === 'list') return stored;
  } catch {
    // ignore storage errors
  }
  return 'list';
}

function persistView(vacancyId: string, view: FunnelView): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`vacancy-funnel-view-${vacancyId}`, view);
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
  const [activeTabKey, setActiveTabKey] =
    useState<FunnelTab['key']>(DEFAULT_TAB_KEY);
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false);
  const [dispatchSnapshot, setDispatchSnapshot] = useState<InviteTarget[]>([]);

  const enqueueInvites = useInviteProgressStore((s) => s.enqueue);
  const isSendingInvites = useInviteProgressStore((s) => s.isSending);

  const isListView = view === 'list';
  const activeTab = FUNNEL_TABS.find((tab) => tab.key === activeTabKey)!;

  const { data, isLoading } = useVacancyFunnelTable(
    vacancyId,
    activeTab,
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

  function handleTabChange(tab: FunnelTab) {
    setActiveTabKey(tab.key);
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

  // Reset tab when switching back to list view
  useEffect(() => {
    if (isListView) {
      setActiveTabKey(DEFAULT_TAB_KEY);
    }
  }, [isListView]);

  return (
    <div data-testid="vacancy-funnel-view" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      {/* Linha 1: toggle (esquerda) + ações (direita, só em modo lista) */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <VacancyFunnelToggle view={view} onChange={handleViewChange} />
        {isListView && (
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
        )}
      </div>

      {/* List view content */}
      {isListView && (
        <>
          <VacancyFunnelTabs
            activeTab={activeTabKey}
            counts={data?.counts}
            onTabChange={handleTabChange}
          />
          <div
            role="tabpanel"
            id={`funnel-panel-${activeTabKey}`}
            aria-labelledby={`funnel-tab-${activeTabKey}`}
          >
            <VacancyFunnelTable
              vacancyId={vacancyId}
              rows={data?.rows ?? []}
              isLoading={isLoading}
              activeTabLabel={t(activeTab.i18nKey)}
            />
          </div>
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
