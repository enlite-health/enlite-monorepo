import { useTranslation } from 'react-i18next';

export type VacancyTab = 'encuadres' | 'talentum' | 'links';

interface VacancyDetailTabsProps {
  activeTab: VacancyTab;
  onTabChange: (tab: VacancyTab) => void;
}

const TABS: VacancyTab[] = ['encuadres', 'talentum', 'links'];

const TAB_I18N_KEYS: Record<VacancyTab, string> = {
  encuadres: 'admin.vacancyDetail.tabs.encuadres',
  talentum: 'admin.vacancyDetail.tabs.talentum',
  links: 'admin.vacancyDetail.tabs.links',
};

const tabActive =
  'bg-primary text-white px-5 h-10 rounded-pill ' +
  'font-poppins font-semibold text-base whitespace-nowrap ' +
  'shadow-[0px_4px_20px_0px_rgba(0,0,0,0.4)] transition-colors flex items-center';
const tabInactive =
  'text-gray-800 hover:text-primary px-5 h-10 rounded-pill ' +
  'font-poppins font-semibold text-base whitespace-nowrap ' +
  'transition-colors flex items-center';

export function VacancyDetailTabs({ activeTab, onTabChange }: VacancyDetailTabsProps) {
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
