/**
 * inviteBoardModel — regra da página "Invitar prestadores" (spec 089 §9.5), PURA. Ponto de entrada:
 * re-exporta a API dos módulos irmãos por assunto (core: bandas/seleção/dia · steps: cartões, rodapé,
 * cabeçalho e linhas · map: anéis, pinos, nota · finish: F5) e compõe `buildBoardView`.
 */
import type { BoardContext, StepId } from './inviteBoardCore';
import { fitRadiusKmOf, stepPins, stepRings, vacanteNote } from './inviteBoardMap';
import { docsLine, selectionSummary, stepFooter, stepGuide, stepRowModels, stepSummaries, stepTitle } from './inviteBoardSteps';

export * from './inviteBoardCore';
export * from './inviteBoardSteps';
export * from './inviteBoardMap';
export * from './inviteBoardFinish';

/** Tudo que a página precisa decidir para um passo — a página só desenha. */
export function buildBoardView(ctx: BoardContext, step: StepId) {
  return {
    step,
    steps: stepSummaries(ctx, step),
    title: stepTitle(step),
    guide: stepGuide(ctx, step),
    /** ⚑7: "Solo aparecen prestadores que cumplen el perfil…" escondida no passo vacante. */
    showProfileNote: step !== 'vacante',
    docs: docsLine(ctx, step),
    selection: selectionSummary(ctx, step),
    rows: stepRowModels(ctx, step),
    rings: stepRings(ctx, step),
    fitRadiusKm: fitRadiusKmOf(step),
    pins: stepPins(ctx, step),
    vacanteNote: vacanteNote(ctx, step),
    footer: stepFooter(ctx, step),
  };
}

