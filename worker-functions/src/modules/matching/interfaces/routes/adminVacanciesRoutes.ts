import { Router, Request, Response } from 'express';
import { VacanciesController } from '../controllers/VacanciesController';
import { VacanciesAuxController } from '../controllers/VacanciesAuxController';
import { VacancyTalentumController } from '../controllers/VacancyTalentumController';
import { VacancyMatchController } from '../controllers/VacancyMatchController';
import { VacancyMeetLinksController } from '../controllers/VacancyMeetLinksController';
import { WJAFunnelController } from '../controllers/WJAFunnelController';
import { WJAFunnelTableController } from '../controllers/WJAFunnelTableController';
import { WJAContactNotesController } from '../controllers/WJAContactNotesController';
import { EncuadreDashboardController } from '../controllers/EncuadreDashboardController';
import { VacancyCrudController } from '../controllers/VacancyCrudController';
import { VacancySocialLinksController } from '../controllers/VacancySocialLinksController';
import { InterviewSlotsController } from '../controllers/InterviewSlotsController';
import { VacancyAddressReviewController } from '../controllers/VacancyAddressReviewController';
import { WorkerVacancyDeliveryStatusController } from '../controllers/WorkerVacancyDeliveryStatusController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';

/**
 * Admin vacancies routes — /api/admin/vacancies/* and related encuadre/funnel/slots.
 * All endpoints require staff authentication.
 *
 * IMPORTANTE: rotas estáticas antes das dinâmicas (ex: /stats, /next-vacancy-number
 * antes de /:id) para evitar captura pelo param.
 *
 * ── Família `admin.vacancies` (task 3.5, a 4ª e MAIOR) ──────────────────────
 * 45 rotas, 16 células, um arquivo só. Mapa rota→célula:
 * `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 * As 16 células já existem no seed da migration 206 (medido) — como `admin.workers`
 * e ao contrário de `admin.patients`, esta família NÃO depende de
 * `PERMISSION_CATALOG_SYNC_ENABLED`.
 *
 * Ordem dos guards, igual às três famílias anteriores (contrato, não estilo):
 * papel → célula. Os guards de papel de hoje FICAM: enquanto a família está fora
 * de `PERMISSION_ENFORCED_ROUTES`, o papel é a única proteção.
 *
 * ⚠️ DUAS rotas ficam atrás de controller OPCIONAL (`vacancyAddressReviewController`,
 * `funnelTableController`): se o `src/index.ts` deixar de injetá-los, as rotas
 * somem do router E da varredura do catálogo. O teste unit monta com os dois,
 * porque é assim que produção monta.
 *
 * ⚠️ QUESTÃO DE POLÍTICA ABERTA, medida em 19/08 e endereçada ao Marcel/Gabriel
 * (NÃO resolvida aqui): quatro destas rotas devolvem **nome descriptografado por
 * KMS + telefone** do prestador sob célula que não é `worker_pii` —
 * `:id/funnel` e `:id/funnel-table` (`funnel:read`), `:id/match-results`
 * (`match:read`) e `GET /vacancies/:id` (`vacancy:read`, que embute os encuadres).
 * O mapa foi seguido porque a leitura coerente é que `worker_pii:read` protege o
 * DOSSIÊ (DNI, nascimento, raça, religião, orientação, documentos) e não o
 * contato operacional — mas isso nunca foi escrito. Se a resposta for o
 * contrário, estas quatro precisam de redação de campo, não de célula mais forte:
 * exigir `worker_pii:read` no Kanban daria a célula a todo recrutador e a
 * esvaziaria. Ver o handoff da change.
 */
import { ADMIN_VACANCIES_FAMILY } from '@modules/identity/permissions';
export { ADMIN_VACANCIES_FAMILY };
export function createAdminVacanciesRoutes(
  vacanciesController: VacanciesController,
  vacancyCrudController: VacancyCrudController,
  vacancyTalentumController: VacancyTalentumController,
  vacancyMatchController: VacancyMatchController,
  vacancyMeetLinksController: VacancyMeetLinksController,
  vacancySocialLinksController: VacancySocialLinksController,
  funnelController: WJAFunnelController,
  dashboardController: EncuadreDashboardController,
  interviewSlotsController: InterviewSlotsController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  vacancyAddressReviewController?: VacancyAddressReviewController,
  funnelTableController?: WJAFunnelTableController,
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_VACANCIES_FAMILY);

  // Auxiliary controller is instantiated internally — it has no injectable deps.
  const auxController = new VacanciesAuxController();

  // ── Read (VacanciesController) ────────────────────────────────────────────────
  router.get('/vacancies', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    vacanciesController.listVacancies(req, res),
  );
  router.get('/vacancies/stats', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    vacanciesController.getVacanciesStats(req, res),
  );
  router.get('/vacancies/next-vacancy-number', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    vacanciesController.getNextVacancyNumber(req, res),
  );
  // IMPORTANTE: static before /:id to avoid param capture
  router.get('/vacancies/cases-for-select', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    vacanciesController.getCasesForSelect(req, res),
  );
  // ── Auxiliary read (VacanciesAuxController) ───────────────────────────────────
  router.get('/vacancies/filter-options', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    auxController.getFilterOptions(req, res),
  );
  router.get('/vacancies/pending-address-review', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    auxController.listPendingAddressReview(req, res),
  );
  router.get('/vacancies/in-progress', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    auxController.listInProgressForPatient(req, res),
  );
  router.get('/vacancies/by-address', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    auxController.listByAddress(req, res),
  );
  router.get('/vacancies/:id', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    vacanciesController.getVacancyById(req, res),
  );

  // ── CRUD (VacancyCrudController) ─────────────────────────────────────────────
  router.post('/vacancies', authMiddleware.requireStaff(), perm.require('vacancy', 'write'), (req: Request, res: Response) =>
    vacancyCrudController.createVacancy(req, res),
  );
  router.put('/vacancies/:id', authMiddleware.requireStaff(), perm.require('vacancy', 'write'), (req: Request, res: Response) =>
    vacancyCrudController.updateVacancy(req, res),
  );
  router.delete('/vacancies/:id', authMiddleware.requireStaff(), perm.require('vacancy', 'delete'), (req: Request, res: Response) =>
    vacancyCrudController.deleteVacancy(req, res),
  );
  if (vacancyAddressReviewController) {
    router.post('/vacancies/:id/resolve-address-review', authMiddleware.requireStaff(), perm.require('vacancy', 'write'), (req: Request, res: Response) =>
      vacancyAddressReviewController!.resolveAddressReview(req, res),
    );
  }

  // ── Match (VacancyMatchController) ────────────────────────────────────────────
  router.get('/vacancies/:id/match-results', authMiddleware.requireStaff(), perm.require('match', 'read'), (req: Request, res: Response) =>
    vacancyMatchController.getMatchResults(req, res),
  );
  router.post('/vacancies/:id/match', authMiddleware.requireStaff(), perm.require('match', 'execute'), (req: Request, res: Response) =>
    vacancyMatchController.triggerMatch(req, res),
  );
  router.put('/encuadres/:id/result', authMiddleware.requireStaff(), perm.require('funnel', 'write'), (req: Request, res: Response) =>
    vacancyMatchController.updateEncuadreResult(req, res),
  );

  // ── Talentum (VacancyTalentumController) ─────────────────────────────────────
  router.post('/vacancies/:id/publish-talentum', authMiddleware.requireStaff(), perm.require('talentum', 'write'), (req: Request, res: Response) =>
    vacancyTalentumController.publishToTalentum(req, res),
  );
  router.delete('/vacancies/:id/publish-talentum', authMiddleware.requireStaff(), perm.require('talentum', 'write'), (req: Request, res: Response) =>
    vacancyTalentumController.unpublishFromTalentum(req, res),
  );
  router.post('/vacancies/:id/generate-talentum-description', authMiddleware.requireStaff(), perm.require('talentum', 'write'), (req: Request, res: Response) =>
    vacancyTalentumController.generateTalentumDescription(req, res),
  );
  router.put('/vacancies/:id/talentum-description', authMiddleware.requireStaff(), perm.require('talentum', 'write'), (req: Request, res: Response) =>
    vacancyTalentumController.updateTalentumDescription(req, res),
  );
  router.post('/vacancies/:id/generate-ai-content', authMiddleware.requireStaff(), perm.require('vacancy', 'write'), (req: Request, res: Response) =>
    vacancyTalentumController.generateAIContent(req, res),
  );
  router.post('/vacancies/sync-talentum', authMiddleware.requireStaff(), perm.require('talentum', 'write'), (req: Request, res: Response) =>
    vacancyTalentumController.syncFromTalentum(req, res),
  );
  router.get('/vacancies/:id/prescreening-config', authMiddleware.requireStaff(), perm.require('prescreening', 'read'), (req: Request, res: Response) =>
    vacancyTalentumController.getPrescreeningConfig(req, res),
  );
  router.get('/vacancies/:id/talentum-status', authMiddleware.requireStaff(), perm.require('talentum', 'read'), (req: Request, res: Response) =>
    vacancyTalentumController.getTalentumStatus(req, res),
  );
  router.post('/vacancies/:id/prescreening-config', authMiddleware.requireStaff(), perm.require('prescreening', 'write'), (req: Request, res: Response) =>
    vacancyTalentumController.savePrescreeningConfig(req, res),
  );

  // ── Meet Links (VacancyMeetLinksController) ───────────────────────────────────
  // Static lookup route MUST come before dynamic /:id/meet-links to prevent the
  // express router from treating "meet-links" as the :id param.
  router.post('/vacancies/meet-links/lookup', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    vacancyMeetLinksController.lookupMeetDatetime(req, res),
  );
  router.put('/vacancies/:id/meet-links', authMiddleware.requireStaff(), perm.require('vacancy', 'write'), (req: Request, res: Response) =>
    vacancyMeetLinksController.updateMeetLinks(req, res),
  );

  // ── Social Short Links (VacancySocialLinksController) ────────────────────────
  router.post('/vacancies/:id/social-links', authMiddleware.requireStaff(), perm.require('vacancy', 'write'), (req: Request, res: Response) =>
    vacancySocialLinksController.generateSocialLink(req, res),
  );
  router.get('/vacancies/:id/social-links-stats', authMiddleware.requireStaff(), perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    vacancySocialLinksController.getSocialLinksStats(req, res),
  );

  // ── Encuadre Funnel / Kanban (WJAFunnelController) ───────────────────────────
  router.get('/vacancies/:id/funnel', authMiddleware.requireStaff(), perm.require('funnel', 'read'), (req: Request, res: Response) =>
    funnelController.getEncuadreFunnel(req, res),
  );
  router.put('/encuadres/:id/move', authMiddleware.requireStaff(), perm.require('funnel', 'write'), (req: Request, res: Response) =>
    funnelController.moveEncuadre(req, res),
  );
  // "Rechazar" de um card BLOQUEADO (soft-dismiss): sai de BLOQUEADO, vai p/ RECHAZADOS
  // como card de bloqueado. Segmento próprio (não colide com /vacancies/:id).
  router.post('/vacancies/blocked-applications/:blockedId/reject', authMiddleware.requireStaff(), perm.require('funnel', 'write'), (req: Request, res: Response) =>
    funnelController.rejectBlockedApplication(req, res),
  );
  // "Voltar a bloqueados": desfaz o rechazo (RECHAZADOS → BLOQUEADO).
  router.post('/vacancies/blocked-applications/:blockedId/restore', authMiddleware.requireStaff(), perm.require('funnel', 'write'), (req: Request, res: Response) =>
    funnelController.undismissBlockedApplication(req, res),
  );

  // ── Encuadre Funnel Table — audit table (WJAFunnelTableController) ───────────
  if (funnelTableController) {
    router.get('/vacancies/:id/funnel-table', authMiddleware.requireStaff(), perm.require('funnel', 'read'), (req: Request, res: Response) =>
      funnelTableController!.getEncuadreFunnelTable(req, res),
    );
  }

  // ── Coordinator Dashboard (EncuadreDashboardController) ──────────────────────
  router.get('/dashboard/coordinator-capacity', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    dashboardController.getCoordinatorCapacity(req, res),
  );
  router.get('/dashboard/alerts', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    dashboardController.getAlerts(req, res),
  );
  router.get('/dashboard/conversion-by-channel', authMiddleware.requireStaff(), perm.require('dashboard', 'read'), (req: Request, res: Response) =>
    dashboardController.getConversionByChannel(req, res),
  );

  // ── Interview Slots (InterviewSlotsController) ────────────────────────────────
  router.post('/vacancies/:id/interview-slots', authMiddleware.requireStaff(), perm.require('interview', 'write'), (req: Request, res: Response) =>
    interviewSlotsController.createSlots(req, res),
  );
  router.get('/vacancies/:id/interview-slots', authMiddleware.requireStaff(), perm.require('interview', 'read'), (req: Request, res: Response) =>
    interviewSlotsController.getSlots(req, res),
  );
  router.post('/interview-slots/:slotId/book', authMiddleware.requireStaff(), perm.require('interview', 'write'), (req: Request, res: Response) =>
    interviewSlotsController.bookSlot(req, res),
  );
  router.delete('/interview-slots/:slotId', authMiddleware.requireStaff(), perm.require('interview', 'delete'), (req: Request, res: Response) =>
    interviewSlotsController.cancelSlot(req, res),
  );

  // ── Worker Contact Notes (WJAContactNotesController) ─────────────────────────
  // Chave: par estável (worker_id, job_posting_id) — migration 235. Sobrevive
  // à promoção BLOQUEADO→INICIADO, então cards ainda bloqueados (sem WJA)
  // também podem ter notas.
  const contactNotesController = new WJAContactNotesController();
  router.get(
    '/vacancies/:vacancyId/workers/:workerId/contact-notes',
    authMiddleware.requireStaff(),
    perm.require('funnel', 'read'),
    (req: Request, res: Response) => contactNotesController.list(req, res),
  );
  router.post(
    '/vacancies/:vacancyId/workers/:workerId/contact-notes',
    authMiddleware.requireStaff(),
    perm.require('funnel', 'write'),
    (req: Request, res: Response) => contactNotesController.create(req, res),
  );
  router.delete(
    '/vacancies/:vacancyId/workers/:workerId/contact-notes/:noteId',
    authMiddleware.requireStaff(),
    perm.require('funnel', 'write'),
    (req: Request, res: Response) => contactNotesController.delete(req, res),
  );

  // ── Delivery Status (WorkerVacancyDeliveryStatusController) ──────────────────
  // READ-ONLY: wjaStage + status de entrega (messaging_outbox) do par
  // (worker, vaga). Usado pelo E2E do funil de WhatsApp pra verificar
  // entrega sem tocar no banco direto.
  const deliveryStatusController = new WorkerVacancyDeliveryStatusController();
  router.get(
    '/vacancies/:vacancyId/workers/:workerId/delivery-status',
    authMiddleware.requireStaff(),
    perm.require('messaging', 'read'),
    (req: Request, res: Response) => deliveryStatusController.getDeliveryStatus(req, res),
  );

  return router;
}
