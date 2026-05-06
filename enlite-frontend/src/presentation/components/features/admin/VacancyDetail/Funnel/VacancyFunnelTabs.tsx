import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FunnelBucket, FunnelTableCounts } from '@domain/entities/Funnel';
import { FUNNEL_TABS } from './funnelTabsConfig';

interface VacancyFunnelTabsProps {
  activeBucket: FunnelBucket;
  counts: FunnelTableCounts | undefined;
  onBucketChange: (bucket: FunnelBucket) => void;
}

const tabActive =
  'bg-primary text-white px-5 h-10 rounded-pill font-poppins font-semibold text-base ' +
  'shadow-[0px_4px_10px_rgba(0,0,0,0.4)] flex gap-2.5 items-center transition-colors';
const tabInactive =
  'text-gray-800 hover:text-primary px-5 h-10 rounded-pill font-poppins font-semibold text-base ' +
  'flex gap-2 items-center transition-colors';

export function VacancyFunnelTabs({
  activeBucket,
  counts,
  onBucketChange,
}: VacancyFunnelTabsProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      role="tablist"
      aria-label={t('admin.vacancyDetail.funnelTabs.ariaLabel')}
      className="flex gap-4 items-center flex-wrap mb-5"
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
            className={isActive ? tabActive : tabInactive}
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
  );
}
