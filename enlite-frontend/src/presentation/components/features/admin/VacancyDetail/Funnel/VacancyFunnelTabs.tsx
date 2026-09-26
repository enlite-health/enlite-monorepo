import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FunnelTableCounts } from '@domain/entities/Funnel';
import { FUNNEL_TABS, columnCount, type FunnelTab } from './funnelTabsConfig';

interface VacancyFunnelTabsProps {
  activeTab: FunnelTab['key'];
  counts: FunnelTableCounts | undefined;
  onTabChange: (tab: FunnelTab) => void;
}

const tabActive =
  'bg-primary text-white px-5 h-10 rounded-pill font-poppins font-semibold text-base ' +
  'shadow-tab flex gap-2.5 items-center transition-colors';
const tabInactive =
  'text-gray-800 hover:text-primary px-5 h-10 rounded-pill font-poppins font-semibold text-base ' +
  'flex gap-2 items-center transition-colors';

export function VacancyFunnelTabs({
  activeTab,
  counts,
  onTabChange,
}: VacancyFunnelTabsProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      role="tablist"
      aria-label={t('admin.vacancyDetail.funnelTabs.ariaLabel')}
      className="flex gap-4 items-center flex-wrap mb-5"
    >
      {FUNNEL_TABS.map((tab) => {
        const { key, i18nKey } = tab;
        const isActive = activeTab === key;
        const count =
          tab.kind === 'column'
            ? columnCount(tab.column, counts?.columns)
            : (counts?.[tab.bucket] ?? 0);
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`funnel-panel-${key}`}
            id={`funnel-tab-${key}`}
            onClick={() => onTabChange(tab)}
            className={isActive ? tabActive : tabInactive}
          >
            <span>
              {t(i18nKey)} (<span data-testid={`funnel-tab-${key}-count`}>{count}</span>)
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
