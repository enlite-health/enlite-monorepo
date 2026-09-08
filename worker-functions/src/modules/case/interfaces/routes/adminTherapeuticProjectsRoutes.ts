import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { AdminTherapeuticProjectsController } from '../controllers/AdminTherapeuticProjectsController';
import { THERAPEUTIC_PROJECT_RESOURCE, therapeuticTrailAction } from '../../application/therapeuticProjectAccess';
import { THERAPEUTIC_CATALOG_KINDS, THERAPEUTIC_CATALOG_RESOURCE } from '../../domain/TherapeuticProject';

/**
 * Rotas do Projeto Terapêutico (spec 017, D299) — router PRÓPRIO, montado em `/api/admin`, na
 * família `admin.patients` (D299.3: célula nova na família existente; sem família nova, sem mexer
 * em `PERMISSION_ENFORCED_ROUTES`). Fábrica sem default de controller, como `adminPatientsRoutes`.
 *
 * Células (design 1b: declarar É enforçar; o sync do catálogo publica no boot):
 *   · `patient_therapeutic_project:read|write` — o container da ficha (D286); `patient_clinical`
 *     é cumulativa e conferida no controller/projeção (lex C7).
 *   · `catalog_therapeutic_objectives|catalog_therapeutic_activities :read|write` — uma célula por
 *     catálogo (Gabriel, 08/09). Tipo de patologia NÃO tem catálogo: deriva do CID-11 (D163/D164). A célula sai do `kind` da URL, por isso há UMA
 *     rota por catálogo em vez de `:kind` dinâmico: célula é declarada, nunca calculada em runtime.
 *
 * `untilEnforced: 'admin'` nas escritas: até a família virar, papel admin — o mesmo amortecedor
 * das outras rotas de escrita do paciente. Trilha (lex C9/C13): só nomes de container.
 */
export function createAdminTherapeuticProjectsRoutes(
  controller: AdminTherapeuticProjectsController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  const readTrail = (req: Request): string => therapeuticTrailAction('read_project', req.permissionCells ?? null);
  // Só a leitura de UMA versão pode ser export (lex C13): a lista com `?purpose=export` é leitura comum.
  const versionTrail = (req: Request): string =>
    therapeuticTrailAction(req.query.purpose === 'export' ? 'export_pdf' : 'read_project', req.permissionCells ?? null);
  const writeTrail = (req: Request): string => therapeuticTrailAction('write_project', req.permissionCells ?? null);

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
    perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'write', { untilEnforced: 'admin' }),
    logResourceAccess('patient', writeTrail),
    (req: Request, res: Response) => controller.create(req, res),
  );
  router.get(
    '/patients/:id/therapeutic-projects/:vid',
    staffOnly,
    perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'read'),
    logResourceAccess('patient', versionTrail),
    (req: Request, res: Response) => controller.get(req, res),
  );
  router.post(
    '/patients/:id/therapeutic-projects/:vid/annul',
    staffOnly,
    perm.require(THERAPEUTIC_PROJECT_RESOURCE, 'write', { untilEnforced: 'admin' }),
    logResourceAccess('patient', writeTrail),
    (req: Request, res: Response) => controller.annul(req, res),
  );

  // ── Catálogos: uma rota por catálogo, célula literal em cada uma ──────────────────────────
  for (const kind of THERAPEUTIC_CATALOG_KINDS) {
    const resource = THERAPEUTIC_CATALOG_RESOURCE[kind];
    router.get(`/therapeutic-catalogs/${kind}`, staffOnly, perm.require(resource, 'read'), (req: Request, res: Response) =>
      controller.listCatalog(kind, req, res),
    );
    router.post(`/therapeutic-catalogs/${kind}`, staffOnly, perm.require(resource, 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
      controller.createCatalogItem(kind, req, res),
    );
    router.patch(`/therapeutic-catalogs/${kind}/:itemId`, staffOnly, perm.require(resource, 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
      controller.updateCatalogItem(kind, req, res),
    );
  }

  return router;
}
