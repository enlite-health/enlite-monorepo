import { useTranslation } from 'react-i18next';

import { PATIENT_TABS, type PatientTab } from './patientTabs';
export type { PatientTab };

interface PatientProfileTabsProps {
  activeTab: PatientTab;
  onTabChange: (tab: PatientTab) => void;
  /**
   * D286: as abas que a pessoa PODE ver — uma aba existe se algum container dela for legível
   * (`containersVisibleFor`). Sem a prop, todas (o comportamento de antes, e o do engine OFF).
   */
  visibleTabs?: readonly PatientTab[];
}

const TAB_I18N_KEYS: Record<PatientTab, string> = {
  clinicalData: 'admin.patients.detail.tabs.clinicalData',
  supportNetwork: 'admin.patients.detail.tabs.supportNetwork',
  contractedService: 'admin.patients.detail.tabs.contractedService',
  vacancies: 'admin.patients.detail.tabs.vacancies',
  matching: 'admin.patients.detail.tabs.matching',
  history: 'admin.patients.detail.tabs.history',
};

export function PatientProfileTabs({ activeTab, onTabChange, visibleTabs }: PatientProfileTabsProps) {
  const { t } = useTranslation();
  const tabs = visibleTabs ? PATIENT_TABS.filter((tab) => visibleTabs.includes(tab)) : PATIENT_TABS;

  return (
    <div className="flex items-center gap-4 flex-wrap overflow-x-auto" data-testid="patient-profile-tabs">
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
