// Spec 014 US-D2 (decisão Gabriel 03/09, item 9): "Datos Financieros" e "Agendamientos"
// SAEM do tab bar — eram abas que só caíam no placeholder genérico "Próximamente" (nenhum card
// ligado). Uma aba só entra aqui quando tiver conteúdo real por trás (todas as 6 abaixo têm).
// 05/09 (decisão do Gabriel, veio da main no sync de 08/09): "Encuadre/Matching" também sai — era a MESMA
// tabela de serviços contratados duplicada + um card "Próximamente". O encuadre do paciente É o serviço
// contratado completo (endereço + horário, migration 330), e vive na aba "Servicio Contratado".
// Spec 049 (F7): a aba "Admisión" entra logo depois de "Documentos" (a vacante deixou a posição livre; 047 não reservou lugar).
// Fora do componente (react-refresh): a página e o registro de telas importam a lista.
export type PatientTab =
  | 'clinicalData'
  | 'supportNetwork'
  | 'documents'
  | 'admission'
  | 'contractedService'
  | 'history';


export const PATIENT_TABS: readonly PatientTab[] = [
  'clinicalData',
  'supportNetwork',
  'documents',
  'admission',
  'contractedService',
  'history',
];

/**
 * `?tab=` da URL da ficha → aba, validado contra a união. Valor ausente ou fora de `PATIENT_TABS`
 * devolve `null` (quem chama cai em `clinicalData`, o comportamento de antes do `?tab=`).
 */
export function parsePatientTab(raw: string | null | undefined): PatientTab | null {
  return PATIENT_TABS.find((tab) => tab === raw) ?? null;
}

/**
 * Caminho da ficha do paciente já aberta numa aba — o ÚNICO montador, para o wizard
 * (`LockedFieldBadgeLink`) e o detalhe da vaga abrirem o MESMO lugar. Horário, quantidade de
 * profissionais, faixa etária e domicílio do serviço moram todos na aba "Servicio Contratado".
 */
export function patientTabPath(patientId: string, tab: PatientTab): string {
  return `/admin/patients/${patientId}?tab=${tab}`;
}
