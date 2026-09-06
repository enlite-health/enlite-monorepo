import { useTranslation } from 'react-i18next';

import { WORKER_TABS, type WorkerTab } from './workerTabs';

export type { WorkerTab } from './workerTabs';

interface WorkerProfileTabsProps {
  activeTab: WorkerTab;
  onTabChange: (tab: WorkerTab) => void;
  /** D286: só as abas com algum container legível (ou sem container). Sem a prop, todas. */
  visibleTabs?: readonly WorkerTab[];
}


const TAB_I18N_KEYS: Record<WorkerTab, string> = {
  encuadres: 'admin.workerDetail.tabs.encuadres',
  documents: 'admin.workerDetail.tabs.documents',
  availability: 'admin.workerDetail.tabs.availability',
  financial: 'admin.workerDetail.tabs.financial',
  history: 'admin.workerDetail.tabs.history',
};

export function WorkerProfileTabs({ activeTab, onTabChange, visibleTabs }: WorkerProfileTabsProps) {
  const { t } = useTranslation();
  const tabs = visibleTabs ? WORKER_TABS.filter((tab) => visibleTabs.includes(tab)) : WORKER_TABS;

  return (
    <div className="flex items-center gap-8 flex-wrap">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className={`
            px-5 py-2 rounded-card font-lexend text-base font-medium transition-all whitespace-nowrap
            ${
              activeTab === tab
                ? 'bg-primary text-white shadow-[0px_4px_20px_0px_rgba(0,0,0,0.4)]'
                : 'text-gray-800 hover:text-primary'
            }
          `}
        >
          {t(TAB_I18N_KEYS[tab])}
        </button>
      ))}
    </div>
  );
}
