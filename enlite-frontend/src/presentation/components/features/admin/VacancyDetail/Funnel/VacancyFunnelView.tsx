import { useState, useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import type { FunnelBucket } from '@domain/entities/Funnel';
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
import { InviteProgressModal } from '../../VacancyMatch/InviteProgressModal';
import type { VacancyForMatch } from '../../VacancyMatch/matchModalHelpers';

const DEFAULT_BUCKET: FunnelBucket = 'INVITED';

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
  const [activeBucket, setActiveBucket] =
    useState<FunnelBucket>(DEFAULT_BUCKET);
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false);
  const [showInviteProgress, setShowInviteProgress] = useState(false);
  const [dispatchSnapshot, setDispatchSnapshot] = useState<InviteTarget[]>([]);

  const isListView = view === 'list';

  const { data, isLoading } = useVacancyFunnelTable(
    vacancyId,
    activeBucket,
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

  function handleBucketChange(bucket: FunnelBucket) {
    setActiveBucket(bucket);
  }

  function handleDispatchInvites() {
    if (pendingCount === 0) return;
    setDispatchSnapshot(pendingCandidates);
    setShowDispatchConfirm(true);
  }

  function handleConfirmDispatch() {
    setShowDispatchConfirm(false);
    setShowInviteProgress(true);
  }

  function handleCloseProgress() {
    setShowInviteProgress(false);
    refetchPending();
  }

  // Reset bucket when switching back to list view
  useEffect(() => {
    if (isListView) {
      setActiveBucket(DEFAULT_BUCKET);
    }
  }, [isListView]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      {/* Linha 1: toggle (esquerda) + ações (direita, só em modo lista) */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <VacancyFunnelToggle view={view} onChange={handleViewChange} />
        {isListView && (
          <div className="flex items-center gap-3 flex-shrink-0">
            <Button
              variant="outline"
              size="md"
              onClick={() => setShowMatchModal(true)}
            >
              <Sparkles size={16} aria-hidden="true" />
              Hacer match
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleDispatchInvites}
              disabled={pendingCount === 0}
            >
              {t('admin.vacancyDetail.funnelView.dispatchInvitesButtonCount', {
                count: pendingCount,
              })}
            </Button>
          </div>
        )}
      </div>

      {/* List view content */}
      {isListView && (
        <>
          <VacancyFunnelTabs
            activeBucket={activeBucket}
            counts={data?.counts}
            onBucketChange={handleBucketChange}
          />
          <div
            role="tabpanel"
            id={`funnel-panel-${activeBucket}`}
            aria-labelledby={`funnel-tab-${activeBucket}`}
          >
            <VacancyFunnelTable
              rows={data?.rows ?? []}
              isLoading={isLoading}
              activeBucket={activeBucket}
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

      {showInviteProgress && (
        <InviteProgressModal
          candidates={dispatchSnapshot}
          vacancyId={vacancyId}
          onClose={handleCloseProgress}
          onMessaged={(_workerId: string, _messagedAt: string) => {
            // no-op: VacancyFunnelView refetches on modal close
          }}
        />
      )}
    </div>
  );
}
