import { useTranslation } from 'react-i18next';

export type PatientTab =
  | 'clinicalData'
  | 'supportNetwork'
  | 'contractedService'
  | 'vacancies'
  | 'financialData'
  | 'matching'
  | 'appointments'
  | 'history';

interface PatientProfileTabsProps {
  activeTab: PatientTab;
  onTabChange: (tab: PatientTab) => void;
}

const TABS: PatientTab[] = [
  'clinicalData',
  'supportNetwork',
  'contractedService',
  'vacancies',
  'financialData',
  'matching',
  'appointments',
  'history',
];

const TAB_I18N_KEYS: Record<PatientTab, string> = {
  clinicalData: 'admin.patients.detail.tabs.clinicalData',
  supportNetwork: 'admin.patients.detail.tabs.supportNetwork',
  contractedService: 'admin.patients.detail.tabs.contractedService',
  vacancies: 'admin.patients.detail.tabs.vacancies',
  financialData: 'admin.patients.detail.tabs.financialData',
  matching: 'admin.patients.detail.tabs.matching',
  appointments: 'admin.patients.detail.tabs.appointments',
  history: 'admin.patients.detail.tabs.history',
};

export function PatientProfileTabs({ activeTab, onTabChange }: PatientProfileTabsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-4 flex-wrap overflow-x-auto">
      {TABS.map((tab) => (
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
