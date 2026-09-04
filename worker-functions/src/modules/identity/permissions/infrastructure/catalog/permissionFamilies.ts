/**
 * src/modules/identity/permissions/infrastructure/catalog/permissionFamilies.ts
 *
 * `ALL_PERMISSION_FAMILIES` — o PONTO ÚNICO que soma as 12 famílias que
 * zeraram `PENDING_DECLARATIONS` (task 3.5). Não digita nenhum literal novo:
 * reimporta a constante `..._FAMILY` que CADA router já exporta (a mesma que
 * `permissions.family(...)` recebe naquele arquivo), então uma família que
 * mudar de nome no router muda aqui pelo import, não por uma 2ª edição.
 *
 * Por que existe: `permission-enforcement-all-families.e2e.test.ts` liga o
 * engine com as 12 de uma vez (C1) e precisa de UMA lista para
 * `PERMISSION_ENFORCED_ROUTES` — sem esta constante o teste teria que digitar
 * a lista à mão, e família nova (13ª) poderia nascer sem entrar nela e o
 * teste continuaria verde por omissão. Com o import, família nova SEM entrar
 * aqui ainda não quebra sozinha — por isso o teste faz uma 2ª verificação,
 * comparando esta lista contra a varredura viva do app (`registry.all()` /
 * `/.well-known/permissions/routes`): uma família nova só é invisível aos
 * DOIS ao mesmo tempo se ninguém a montou em rota nenhuma, e nesse caso ela
 * não existe para o engine de qualquer forma.
 */

import { ADMIN_DEDUP_FAMILY } from '../../../../../interfaces/routes/dedupRoutes';
import { ADMIN_TEST_FIXTURES_FAMILY } from '../../../../../interfaces/routes/testFixturesRoutes';
import { ADMIN_PATIENTS_FAMILY } from '../../../../case/interfaces/routes/adminPatientsRoutes';
import { ADMIN_USERS_FAMILY } from '../../../interfaces/routes/adminUsersRoutes';
import { ADMIN_PERMISSIONS_FAMILY } from '../../../interfaces/routes/permissionPanelRoutes';
import { ADMIN_INTEGRATIONS_FAMILY } from '../../../../integration/interfaces/routes/adminIntegrationsRoutes';
import { ADMIN_VACANCIES_FAMILY } from '../../../../matching/interfaces/routes/adminVacanciesRoutes';
import { ADMIN_ANALYTICS_FAMILY } from '../../../../matching/interfaces/routes/analyticsRoutes';
import { ADMIN_RECRUITMENT_FAMILY } from '../../../../matching/interfaces/routes/recruitmentRoutes';
import { ADMIN_ENCUADRE_FAMILY } from '../../../../matching/interfaces/routes/workerEncuadreRoutes';
import { ADMIN_MESSAGING_FAMILY } from '../../../../notification/interfaces/routes/messagingRoutes';
import { ADMIN_WORKERS_FAMILY } from '../../../../worker/interfaces/routes/adminWorkerRoutes';

/**
 * As 12 famílias, ORDENADAS (string crua, mesmo critério de `declaredCells`):
 * a ordem alimenta `PERMISSION_ENFORCED_ROUTES` e o array de comparação do
 * teste — locale de máquina não pode mudar o resultado.
 */
export const ALL_PERMISSION_FAMILIES = [
  ADMIN_ANALYTICS_FAMILY,
  ADMIN_DEDUP_FAMILY,
  ADMIN_ENCUADRE_FAMILY,
  ADMIN_INTEGRATIONS_FAMILY,
  ADMIN_MESSAGING_FAMILY,
  ADMIN_PATIENTS_FAMILY,
  ADMIN_PERMISSIONS_FAMILY,
  ADMIN_RECRUITMENT_FAMILY,
  ADMIN_TEST_FIXTURES_FAMILY,
  ADMIN_USERS_FAMILY,
  ADMIN_VACANCIES_FAMILY,
  ADMIN_WORKERS_FAMILY,
].sort() as readonly string[];

export type PermissionFamily = (typeof ALL_PERMISSION_FAMILIES)[number];
