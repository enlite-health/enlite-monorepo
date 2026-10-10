import { isClinicalPatientStatus, type ClinicalPatientStatus, type PatientStatus } from '../../../domain/enums/PatientStatus';

type Par = readonly [PatientStatus, PatientStatus];

/**
 * A FSM de PRODUÇÃO (36 linhas, medida em 10/10/2026 — spec 051 §2.1), DERIVADA das migrations que
 * populam `patient_status_transitions`, aplicadas em ordem. Nada escrito no olho: cada passo cita o
 * arquivo:linha do INSERT/DELETE (em `worker-functions/migrations/`). Contagem acumulada:
 * 20 (315) -3 (428) +3 (479) +3 (486) +13 (498) = 36.
 */
const FUNIL_ATIVO: Par[] = [['SOLICITANTE', 'ACTIVE'], ['ADMISSION', 'ACTIVE'], ['PENDING_ADMISSION', 'ACTIVE']];
const FUNIL_BUSQUEDA: Par[] = [['SOLICITANTE', 'SEARCHING'], ['ADMISSION', 'SEARCHING'], ['PENDING_ADMISSION', 'SEARCHING']];

export const FSM_MIGRATIONS: ReadonlyArray<{ migration: string; insere: Par[]; remove: Par[] }> = [
  {
    migration: '315_patient_status_transitions.sql:29-50 (17 clínicas + 3 funil→ACTIVE)',
    insere: [
      ['ACTIVE', 'ON_HOLD'], ['ACTIVE', 'REPLACEMENT'], ['ACTIVE', 'SUSPENDED'], ['ACTIVE', 'DISCHARGED'],
      ['ON_HOLD', 'ACTIVE'], ['ON_HOLD', 'SEARCHING'], ['ON_HOLD', 'DISCHARGED'],
      ['SEARCHING', 'ACTIVE'], ['SEARCHING', 'ON_HOLD'], ['SEARCHING', 'DISCHARGED'],
      ['REPLACEMENT', 'ACTIVE'], ['REPLACEMENT', 'SEARCHING'], ['REPLACEMENT', 'SUSPENDED'], ['REPLACEMENT', 'DISCHARGED'],
      ['SUSPENDED', 'ACTIVE'], ['SUSPENDED', 'DISCHARGED'], ['DISCHARGED', 'ACTIVE'],
      ...FUNIL_ATIVO,
    ],
    remove: [],
  },
  { migration: '428_patient_status_transitions_drop_funnel_to_active.sql:24-28 (DELETE funil→ACTIVE)', insere: [], remove: FUNIL_ATIVO },
  { migration: '479_patient_status_transitions_launch_to_searching.sql:8-11 (funil→SEARCHING)', insere: FUNIL_BUSQUEDA, remove: [] },
  {
    migration: '486_patient_status_suspended_exit_reason.sql:23-26',
    insere: [['SUSPENDED', 'SEARCHING'], ['SUSPENDED', 'REPLACEMENT'], ['SUSPENDED', 'ON_HOLD']],
    remove: [],
  },
  {
    migration: '498_patients_status_alta.sql:19-23 (13 linhas ALTA/DISCHARGED)',
    insere: [
      ['SOLICITANTE', 'ALTA'], ['ADMISSION', 'ALTA'], ['PENDING_ADMISSION', 'ALTA'],
      ['SEARCHING', 'ALTA'], ['REPLACEMENT', 'ALTA'], ['ACTIVE', 'ALTA'], ['ON_HOLD', 'ALTA'], ['SUSPENDED', 'ALTA'],
      ['SOLICITANTE', 'DISCHARGED'], ['ADMISSION', 'DISCHARGED'], ['PENDING_ADMISSION', 'DISCHARGED'],
      ['DISCHARGED', 'ALTA'], ['ALTA', 'DISCHARGED'],
    ],
    remove: [],
  },
];

const chave = ([d, p]: Par): string => `${d}>${p}`;
const aplicadas = (): Par[] => {
  const vivas = new Map<string, Par>();
  for (const passo of FSM_MIGRATIONS) {
    passo.remove.forEach((par) => vivas.delete(chave(par)));
    passo.insere.forEach((par) => vivas.set(chave(par), par));
  }
  return [...vivas.values()];
};

/** As 36 linhas da FSM de prd (clínicas + funil). UMA fixture para todos os testes. */
export const PARES_FSM_36: readonly Par[] = aplicadas();

/** Só os pares clínico→clínico (27). */
export const PARES_NA_FSM: ReadonlyArray<readonly [ClinicalPatientStatus, ClinicalPatientStatus]> =
  PARES_FSM_36.filter((par): par is readonly [ClinicalPatientStatus, ClinicalPatientStatus] =>
    isClinicalPatientStatus(par[0]) && isClinicalPatientStatus(par[1]));

/** Existe linha `de → para` na FSM de prd (qualquer par, funil incluído). */
export const naFsm = (de: string, para: string): boolean => PARES_FSM_36.some(([d, p]) => d === de && p === para);

/** Saídas de um estado (formato do `SELECT to_status … WHERE from_status = $1`). */
export const destinosNaFsm = (de: string): PatientStatus[] => PARES_FSM_36.filter(([d]) => d === de).map(([, p]) => p);
