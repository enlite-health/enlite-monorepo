import { useTranslation } from 'react-i18next';

import { VACANCY_TABS, type VacancyTab } from './vacancyTabs';

export type { VacancyTab } from './vacancyTabs';

interface VacancyDetailTabsProps {
  activeTab: VacancyTab;
  onTabChange: (tab: VacancyTab) => void;
  /** D286: só as abas com algum container legível. Sem a prop, todas. */
  visibleTabs?: readonly VacancyTab[];
}


const TAB_I18N_KEYS: Record<VacancyTab, string> = {
  encuadres: 'admin.vacancyDetail.tabs.encuadres',
  talentum: 'admin.vacancyDetail.tabs.talentum',
  links: 'admin.vacancyDetail.tabs.links',
  notes: 'admin.vacancyDetail.tabs.notes',
};

const tabActive =
  'bg-primary text-white px-5 h-10 rounded-pill ' +
  'font-poppins font-semibold text-base whitespace-nowrap ' +
  'shadow-tab-active transition-colors flex items-center';
const tabInactive =
  'text-gray-800 hover:text-primary px-5 h-10 rounded-pill ' +
  'font-poppins font-semibold text-base whitespace-nowrap ' +
  'transition-colors flex items-center';

export function VacancyDetailTabs({ activeTab, onTabChange, visibleTabs }: VacancyDetailTabsProps) {
  const { t } = useTranslation();
  const tabs = visibleTabs ? VACANCY_TABS.filter((tab) => visibleTabs.includes(tab)) : VACANCY_TABS;

  return (
    <div className="flex items-center gap-8 flex-wrap">
      {tabs.map((tab) => (
        <button
          key={tab}
          data-testid={`vacancy-tab-${tab}`}
          onClick={() => onTabChange(tab)}
          className={activeTab === tab ? tabActive : tabInactive}
        >
          {t(TAB_I18N_KEYS[tab])}
        </button>
      ))}
    </div>
  );
}
