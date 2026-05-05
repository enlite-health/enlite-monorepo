import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FunnelBucket, FunnelTableCounts } from '@domain/entities/Funnel';
import { FUNNEL_TABS } from './funnelTabsConfig';

interface VacancyFunnelTabsProps {
  activeBucket: FunnelBucket;
  counts: FunnelTableCounts | undefined;
  onBucketChange: (bucket: FunnelBucket) => void;
  onDispatchInvites: () => void;
}

export function VacancyFunnelTabs({
  activeBucket,
  counts,
  onBucketChange,
  onDispatchInvites,
}: VacancyFunnelTabsProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="flex justify-between items-center w-full mb-5 flex-wrap gap-3">
      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('admin.vacancyDetail.funnelTabs.ariaLabel')}
        className="flex gap-8 items-center flex-wrap"
      >
        {FUNNEL_TABS.map(({ key, i18nKey }) => {
          const isActive = activeBucket === key;
          const count = counts ? counts[key as keyof FunnelTableCounts] : 0;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`funnel-panel-${key}`}
              id={`funnel-tab-${key}`}
              onClick={() => onBucketChange(key)}
              className={
                isActive
                  ? 'bg-primary text-white px-5 py-2 rounded-[20px] font-lexend font-medium text-base shadow-[0px_4px_10px_rgba(0,0,0,0.4)] flex gap-2.5 items-center transition-colors'
                  : 'text-gray-800 hover:text-primary font-lexend font-medium text-base flex gap-2 items-center transition-colors'
              }
            >
              <span>
                {t(i18nKey)} ({count})
              </span>
              <Info
                size={17}
                aria-hidden="true"
                className={isActive ? 'text-white' : 'text-gray-800'}
              />
            </button>
          );
        })}
      </div>

      {/* Dispatch invites button */}
      <button
        type="button"
        onClick={onDispatchInvites}
        className="bg-primary text-white font-poppins font-semibold text-base h-10 w-60 rounded-pill flex items-center justify-center flex-shrink-0"
      >
        {t('admin.vacancyDetail.funnelView.dispatchInvitesButton')}
      </button>
    </div>
  );
}
