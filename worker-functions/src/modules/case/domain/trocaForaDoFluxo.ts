/**
 * Spec 051 (F1 / PR-A) — trocar o status clínico do paciente por FORA do fluxo normal.
 *
 * O fluxo normal é a FSM (`patient_status_transitions`). Quem quiser pôr o paciente num estado
 * clínico para o qual a FSM não tem seta (ex.: ACTIVE → SEARCHING direto) precisa da célula do
 * DESTINO: `patient_status:move_to_<destino>`. Esta função pura decide isso.
 *
 * ⚠️ NÃO está ligada a `PatientStatusWriter`, controller nem rota neste PR. Ela é o CONSUMIDOR
 * das 7 células (a régua `catalogo-sem-orfao` exige consumidor real) e o contrato que o PR-B vai
 * ligar. Nenhum comportamento muda até lá.
 *
 * Domínio puro: sem banco, sem express, sem infraestrutura (molde:
 * `worker/domain/transicaoDeBaixa.ts`). Por isso as chaves de célula são declaradas aqui como
 * literais; `__tests__/paridadeDeCelulasPatientStatus.test.ts` reprova se divergirem de
 * `CELL_DESCRIPTION` ou do que o catálogo declara (`cellsForaDeRota`).
 *
 * `cells`: `null` = o engine ABAC não decidiu nesta request → comportamento de hoje (o chamador
 * recusa pela transição). `[]` = ator conhecido SEM célula → recusa por permissão. Nunca `?? []`.
 */

import { isClinicalPatientStatus, type ClinicalPatientStatus } from './enums/PatientStatus';
import { isManualChangeSource, type PatientChangeSource } from './enums/PatientChangeSource';

export const CELL_PATIENT_STATUS_MOVE_TO_SEARCHING = 'patient_status:move_to_searching';
export const CELL_PATIENT_STATUS_MOVE_TO_ACTIVE = 'patient_status:move_to_active';
export const CELL_PATIENT_STATUS_MOVE_TO_REPLACEMENT = 'patient_status:move_to_replacement';
export const CELL_PATIENT_STATUS_MOVE_TO_ON_HOLD = 'patient_status:move_to_on_hold';
export const CELL_PATIENT_STATUS_MOVE_TO_SUSPENDED = 'patient_status:move_to_suspended';
export const CELL_PATIENT_STATUS_MOVE_TO_ALTA = 'patient_status:move_to_alta';
export const CELL_PATIENT_STATUS_MOVE_TO_DISCHARGED = 'patient_status:move_to_discharged';

/** Destino clínico → célula que autoriza chegar nele por fora da FSM. */
export const CELULA_DO_DESTINO: Readonly<Record<ClinicalPatientStatus, string>> = {
  SEARCHING: CELL_PATIENT_STATUS_MOVE_TO_SEARCHING,
  ACTIVE: CELL_PATIENT_STATUS_MOVE_TO_ACTIVE,
  REPLACEMENT: CELL_PATIENT_STATUS_MOVE_TO_REPLACEMENT,
  ON_HOLD: CELL_PATIENT_STATUS_MOVE_TO_ON_HOLD,
  SUSPENDED: CELL_PATIENT_STATUS_MOVE_TO_SUSPENDED,
  ALTA: CELL_PATIENT_STATUS_MOVE_TO_ALTA,
  DISCHARGED: CELL_PATIENT_STATUS_MOVE_TO_DISCHARGED,
};

export interface EntradaTrocaForaDoFluxo {
  de: string | null;
  para: string;
  /** O par `de → para` existe em `patient_status_transitions`. */
  naFsm: boolean;
  /** Células do ator. `null` = engine não decidiu (≠ `[]`). */
  cells: readonly string[] | null;
  changeSource: PatientChangeSource;
}

export type DecisaoTrocaForaDoFluxo =
  /** Fora do alcance desta regra: nunca exige célula, nunca marca override. */
  | { resultado: 'nao_se_aplica'; motivo: 'origem_nao_manual' | 'fora_do_funil_clinico' | 'mesmo_estado' }
  /** O par está na FSM: segue como hoje, sem célula, sem override. */
  | { resultado: 'fluxo_normal' }
  /** Engine não decidiu: o chamador mantém o comportamento de hoje (recusa pela transição). */
  | { resultado: 'engine_nao_decidiu' }
  /** Par fora da FSM e o ator não tem a célula do destino. */
  | { resultado: 'recusada_por_permissao'; celulaFaltante: string }
  /** Par fora da FSM e o ator TEM a célula do destino: é o caso que gravará `*_override`. */
  | { resultado: 'permitida_por_permissao'; celula: string };

/**
 * Consumidor das 7 células. Um `case` por destino, com a constante à vista, de propósito: a
 * régua `catalogo-sem-orfao` só reconhece `cells.includes(<constante resolvível>)`.
 */
function atorTemACelulaDoDestino(cells: readonly string[], para: ClinicalPatientStatus): boolean {
  switch (para) {
    case 'SEARCHING': return cells.includes(CELL_PATIENT_STATUS_MOVE_TO_SEARCHING);
    case 'ACTIVE': return cells.includes(CELL_PATIENT_STATUS_MOVE_TO_ACTIVE);
    case 'REPLACEMENT': return cells.includes(CELL_PATIENT_STATUS_MOVE_TO_REPLACEMENT);
    case 'ON_HOLD': return cells.includes(CELL_PATIENT_STATUS_MOVE_TO_ON_HOLD);
    case 'SUSPENDED': return cells.includes(CELL_PATIENT_STATUS_MOVE_TO_SUSPENDED);
    case 'ALTA': return cells.includes(CELL_PATIENT_STATUS_MOVE_TO_ALTA);
    case 'DISCHARGED': return cells.includes(CELL_PATIENT_STATUS_MOVE_TO_DISCHARGED);
  }
}

export function decidirTrocaForaDoFluxo(e: EntradaTrocaForaDoFluxo): DecisaoTrocaForaDoFluxo {
  if (!isManualChangeSource(e.changeSource)) {
    return { resultado: 'nao_se_aplica', motivo: 'origem_nao_manual' };
  }
  if (!isClinicalPatientStatus(e.de) || !isClinicalPatientStatus(e.para)) {
    return { resultado: 'nao_se_aplica', motivo: 'fora_do_funil_clinico' };
  }
  if (e.de === e.para) {
    return { resultado: 'nao_se_aplica', motivo: 'mesmo_estado' };
  }
  if (e.naFsm) return { resultado: 'fluxo_normal' };

  // `null` = engine não decidiu → comportamento de hoje. NÃO é "sem permissão".
  if (e.cells === null) return { resultado: 'engine_nao_decidiu' };

  if (!atorTemACelulaDoDestino(e.cells, e.para)) {
    return { resultado: 'recusada_por_permissao', celulaFaltante: CELULA_DO_DESTINO[e.para] };
  }
  return { resultado: 'permitida_por_permissao', celula: CELULA_DO_DESTINO[e.para] };
}
