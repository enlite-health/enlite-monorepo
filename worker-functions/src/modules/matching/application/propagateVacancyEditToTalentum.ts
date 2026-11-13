/**
 * propagateVacancyEditToTalentum — o que o PUT /vacancies/:id manda ao Talentum DEPOIS do commit, em vaga já publicada:
 *  - horário (`schedule`) alterado → regera a descrição (Gemini; já grava e audita) e envia o conteúdo (caminho único);
 *  - status alterado → pausa (ON_HOLD/SUSPENDED/CLOSED) ou retoma (saindo deles) via VacancyTalentumPauseService.
 * Nunca lança e nunca apaga projeto. A gravação local já aconteceu: o resultado só informa o envio (`talentumSync`).
 */
import type { TalentumSyncResult } from '../../integration/application/SyncVacancyContentToTalentumUseCase';
import type { DescriptionAuditActor } from '../../integration/infrastructure/TalentumDescriptionService';
import type { VacancyBajaSideEffects } from './VacancyTalentumPauseService';

const PAUSE_STATUSES = new Set(['ON_HOLD', 'SUSPENDED', 'CLOSED']);
const RESUME_STATUSES = new Set(['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'PENDING_ACTIVATION', 'ACTIVE']);

/** Mesmo grupo → nada; entra em pausa → pause; sai da pausa para um status "vivo" → resume. */
export function talentumLifecycleAction(from: string | null, to: string | null): 'pause' | 'resume' | null {
  if (!from || !to || from === to) return null;
  const fromPaused = PAUSE_STATUSES.has(from);
  if (PAUSE_STATUSES.has(to)) return fromPaused ? null : 'pause';
  if (RESUME_STATUSES.has(to) && fromPaused) return 'resume';
  return null;
}

export interface VacancyEditPropagationDeps {
  describer: { generateDescription(id: string, actor?: DescriptionAuditActor): Promise<unknown> };
  content: { propagate(id: string, actor?: { traceId?: string | null }): Promise<TalentumSyncResult> };
  lifecycle: VacancyBajaSideEffects;
}

export interface VacancyEditPropagationInput {
  vacancyId: string;
  /** `talentum_project_id` não nulo. Rascunho/não publicada → nada é chamado. */
  published: boolean;
  scheduleChanged: boolean;
  statusFrom: string | null;
  statusTo: string | null;
  actor?: DescriptionAuditActor;
}

const RANK: Record<string, number> = { FAILED: 3, OTHER_ACCOUNT: 2, OK: 1, NOT_PUBLISHED: 0 };
const worst = (a: TalentumSyncResult, b: TalentumSyncResult): TalentumSyncResult => (RANK[b.status] > RANK[a.status] ? b : a);

export async function propagateVacancyEditToTalentum(
  input: VacancyEditPropagationInput,
  deps: VacancyEditPropagationDeps,
): Promise<TalentumSyncResult | null> {
  if (!input.published) return null;
  const action = talentumLifecycleAction(input.statusFrom, input.statusTo);
  if (!input.scheduleChanged && !action) return null;

  let result: TalentumSyncResult = { status: 'OK' };

  if (input.scheduleChanged) {
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
  }

  if (action) {
    try {
      const outcomes = await deps.lifecycle[action]([input.vacancyId]);
      const manual = outcomes.find((o) => o.state === 'MANUAL_PAUSE' || o.state === 'MANUAL_RESUME');
      if (manual) {
        result = worst(result, {
          status: 'FAILED',
          message: action === 'pause'
            ? 'No se pudo pausar el proyecto en Talentum; pausalo a mano (queda en la lista de pendientes).'
            : 'No se pudo reanudar el proyecto en Talentum; reanudalo a mano (queda en la lista de pendientes).',
        });
      }
    } catch (err) {
      console.error(`[VacancyEditToTalentum] vacancy=${input.vacancyId} step=${action} failed`);
      result = worst(result, { status: 'FAILED', message: `Talentum ${action} failed` });
    }
  }
  return result;
}
