/**
 * Vocabulário que a lista de destinos (spec 051, `PatientStatusOptions`) e a lista de ações (F3, `ListPatientStatusActionsUseCase`)
 * compartilham — um dono só, sem import de infraestrutura (os use cases por ports não podem importar `PatientStatusOptions`).
 */

/** `fluxo` = tem linha na FSM; `permissao` = fora da FSM, liberada pela célula do destino. */
export type ViaDaTroca = 'fluxo' | 'permissao';

/** D489/D530: o paciente tem prestador com alocação VIVA no itinerário — toda troca humana é recusada. */
export const ACTIVE_ALLOCATION_BLOCK = 'ACTIVE_ALLOCATION' as const;
