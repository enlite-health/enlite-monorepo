/**
 * Detalhe de um projeto da Talentum v2 para quem LIGA projeto ↔ vaga (spec 040): o item de
 * `GET /projects` não traz `publicId`/descrição/perguntas, então cada projeto custa 1 `getPrescreening`
 * (2 GETs). Compartilhado pelo sync de vagas e pela reconciliação (F5) — uma regra, um lugar.
 *
 * `PHONE_CALL` não tem prescreening web e `/prescreening` 400 é projeto sem prescreening ativo: os dois
 * seguem SEM `publicId`/link (`webLink: false`) e devolvem o próprio item da lista. Qualquer outro erro
 * propaga (quem chama decide: o sync registra e segue, a reconciliação aborta a escrita).
 */

import type { ITalentumApiClient, TalentumProject } from '../domain/ITalentumApiClient';

export interface TalentumProjectDetail {
  project: TalentumProject;
  /** `true` quando o detalhe veio de `/prescreening` (tem `publicId` e link web). */
  webLink: boolean;
}

export async function loadTalentumProjectDetail(
  item: TalentumProject,
  client: Pick<ITalentumApiClient, 'getPrescreening'>,
): Promise<TalentumProjectDetail> {
  if (item.type === 'PHONE_CALL') return { project: item, webLink: false };
  try {
    return { project: await client.getPrescreening(item.projectId), webLink: true };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('HTTP 400')) return { project: item, webLink: false };
    throw err;
  }
}
