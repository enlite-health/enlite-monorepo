/**
 * Spec 051 (F1 / PR-A) — trocar o status clínico do paciente por FORA do fluxo normal.
 *
 * O fluxo normal é a FSM (`patient_status_transitions`). Quem quiser pôr o paciente num estado
 * clínico HUMANO para o qual a FSM não tem seta precisa da célula do DESTINO:
 * `patient_status:move_to_<destino>` (4 células: ON_HOLD, SUSPENDED, ALTA, DISCHARGED). Esta função pura decide isso.
 *
 * Está ligada a `PatientStatusWriter` (via `avaliarTroca`), que a consulta depois da guarda de origem. Os destinos DERIVADOS
 * (SEARCHING/REPLACEMENT/ACTIVE) não têm célula desde a F5 (estado-automatico-do-paciente): quem os pede por fora da FSM é recusado
 * pela transição, e a tabela de origem (`PatientChangeSource`) já recusa antes disso com `PATIENT_STATUS_NOT_MANUAL`.
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

export const CELL_PATIENT_STATUS_MOVE_TO_ON_HOLD = 'patient_status:move_to_on_hold';
export const CELL_PATIENT_STATUS_MOVE_TO_SUSPENDED = 'patient_status:move_to_suspended';
export const CELL_PATIENT_STATUS_MOVE_TO_ALTA = 'patient_status:move_to_alta';
export const CELL_PATIENT_STATUS_MOVE_TO_DISCHARGED = 'patient_status:move_to_discharged';

/** Os 4 destinos humanos — os únicos que têm célula (os outros 3 são do fluxo automático). */
export type DestinoHumano = Extract<ClinicalPatientStatus, 'ON_HOLD' | 'SUSPENDED' | 'ALTA' | 'DISCHARGED'>;

/** Destino humano → célula que autoriza chegar nele por fora da FSM. */
export const CELULA_DO_DESTINO: Readonly<Record<DestinoHumano, string>> = {
  ON_HOLD: CELL_PATIENT_STATUS_MOVE_TO_ON_HOLD,
  SUSPENDED: CELL_PATIENT_STATUS_MOVE_TO_SUSPENDED,
  ALTA: CELL_PATIENT_STATUS_MOVE_TO_ALTA,
  DISCHARGED: CELL_PATIENT_STATUS_MOVE_TO_DISCHARGED,
};

export const isDestinoHumano = (v: unknown): v is DestinoHumano =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(CELULA_DO_DESTINO, v);

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
  | { resultado: 'nao_se_aplica'; motivo: 'origem_nao_manual' | 'fora_do_funil_clinico' | 'mesmo_estado' | 'destino_do_fluxo_automatico' }
  /** O par está na FSM: segue como hoje, sem célula, sem override. */
  | { resultado: 'fluxo_normal' }
  /** Engine não decidiu: o chamador mantém o comportamento de hoje (recusa pela transição). */
  | { resultado: 'engine_nao_decidiu' }
  /** Par fora da FSM e o ator não tem a célula do destino. */
  | { resultado: 'recusada_por_permissao'; celulaFaltante: string }
  /** Par fora da FSM e o ator TEM a célula do destino: é o caso que gravará `*_override`. */
  | { resultado: 'permitida_por_permissao'; celula: string };

/**
 * Consumidor das 4 células. Um `case` por destino, com a constante à vista, de propósito: a
 * régua `catalogo-sem-orfao` só reconhece `cells.includes(<constante resolvível>)`.
 */
function atorTemACelulaDoDestino(cells: readonly string[], para: DestinoHumano): boolean {
  switch (para) {
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
  // Sem célula para SEARCHING/REPLACEMENT/ACTIVE (F5): não há o que conceder — o chamador segue a FSM (e a tabela de origem já recusou).
  if (!isDestinoHumano(e.para)) return { resultado: 'nao_se_aplica', motivo: 'destino_do_fluxo_automatico' };

  // `null` = engine não decidiu → comportamento de hoje. NÃO é "sem permissão".
  if (e.cells === null) return { resultado: 'engine_nao_decidiu' };

  if (!atorTemACelulaDoDestino(e.cells, e.para)) {
    return { resultado: 'recusada_por_permissao', celulaFaltante: CELULA_DO_DESTINO[e.para] };
  }
  return { resultado: 'permitida_por_permissao', celula: CELULA_DO_DESTINO[e.para] };
}
