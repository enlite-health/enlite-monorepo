/**
 * DedupTabs
 *
 * Rounded-pill tab bar for the Deduplication Center.
 * Pattern copied from VacancyDetailTabs.tsx:18-25 — no Tabs atom exists.
 *
 * Tabs:
 *   - queue    → Fila (Onda 2)
 *   - history  → Historial (Onda 3)
 *   - imported → Importados (Onda 4b, active)
 *
 * All three tabs are now active (Onda 4b). The disabled-span branch was
 * removed — no tabs are disabled, keeping the render path simple.
 */

import { useTranslation } from 'react-i18next';

export type DedupTab = 'queue' | 'history' | 'imported';

interface DedupTabsProps {
  activeTab: DedupTab;
  onTabChange: (tab: DedupTab) => void;
}

const TABS: DedupTab[] = ['queue', 'history', 'imported'];

const TAB_I18N_KEYS: Record<DedupTab, string> = {
  queue: 'admin.dedup.tabs.queue',
  history: 'admin.dedup.tabs.history',
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

export function DedupTabs({ activeTab, onTabChange }: DedupTabsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-8 flex-wrap">
      {TABS.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className={activeTab === tab ? tabActive : tabInactive}
        >
          {t(TAB_I18N_KEYS[tab])}
        </button>
      ))}
    </div>
  );
}
