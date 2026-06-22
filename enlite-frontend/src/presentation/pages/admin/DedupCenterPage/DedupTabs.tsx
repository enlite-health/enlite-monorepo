/**
 * DedupTabs
 *
 * Rounded-pill tab bar for the Deduplication Center.
 * Pattern copied from VacancyDetailTabs.tsx:18-25 — no Tabs atom exists.
 * The "Importados" tab (Onda 4) is declared but rendered as disabled.
 */

import { useTranslation } from 'react-i18next';

export type DedupTab = 'queue' | 'imported';

interface DedupTabsProps {
  activeTab: DedupTab;
  onTabChange: (tab: DedupTab) => void;
}

const TABS: DedupTab[] = ['queue', 'imported'];

const TAB_I18N_KEYS: Record<DedupTab, string> = {
  queue: 'admin.dedup.tabs.queue',
  imported: 'admin.dedup.tabs.imported',
};

const tabActive =
  'bg-primary text-white px-5 h-10 rounded-pill ' +
  'font-poppins font-semibold text-base whitespace-nowrap ' +
  'shadow-[0px_4px_20px_0px_rgba(0,0,0,0.4)] transition-colors flex items-center';

const tabInactive =
  'text-gray-800 hover:text-primary px-5 h-10 rounded-pill ' +
  'font-poppins font-semibold text-base whitespace-nowrap ' +
  'transition-colors flex items-center';

const tabDisabled =
  'text-gray-400 cursor-not-allowed px-5 h-10 rounded-pill ' +
  'font-poppins font-semibold text-base whitespace-nowrap ' +
  'flex items-center';

/** Onda 4 tabs that are declared but not yet available. */
const DISABLED_TABS: DedupTab[] = ['imported'];

export function DedupTabs({ activeTab, onTabChange }: DedupTabsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-8 flex-wrap">
      {TABS.map((tab) => {
        const isDisabled = DISABLED_TABS.includes(tab);

        if (isDisabled) {
          return (
            <span
              key={tab}
              className={tabDisabled}
              title={t('admin.dedup.tabs.comingSoon', 'Próximamente')}
              aria-disabled="true"
            >
              {t(TAB_I18N_KEYS[tab])}
            </span>
          );
        }

        return (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={activeTab === tab ? tabActive : tabInactive}
          >
            {t(TAB_I18N_KEYS[tab])}
          </button>
        );
      })}
    </div>
  );
}
