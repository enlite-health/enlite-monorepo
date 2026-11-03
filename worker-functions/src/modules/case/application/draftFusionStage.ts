/**
 * draftFusionStage — regra PURA da etapa do Kanban quando o MESMO worker está no rascunho e na vaga oficial
 * (fusão rascunho→oficial, decisão do Gabriel 03/11). Reaproveita `ENTRY_STAGES` da reconciliação de cadastros
 * fundidos (`ReconcileMergedWorkerApplications`) — "etapa de entrada" = ninguém decidiu nada sobre a pessoa.
 *
 *   - mesma etapa                                  → KEEP;
 *   - oficial em etapa de entrada (ou sem etapa)   → ADOPT a do rascunho (REJECTED continua REJECTED);
 *   - oficial decidida, rascunho em entrada/vazio  → KEEP (a decisão fica);
 *   - as duas decididas e DIFERENTES               → CONFLICT: o paciente inteiro NÃO é fundido.
 *
 * Diferença deliberada da reconciliação: lá a oficial só adota quando o rascunho está FORA da entrada; aqui a
 * regra do Gabriel é "oficial em entrada adota a do rascunho" — inclusive INVITED → PRE_SCREENING.
 */
import { ENTRY_STAGES } from '../../matching/application/ReconcileMergedWorkerApplications';

export type CollisionStageDecision =
  | { action: 'KEEP' }
  | { action: 'ADOPT'; stage: string }
  | { action: 'CONFLICT' };

const isEntry = (stage: string | null): boolean => stage == null || ENTRY_STAGES.includes(stage);

export function decideCollisionStage(officialStage: string | null, draftStage: string | null): CollisionStageDecision {
  if (officialStage === draftStage || draftStage == null) return { action: 'KEEP' };
  if (isEntry(officialStage)) return { action: 'ADOPT', stage: draftStage };
  if (isEntry(draftStage)) return { action: 'KEEP' };
  return { action: 'CONFLICT' };
}
