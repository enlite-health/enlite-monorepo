import { useTranslation } from 'react-i18next';

// Spec 014 US-D2 (decisão Gabriel 03/09, item 9): "Datos Financieros" e "Agendamientos"
// SAEM do tab bar — eram abas que só caíam no placeholder genérico "Próximamente" (nenhum card
// ligado). Uma aba só entra aqui quando tiver conteúdo real por trás.
// 05/09 (decisão do Gabriel): "Encuadre" também sai — era a MESMA tabela de serviços contratados
// duplicada (montada sem `onSaved`: editar por ali salvava e a tela não atualizava) + um card
// "Próximamente". O encuadre do paciente É o serviço contratado completo (endereço + horário,
// migration 330), e vive na aba "Servicio Contratado".
export type PatientTab =
  | 'clinicalData'
  | 'supportNetwork'
  | 'contractedService'
  | 'vacancies'
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
  'history',
];

const TAB_I18N_KEYS: Record<PatientTab, string> = {
  clinicalData: 'admin.patients.detail.tabs.clinicalData',
  supportNetwork: 'admin.patients.detail.tabs.supportNetwork',
  contractedService: 'admin.patients.detail.tabs.contractedService',
  vacancies: 'admin.patients.detail.tabs.vacancies',
  history: 'admin.patients.detail.tabs.history',
};

export function PatientProfileTabs({ activeTab, onTabChange }: PatientProfileTabsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-4 flex-wrap overflow-x-auto" data-testid="patient-profile-tabs">
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
