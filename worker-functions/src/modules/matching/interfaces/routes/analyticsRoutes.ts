import { Router, Request, Response } from 'express';
import { AnalyticsController } from '../controllers/AnalyticsController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';

/**
 * Analytics & BI routes — /analytics/*
 * Todos os endpoints exigem autenticação de staff.
 * IMPORTANTE: rotas estáticas antes das dinâmicas para evitar captura pelo param.
 *
 * ── Família `admin.analytics` (task 3.5-A3) ─────────────────────────────────
 * 15 rotas, 4 células, todas já no seed da migration 206 (medido) — a família
 * NÃO depende de `PERMISSION_CATALOG_SYNC_ENABLED`. Mapa rota→célula:
 * `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 * Ordem dos guards igual às famílias anteriores: staff → célula. O papel deixou
 * de ser nível (07/09): o que era `requireAdmin()` virou `untilEnforced: 'admin'`
 * na célula, e só vale enquanto a família está fora de `PERMISSION_ENFORCED_ROUTES`.
 *
 * ⚠️ `POST /dedup/run` é `dedup:execute` — a célula destrutiva da família
 * `admin.dedup` (A5) aparece AQUI. Ela fica nesta família de propósito: família
 * é o que `PERMISSION_ENFORCED_ROUTES` liga, e mover uma rota de família por
 * causa da célula quebraria essa correspondência. Até a família virar, a rota
 * segue exigindo papel `admin` (`untilEnforced`), mais estrito que o resto do arquivo.
 *
 * ⚠️ QUESTÃO DE POLÍTICA ABERTA (a mesma do #238, aqui mais afiada) — endereçada
 * ao Gabriel, NÃO resolvida neste PR: **três rotas devolvem e-mail, telefone e
 * nome do prestador sob `analytics:read`** — `/workers/missing-documents`
 * (`WorkerMissingDocs`), `/vacancies/:id/incomplete-registrations`
 * (`WorkerRegistrationStatus`, que ainda traz `patientName` nas outras vagas) e
 * `/workers/:workerId/vacancies` (`WorkerVacancyEngagement`). É mais surpreendente
 * que no #238: `funnel:read` ao menos sugere ver candidatos, `analytics:read`
 * sugere ver NÚMEROS. Segui o mapa pela mesma leitura (a célula `worker_pii:read`
 * protege o DOSSIÊ, não o contato operacional); se a resposta for o contrário, o
 * conserto aqui também é redação de campo. Ver o handoff da change.
 */
import { ADMIN_ANALYTICS_FAMILY } from '@modules/identity/permissions';
export { ADMIN_ANALYTICS_FAMILY };

export function createAnalyticsRoutes(
  analyticsController: AnalyticsController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_ANALYTICS_FAMILY);

  router.get('/workers', authMiddleware.requireStaff(), perm.require('analytics', 'read'), (req: Request, res: Response) =>
    analyticsController.getWorkerStats(req, res),
  );

  router.get('/workers/missing-documents', authMiddleware.requireStaff(), perm.require('analytics', 'read'), (req: Request, res: Response) =>
    analyticsController.getWorkersMissingDocuments(req, res),
  );

  router.get('/workers/:workerId/vacancies', authMiddleware.requireStaff(), perm.require('analytics', 'read'), (req: Request, res: Response) =>
    analyticsController.getWorkerVacancyEngagement(req, res),
  );

  router.get('/vacancies', authMiddleware.requireStaff(), perm.require('analytics', 'read'), (req: Request, res: Response) =>
    analyticsController.listVacancies(req, res),
  );

  // Estática /case/:caseNumber antes da dinâmica /:id
  router.get('/vacancies/case/:caseNumber', authMiddleware.requireStaff(), perm.require('analytics', 'read'), (req: Request, res: Response) =>
    analyticsController.getVacancyByCaseNumber(req, res),
  );

  router.get('/vacancies/:id/incomplete-registrations', authMiddleware.requireStaff(), perm.require('analytics', 'read'), (req: Request, res: Response) =>
    analyticsController.getVacancyIncompleteRegistrations(req, res),
  );

  router.get('/vacancies/:id', authMiddleware.requireStaff(), perm.require('analytics', 'read'), (req: Request, res: Response) =>
    analyticsController.getVacancyById(req, res),
  );

  router.get('/dedup/candidates', authMiddleware.requireStaff(), perm.require('dedup', 'read'), (req: Request, res: Response) =>
    analyticsController.getDedupCandidates(req, res),
  );

  router.post('/dedup/run', authMiddleware.requireStaff(), perm.require('dedup', 'execute', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    analyticsController.runDeduplication(req, res),
  );

  // Dashboard endpoints — estáticas /global, /zones, /reemplazos antes da paramétrica /cases/:caseNumber
  router.get('/dashboard/global', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    analyticsController.getGlobalMetrics(req, res),
  );

  router.get('/dashboard/zones', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    analyticsController.getZoneMetrics(req, res),
  );

  router.get('/dashboard/reemplazos', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    analyticsController.getReemplazosMetrics(req, res),
  );

  router.get('/dashboard/management', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    analyticsController.getManagementMetrics(req, res),
  );

  // D286: o bloco Zonas da Gestión a la Vista é rota própria → célula própria (dashboard_zones:read).
  router.get('/dashboard/zone-analytics', authMiddleware.requireStaff(), perm.require('dashboard_zones', 'read'), (req: Request, res: Response) =>
    analyticsController.getZoneAnalytics(req, res),
  );

  router.get('/dashboard/cases/:caseNumber', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    analyticsController.getCaseMetrics(req, res),
  );

  return router;
}
