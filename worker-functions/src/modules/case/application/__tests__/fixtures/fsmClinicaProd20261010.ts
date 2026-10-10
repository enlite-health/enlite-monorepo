import type { ClinicalPatientStatus } from '../../../domain/enums/PatientStatus';

/**
 * Os 27 pares clínico→clínico de `patient_status_transitions` medidos em PRODUÇÃO em 10/10/2026
 * (`SELECT from_status, to_status FROM patient_status_transitions`, spec 051 §2.1; a tabela tem 36
 * linhas, as outras 9 envolvem o funil). É DADO de teste: as matrizes derivam daqui o que é "dentro"
 * e "fora" do fluxo, em vez de escrever o esperado caso a caso. Se a FSM de prd mudar, este arquivo
 * é o único a atualizar.
 */
export const FSM_CLINICA_PRD_20261010: Readonly<Record<ClinicalPatientStatus, readonly ClinicalPatientStatus[]>> = {
  ACTIVE: ['ALTA', 'DISCHARGED', 'ON_HOLD', 'REPLACEMENT', 'SUSPENDED'],
  ALTA: ['DISCHARGED'],
  DISCHARGED: ['ACTIVE', 'ALTA'],
  ON_HOLD: ['ACTIVE', 'ALTA', 'DISCHARGED', 'SEARCHING'],
  REPLACEMENT: ['ACTIVE', 'ALTA', 'DISCHARGED', 'SEARCHING', 'SUSPENDED'],
  SEARCHING: ['ACTIVE', 'ALTA', 'DISCHARGED', 'ON_HOLD'],
  SUSPENDED: ['ACTIVE', 'ALTA', 'DISCHARGED', 'ON_HOLD', 'REPLACEMENT', 'SEARCHING'],
};

export const PARES_NA_FSM: ReadonlyArray<readonly [ClinicalPatientStatus, ClinicalPatientStatus]> =
  (Object.entries(FSM_CLINICA_PRD_20261010) as Array<[ClinicalPatientStatus, readonly ClinicalPatientStatus[]]>)
    .flatMap(([de, paras]) => paras.map((para) => [de, para] as const));

export const naFsm = (de: string, para: string): boolean => PARES_NA_FSM.some(([d, p]) => d === de && p === para);
