/**
 * deleteVacancyTalentumProject — regra do Gabriel (16/11): "excluir vagas precisa excluir na Talentum também".
 * Roda DEPOIS do commit do soft delete (o chamador nunca desfaz o delete). `DELETE /projects/:id` via
 * `TalentumApiClient.deletePrescreening`. 404 = o projeto já não existe = sucesso. Qualquer outra falha NUNCA é silenciosa:
 * vira `talentumSync` (FAILED / OTHER_ACCOUNT) na resposta e `reportError`. Nunca lança.
 * Side-effect outbound: UM DELETE por vaga com projeto. Em teste o cliente é injetado.
 */
import { reportError } from '@shared/logging';
import { TalentumApiClient } from '../../integration/infrastructure/TalentumApiClient';
import type { ITalentumApiClient } from '../../integration/domain/ITalentumApiClient';
import { isDeadProjectError, isOtherAccountError } from '../../integration/domain/talentumErrors';
import type { TalentumSyncResult } from '../../integration/application/SyncVacancyContentToTalentumUseCase';

type DeleteClient = Pick<ITalentumApiClient, 'deletePrescreening'>;

export const DELETE_OTHER_ACCOUNT_MESSAGE =
  'La vacante se borró, pero su proyecto fue creado en Talentum por otra cuenta y no se pudo borrar allí; borralo a mano en Talentum ' +
  '(a vaga foi apagada, mas o projeto é de outra conta na Talentum e não pôde ser apagado; apague à mão).';
export const DELETE_FAILED_MESSAGE =
  'La vacante se borró, pero no se pudo borrar el proyecto en Talentum; borralo a mano ' +
  '(a vaga foi apagada, mas o projeto não pôde ser apagado na Talentum; apague à mão).';

export async function deleteVacancyTalentumProject(
  input: { vacancyId: string; projectId: string },
  clientFactory: () => Promise<DeleteClient> = () => TalentumApiClient.create(),
): Promise<TalentumSyncResult> {
  const { vacancyId, projectId } = input;
  try {
    const client = await clientFactory();
    await client.deletePrescreening(projectId);
    return { status: 'OK' };
  } catch (err) {
    if (isDeadProjectError(err)) return { status: 'OK' };
    reportError(err instanceof Error ? err : new Error(String(err)), {
      source: 'deleteVacancyTalentumProject', vacancyId,
    });
    if (isOtherAccountError(err)) return { status: 'OTHER_ACCOUNT', message: DELETE_OTHER_ACCOUNT_MESSAGE };
    return { status: 'FAILED', message: DELETE_FAILED_MESSAGE };
  }
}
