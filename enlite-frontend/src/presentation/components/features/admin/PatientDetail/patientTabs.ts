// Spec 014 US-D2 (decisão Gabriel 03/09, item 9): "Datos Financieros" e "Agendamientos"
// SAEM do tab bar — eram abas que só caíam no placeholder genérico "Próximamente" (nenhum card
// ligado). Uma aba só entra aqui quando tiver conteúdo real por trás (todas as 6 abaixo têm).
// Fora do componente (react-refresh): a página e o registro de telas importam a lista.
export type PatientTab =
  | 'clinicalData'
  | 'supportNetwork'
  | 'contractedService'
  | 'vacancies'
  | 'matching'
  | 'history';


export const PATIENT_TABS: readonly PatientTab[] = [
  'clinicalData',
  'supportNetwork',
  'contractedService',
  'vacancies',
  'matching',
  'history',
];
