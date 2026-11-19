/**
 * Monta o molde de UMA guarda a partir do PTI vigente (DC-4). Compartilhado por `GetReportTemplates` (o app baixa) e `SubmitDailyReport`
 * (o servidor valida contra o MESMO molde): um dono da regra de "o que se pergunta".
 */
import type { DailyReportTx, ProjectVersionRef } from '../ports/DailyReportPort';
import { DailyReportTemplate, type ScaleCatalog } from '../../domain/DailyReport';

export async function templateOf(tx: DailyReportTx, catalog: ScaleCatalog, version: ProjectVersionRef | null): Promise<DailyReportTemplate> {
  if (version === null) return DailyReportTemplate.withoutProject();
  const items = await tx.catalogItems(version.objectiveIds, version.activityIds);
  return DailyReportTemplate.build(version.id, items.objectives, items.activities, catalog);
}
