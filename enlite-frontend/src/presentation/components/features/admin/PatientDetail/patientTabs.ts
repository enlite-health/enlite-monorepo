// Spec 014 US-D2 (decisão Gabriel 03/09, item 9): "Datos Financieros" e "Agendamientos"
// SAEM do tab bar — eram abas que só caíam no placeholder genérico "Próximamente" (nenhum card
// ligado). Uma aba só entra aqui quando tiver conteúdo real por trás (todas as 6 abaixo têm).
// 05/09 (decisão do Gabriel, veio da main no sync de 08/09): a antiga aba "Encuadre/Matching" saiu
// — era a MESMA tabela de serviços contratados duplicada + um card "Próximamente". Naquele momento
// o encuadre do paciente ficou sendo só o serviço contratado completo (endereço + horário,
// migration 330), na aba "Servicio Contratado".
// 29/09 (decisão do Gabriel, task "aba Enquadre conforme Figma"): 'encuadre' VOLTA como aba
// própria — desta vez com conteúdo real (o quadro C, `ServiceTeamSection`/`ServiceTeamBoard`, que
// SAI da aba "Servicio Contratado" e passa a viver só aqui). Não é a mesma aba antiga: aquela
// duplicava a tabela de serviços e não tinha quadro nenhum atrás.
// D442 (28/09): 'Itinerario' entra tendo conteúdo real (D431): a grade semanal por serviço e a alocação.
// Fora do componente (react-refresh): a página e o registro de telas importam a lista.
export type PatientTab =
  | 'clinicalData'
  | 'supportNetwork'
  | 'contractedService'
  | 'vacancies'
  | 'encuadre'
  | 'itinerary'
  | 'history';


export const PATIENT_TABS: readonly PatientTab[] = [
  'clinicalData',
  'supportNetwork',
  'contractedService',
  'vacancies',
  'encuadre',
  'itinerary',
  'history',
];
