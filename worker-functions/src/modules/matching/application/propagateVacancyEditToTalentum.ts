/**
 * propagateVacancyEditToTalentum — o que o PUT /vacancies/:id manda ao Talentum DEPOIS do commit, em vaga já publicada:
 *  - horário (`schedule`) alterado → regera a descrição (Gemini; já grava e audita) e envia o conteúdo (caminho único).
 * Pausa e retomada NÃO nascem mais aqui: ninguém edita status (semaforo-da-vaga F4). Elas seguem a transição do paciente
 * (`PatientStatusWriter`) e a baixa. Nunca lança e nunca apaga projeto. A gravação local já aconteceu: o resultado só
 * informa o envio (`talentumSync`).
 */
import type { TalentumSyncResult } from '../../integration/application/SyncVacancyContentToTalentumUseCase';
import type { DescriptionAuditActor } from '../../integration/infrastructure/TalentumDescriptionService';

export interface VacancyEditPropagationDeps {
  describer: { generateDescription(id: string, actor?: DescriptionAuditActor): Promise<unknown> };
  content: { propagate(id: string, actor?: { traceId?: string | null }): Promise<TalentumSyncResult> };
}

export interface VacancyEditPropagationInput {
  vacancyId: string;
  /** `talentum_project_id` não nulo. Rascunho/não publicada → nada é chamado. */
  published: boolean;
  scheduleChanged: boolean;
  actor?: DescriptionAuditActor;
}

const RANK: Record<string, number> = { FAILED: 3, OTHER_ACCOUNT: 2, OK: 1, NOT_PUBLISHED: 0 };
const worst = (a: TalentumSyncResult, b: TalentumSyncResult): TalentumSyncResult => (RANK[b.status] > RANK[a.status] ? b : a);

export async function propagateVacancyEditToTalentum(
  input: VacancyEditPropagationInput,
  deps: VacancyEditPropagationDeps,
): Promise<TalentumSyncResult | null> {
  if (!input.published || !input.scheduleChanged) return null;

  let result: TalentumSyncResult = { status: 'OK' };
  try {
    await deps.describer.generateDescription(input.vacancyId, input.actor);
    result = worst(result, await deps.content.propagate(input.vacancyId, input.actor));
  } catch (err) {
    console.error(`[VacancyEditToTalentum] vacancy=${input.vacancyId} step=regenerate-description failed`);
    result = worst(result, {
      status: 'FAILED',
      message: `No se pudo regenerar la descripción con el nuevo horario: ${err instanceof Error ? err.message : 'error'}`.slice(0, 300),
    });
  }
  return result;
}
