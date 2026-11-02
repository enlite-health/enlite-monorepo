/** custos module — barrel (spec 082): painel de custos da plataforma (billing export no BigQuery). */
import { BigQueryBillingReader } from './infrastructure/BigQueryBillingReader';
import { GetCostOverviewUseCase } from './application/GetCostOverviewUseCase';

export { createAdminCostsRoutes } from './interfaces/routes/adminCostsRoutes';

/** Composition root: UMA instância (o limite de 1 sync a cada 10 s vive no use case). O cliente BigQuery só conecta na 1ª consulta. */
export function createGetCostOverviewUseCase(): GetCostOverviewUseCase {
  return new GetCostOverviewUseCase(BigQueryBillingReader.create());
}
