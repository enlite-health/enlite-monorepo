// Spec 014 US-D2 (decisão Gabriel 03/09, item 9): "Datos Financieros" e "Agendamientos"
// SAEM do tab bar — eram abas que só caíam no placeholder genérico "Próximamente" (nenhum card
// ligado). Uma aba só entra aqui quando tiver conteúdo real por trás (todas as 5 abaixo têm).
// 05/09 (decisão do Gabriel, veio da main no sync de 08/09): "Encuadre/Matching" também sai — era a MESMA
// tabela de serviços contratados duplicada + um card "Próximamente". O encuadre do paciente É o serviço
// contratado completo (endereço + horário, migration 330), e vive na aba "Servicio Contratado".
// Fora do componente (react-refresh): a página e o registro de telas importam a lista.
export type PatientTab =
  | 'clinicalData'
  | 'supportNetwork'
  | 'contractedService'
  | 'vacancies'
  | 'history';


export const PATIENT_TABS: readonly PatientTab[] = [
  'clinicalData',
  'supportNetwork',
  'contractedService',
  'vacancies',
  'history',
];
