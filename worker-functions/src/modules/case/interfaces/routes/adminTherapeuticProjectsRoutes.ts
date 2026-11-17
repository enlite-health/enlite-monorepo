import { Router, Request, Response, NextFunction } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { AdminTherapeuticProjectsController, type RequestWithTherapeuticContactContainers } from '../controllers/AdminTherapeuticProjectsController';
import { THERAPEUTIC_PROJECT_RESOURCE, therapeuticTrailAction } from '../../application/therapeuticProjectAccess';
import { SERVICE_EXIT_REASON_KIND } from '../../domain/serviceExitReason';
import { SERVICE_SHIFT_TEMPLATE_KIND } from '../../domain/serviceShiftTemplate';
import { AdminServiceShiftTemplatesController } from '../controllers/AdminServiceShiftTemplatesController';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { TerminologyPort } from '@modules/terminology/domain/TerminologyPort';
import { createTerminologyPort } from '@modules/terminology/infrastructure/TerminologyPortFactory';
import { TherapeuticProjectRepository } from '../../infrastructure/TherapeuticProjectRepository';
import { TherapeuticCatalogRepository } from '../../infrastructure/TherapeuticCatalogRepository';
import { TherapeuticProjectContactsRepository } from '../../infrastructure/TherapeuticProjectContactsRepository';
import { TherapeuticCatalogLinkRepository } from '../../infrastructure/TherapeuticCatalogLinkRepository';
import { PgIcdCategoryLookup } from '../../infrastructure/PgIcdCategoryLookup';
import { PgTherapeuticCatalogCascade } from '../../infrastructure/PgTherapeuticCatalogCascade';
import { ResolveDiagnosisCategories } from '../../application/resolveDiagnosisCategories';
import { ResolveTherapeuticCatalogCascade } from '../../application/ResolveTherapeuticCatalogCascade';

/**
 * COMPOSITION ROOT do catálogo por CID (spec 091, §3.1): o ÚNICO lugar que instancia os adaptadores `Pg*` e os
 * injeta nos casos de uso e no controller. Tudo LAZY: o pool só abre na 1ª consulta e `createTerminologyPort`
 * (que lança sem env) só roda na 1ª cascata — então montar o controller no boot não toca banco nem terminologia.
 */
export function buildAdminTherapeuticProjectsController(): AdminTherapeuticProjectsController {
  const lazyDb = { query: ((...args: unknown[]) => (DatabaseConnection.getInstance().getPool().query as (...a: unknown[]) => unknown)(...args)) as never };
  let terminology: TerminologyPort | undefined;
  const lazyTerminology: Pick<TerminologyPort, 'getByUri'> = {
    getByUri: (uri) => (terminology ??= createTerminologyPort(process.env)).getByUri(uri),
  };
  const icdCategories = new PgIcdCategoryLookup(lazyDb);
  const cascade = new ResolveTherapeuticCatalogCascade(new ResolveDiagnosisCategories(lazyTerminology), new PgTherapeuticCatalogCascade(lazyDb));
  return new AdminTherapeuticProjectsController(
    new TherapeuticProjectRepository(),
    new TherapeuticCatalogRepository(),
    new TherapeuticProjectContactsRepository(),
    undefined, undefined, undefined, undefined,
    cascade,
    new TherapeuticCatalogLinkRepository(icdCategories),
    icdCategories,
  );
}

/**
 * Rotas do Projeto Terapêutico (spec 017, D299) — router PRÓPRIO, montado em `/api/admin`, na
 * família `admin.patients` (D299.3: célula nova na família existente; sem família nova, sem mexer
 * em `PERMISSION_ENFORCED_ROUTES`). Fábrica sem default de controller, como `adminPatientsRoutes`.
 *
 * Células (design 1b: declarar É enforçar; o sync do catálogo publica no boot):
 *   · `patient_therapeutic_project:read|write` — o container da ficha (D286); `patient_clinical`
 *     é cumulativa e conferida no controller/projeção (lex C7).
 *   · `catalog_therapeutic_objectives|catalog_therapeutic_activities :read|create|update` — uma célula por
 *     catálogo (Gabriel, 08/09). O catálogo de segmentos acabou (spec 091): sem rota, sem célula (404). Tipo de
 *     patologia NÃO tem catálogo: deriva do CID-11 (D163/D164). Há UMA rota por catálogo em vez de `:kind`
 *     dinâmico: célula é declarada, LITERAL em cada `perm.require` (091, §9.4), nunca calculada em runtime.
 *
 * `untilEnforced: 'admin'` nas escritas: até a família virar, papel admin — o mesmo amortecedor
 * das outras rotas de escrita do paciente. Trilha (lex C9/C13): só nomes de container.
 */
export function createAdminTherapeuticProjectsRoutes(
  controller: AdminTherapeuticProjectsController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  shiftTemplates: AdminServiceShiftTemplatesController = new AdminServiceShiftTemplatesController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  // `req.therapeuticContactContainers` (lex C6): containers de CONTATO efetivamente resolvidos —
  // o controller escreve nesse campo ANTES de `res.json`, e `logResourceAccess` lê no `finish`.
  const contactContainersOf = (req: Request): string[] => (req as RequestWithTherapeuticContactContainers).therapeuticContactContainers ?? [];
  const readTrail = (req: Request): string => therapeuticTrailAction('read_project', req.permissionCells ?? null, contactContainersOf(req));
  // Só a leitura de UMA versão pode ser export (lex C13): a lista com `?purpose=export` é leitura comum.
  const versionTrail = (req: Request): string =>
    therapeuticTrailAction(req.query.purpose === 'export' ? 'export_pdf' : 'read_project', req.permissionCells ?? null, contactContainersOf(req));
  // Conserto 14/09: `create` agora resolve contatos (mesmo molde de `get`/`list`) — `writeTrail`
  // passa a ler os containers SERVIDOS igual a `readTrail`. `annul` não resolve contato nenhum,
  // então `contactContainersOf` continua vazio ali (nenhuma mudança de formato para essa rota).
  const writeTrail = (req: Request): string => therapeuticTrailAction('write_project', req.permissionCells ?? null, contactContainersOf(req));

  router.get(
    '/patients/:id/therapeutic-projects',
    staffOnly,
    perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'read'),
    logResourceAccess('patient', readTrail),
    (req: Request, res: Response) => controller.list(req, res),
  );
  router.post(
    '/patients/:id/therapeutic-projects',
    staffOnly,
    perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'create', { untilEnforced: 'admin' }),
    logResourceAccess('patient', writeTrail),
    (req: Request, res: Response) => controller.create(req, res),
  );
  // `?purpose=export` (lex C8(b), contract §Export do PDF): exige a célula `…:export` ALÉM da
  // leitura — mesmo para versão ANTIGA (permissão da versão antiga = vigente, lex C8). A trilha
  // sai `export_pdf:` (ver `versionTrail`), nunca `read_project:`, quando o purpose é export.
  const exportGate = (req: Request, res: Response, next: NextFunction): void => {
    if (req.query.purpose !== 'export') return next();
    return perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'export')(req, res, next);
  };
  router.get(
    '/patients/:id/therapeutic-projects/:vid',
    staffOnly,
    perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'read'),
    exportGate,
    logResourceAccess('patient', versionTrail),
    (req: Request, res: Response) => controller.get(req, res),
  );
  router.post(
    '/patients/:id/therapeutic-projects/:vid/annul',
    staffOnly,
    perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'update', { untilEnforced: 'admin' }),
    logResourceAccess('patient', writeTrail),
    (req: Request, res: Response) => controller.annul(req, res),
  );

  // ── Catálogos terapêuticos (091, §9.4): célula LITERAL em cada rota, fora de qualquer laço ──────────
  // Rotas fixas (`cascade`, `icd-categories`) e `…/:itemId/categories` não colidem com `/:itemId` (path ou verbo distintos).
  // `cascade` exige DUAS células, em guards encadeados: quem a chama lê objetivos E atividades (DD-10).
  router.post(
    '/therapeutic-catalogs/cascade',
    staffOnly,
    perm.require('catalog_therapeutic_objectives', 'read'),
    perm.require('catalog_therapeutic_activities', 'read'),
    (req: Request, res: Response) => controller.cascade(req, res),
  );
  router.get('/therapeutic-catalogs/icd-categories', staffOnly, perm.require('catalog_therapeutic_objectives', 'read'), (req: Request, res: Response) =>
    controller.searchIcdCategories(req, res),
  );

  router.get('/therapeutic-catalogs/specific-objectives', staffOnly, perm.require('catalog_therapeutic_objectives', 'read'), (req: Request, res: Response) =>
    controller.listCatalog('specific-objectives', req, res),
  );
  router.post('/therapeutic-catalogs/specific-objectives', staffOnly, perm.require('catalog_therapeutic_objectives', 'create', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.createCatalogItem('specific-objectives', req, res),
  );
  router.patch('/therapeutic-catalogs/specific-objectives/:itemId', staffOnly, perm.require('catalog_therapeutic_objectives', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.updateCatalogItem('specific-objectives', req, res),
  );
  router.get('/therapeutic-catalogs/specific-objectives/:itemId/categories', staffOnly, perm.require('catalog_therapeutic_objectives', 'read'), (req: Request, res: Response) =>
    controller.listCategoryLinks('objective', req, res),
  );
  router.post('/therapeutic-catalogs/specific-objectives/:itemId/categories', staffOnly, perm.require('catalog_therapeutic_objectives', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.addCategoryLink('objective', req, res),
  );
  router.delete('/therapeutic-catalogs/specific-objectives/:itemId/categories/:code', staffOnly, perm.require('catalog_therapeutic_objectives', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.removeCategoryLink('objective', req, res),
  );

  router.get('/therapeutic-catalogs/activities', staffOnly, perm.require('catalog_therapeutic_activities', 'read'), (req: Request, res: Response) =>
    controller.listCatalog('activities', req, res),
  );
  router.post('/therapeutic-catalogs/activities', staffOnly, perm.require('catalog_therapeutic_activities', 'create', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.createCatalogItem('activities', req, res),
  );
  router.patch('/therapeutic-catalogs/activities/:itemId', staffOnly, perm.require('catalog_therapeutic_activities', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.updateCatalogItem('activities', req, res),
  );
  router.get('/therapeutic-catalogs/activities/:itemId/categories', staffOnly, perm.require('catalog_therapeutic_activities', 'read'), (req: Request, res: Response) =>
    controller.listCategoryLinks('activity', req, res),
  );
  router.post('/therapeutic-catalogs/activities/:itemId/categories', staffOnly, perm.require('catalog_therapeutic_activities', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.addCategoryLink('activity', req, res),
  );
  router.delete('/therapeutic-catalogs/activities/:itemId/categories/:code', staffOnly, perm.require('catalog_therapeutic_activities', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.removeCategoryLink('activity', req, res),
  );

  // ── Motivos de saída (492): kind FORA de THERAPEUTIC_CATALOG_KINDS, então fora do laço acima.
  // Célula LITERAL. `/options` é rota irmã sem `:itemId`,
  // sem colisão com o PATCH `/:itemId` (outro verbo) nem com o GET da lista (path distinto).
  router.get(`/therapeutic-catalogs/${SERVICE_EXIT_REASON_KIND}`, staffOnly, perm.require('catalog_service_exit_reasons', 'read'), (req: Request, res: Response) =>
    controller.listCatalog(SERVICE_EXIT_REASON_KIND, req, res),
  );
  router.post(`/therapeutic-catalogs/${SERVICE_EXIT_REASON_KIND}`, staffOnly, perm.require('catalog_service_exit_reasons', 'create', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.createCatalogItem(SERVICE_EXIT_REASON_KIND, req, res),
  );
  router.patch(`/therapeutic-catalogs/${SERVICE_EXIT_REASON_KIND}/:itemId`, staffOnly, perm.require('catalog_service_exit_reasons', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.updateCatalogItem(SERVICE_EXIT_REASON_KIND, req, res),
  );
  // Quem registra a troca lê a lista de motivos ativos sem ser admin de catálogo.
  router.get(`/therapeutic-catalogs/${SERVICE_EXIT_REASON_KIND}/options`, staffOnly, perm.require('patient_services', 'read'), (req: Request, res: Response) =>
    controller.listServiceExitReasonOptions(req, res),
  );

  // ── Guardias predefinidas (550, spec 074): mesmo molde dos motivos de saída, controller próprio.
  router.get(`/therapeutic-catalogs/${SERVICE_SHIFT_TEMPLATE_KIND}`, staffOnly, perm.require('catalog_service_shift_templates', 'read'), (req: Request, res: Response) =>
    shiftTemplates.listShiftTemplates(req, res),
  );
  router.post(`/therapeutic-catalogs/${SERVICE_SHIFT_TEMPLATE_KIND}`, staffOnly, perm.require('catalog_service_shift_templates', 'create', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    shiftTemplates.createShiftTemplate(req, res),
  );
  router.patch(`/therapeutic-catalogs/${SERVICE_SHIFT_TEMPLATE_KIND}/:itemId`, staffOnly, perm.require('catalog_service_shift_templates', 'update', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    shiftTemplates.updateShiftTemplate(req, res),
  );
  router.get(`/therapeutic-catalogs/${SERVICE_SHIFT_TEMPLATE_KIND}/options`, staffOnly, perm.require('patient_services', 'read'), (req: Request, res: Response) =>
    shiftTemplates.listShiftTemplateOptions(req, res),
  );

  return router;
}
