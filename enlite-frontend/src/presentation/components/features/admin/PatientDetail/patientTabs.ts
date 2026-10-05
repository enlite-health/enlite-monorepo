// Spec 014 US-D2 (decisão Gabriel 03/09, item 9): "Datos Financieros" e "Agendamientos"
// SAEM do tab bar — eram abas que só caíam no placeholder genérico "Próximamente" (nenhum card
// ligado). Uma aba só entra aqui quando tiver conteúdo real por trás (todas as 6 abaixo têm).
// 05/09 (decisão do Gabriel, veio da main no sync de 08/09): a antiga aba "Encuadre/Matching" saiu
// — era a MESMA tabela de serviços contratados duplicada + um card "Próximamente". Naquele momento
// o encuadre do paciente ficou sendo só o serviço contratado completo (endereço + horário,
// migration 330), na aba "Servicio Contratado".
// 05/10 (spec 041 R3, planning de 30/09): 'encuadre' SAI de novo — o enquadre será remodelado na
// VACANTE (Diego, PEND-10). O back (`deriveServiceTeam`, marcas, rotas `team/*`) fica; o dado fica sem tela.
// D442 (28/09): 'Itinerario' entra tendo conteúdo real (D431): a grade semanal por serviço e a alocação.
// Spec 031 (D463, 02/10): 'documents' entra DEPOIS de 'supportNetwork' — a aba dos documentos do paciente
// (subidos na ficha ou enviados pelo chat), container próprio `patient_document`.
// Fora do componente (react-refresh): a página e o registro de telas importam a lista.
export type PatientTab =
  | 'clinicalData'
  | 'supportNetwork'
  | 'documents'
  | 'contractedService'
  | 'vacancies'
  | 'itinerary'
  | 'history';


export const PATIENT_TABS: readonly PatientTab[] = [
  'clinicalData',
  'supportNetwork',
  'documents',
  'contractedService',
  'vacancies',
  'itinerary',
  'history',
];
