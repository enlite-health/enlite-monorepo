import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { FunnelBucket } from '@domain/entities/Funnel';
import { useVacancyFunnelTable } from '@hooks/admin/useVacancyFunnelTable';
import { VacancyFunnelToggle } from './VacancyFunnelToggle';
import type { FunnelView } from './VacancyFunnelToggle';
import { VacancyFunnelTabs } from './VacancyFunnelTabs';
import { VacancyFunnelTable } from './VacancyFunnelTable';
import { VacancyFunnelKanban } from './VacancyFunnelKanban';

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
}

export function VacancyFunnelView({
  vacancyId,
}: VacancyFunnelViewProps): JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<FunnelView>(() =>
    getPersistedView(vacancyId),
  );
  const [activeBucket, setActiveBucket] =
    useState<FunnelBucket>(DEFAULT_BUCKET);

  const isListView = view === 'list';

  const { data, isLoading } = useVacancyFunnelTable(
    vacancyId,
    activeBucket,
    isListView,
  );

  function handleViewChange(newView: FunnelView) {
    setView(newView);
    persistView(vacancyId, newView);
  }

  function handleBucketChange(bucket: FunnelBucket) {
    setActiveBucket(bucket);
  }

  function handleDispatchInvites() {
    // TODO TD-XXX: Implement dispatch invites flow — see docs/FOLLOWUPS.md
    console.log('[FunnelView] dispatch invites clicked');
  }

  // Reset bucket when switching back to list view
  useEffect(() => {
    if (isListView) {
      setActiveBucket(DEFAULT_BUCKET);
    }
  }, [isListView]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      {/* Toggle Lista | Kanban */}
      <div className="flex items-center">
        <VacancyFunnelToggle view={view} onChange={handleViewChange} />
      </div>

      {/* List view content */}
      {isListView && (
        <>
          <VacancyFunnelTabs
            activeBucket={activeBucket}
            counts={data?.counts}
            onBucketChange={handleBucketChange}
            onDispatchInvites={handleDispatchInvites}
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
    </div>
  );
}
