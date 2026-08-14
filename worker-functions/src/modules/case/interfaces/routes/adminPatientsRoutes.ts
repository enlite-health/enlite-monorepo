import { Router, Request, Response } from 'express';
import { AdminPatientsController } from '../controllers/AdminPatientsController';
import { AdminPatientChatIdsController } from '../controllers/AdminPatientChatIdsController';
import { AdminPatientChatRolesController } from '../controllers/AdminPatientChatRolesController';
import { AuthMiddleware } from '@modules/identity';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { requireCountryScope } from '@shared/database/countryScopeGuard';

/**
 * Admin patients routes — mounted at /api/admin.
 * All endpoints require staff authentication (same pattern as /api/admin/workers).
 *
 * NOTE: /patients/stats must be registered BEFORE any future /patients/:id
 * route to avoid Express param capture.
 */
export function createAdminPatientsRoutes(
  controller: AdminPatientsController,
  authMiddleware: AuthMiddleware,
  chatIdsController: AdminPatientChatIdsController = new AdminPatientChatIdsController(),
  chatRolesController: AdminPatientChatRolesController = new AdminPatientChatRolesController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  // Cortesia de UX sobre a RLS: `?country=` de outro país sem grant explica em
  // vez de devolver contadores zerados (task 3.5). Inerte com a flag off.
  const countryScope = requireCountryScope();
  // test-flag e purge são admin-only (mais estrito que staff) — mesmo critério
  // do equivalente em workers. São ferramentas do synthetic monitoring.
  const adminOnly = authMiddleware.requireAdmin();

  // ── CATÁLOGO de papéis de chat (migration 262) ─────────────────────────────
  // LEITURA é staff: a ficha de qualquer paciente precisa dos RÓTULOS dos
  // papéis para renderizar, e quem abre ficha é staff, não só admin.
  // ESCRITA é admin: mudar o catálogo muda a política de unicidade de TODOS os
  // pacientes de uma vez (é a trava da auditoria da Candela) — não é edição de
  // um registro, é configuração do sistema.
  //
  // Registradas ANTES de /patients/* só por clareza de leitura; o caminho
  // '/patient-chat-roles' não colide com '/patients/:id' (segmentos distintos).
  router.get('/patient-chat-roles', staffOnly, (req: Request, res: Response) =>
    chatRolesController.list(req, res),
  );
  router.post('/patient-chat-roles', adminOnly, (req: Request, res: Response) =>
    chatRolesController.create(req, res),
  );
  router.patch('/patient-chat-roles/:code', adminOnly, (req: Request, res: Response) =>
    chatRolesController.update(req, res),
  );
  router.delete('/patient-chat-roles/:code', adminOnly, (req: Request, res: Response) =>
    chatRolesController.delete(req, res),
  );

  // ── Lista de TODOS os grupos que a org enxerga no Periskope ────────────────
  // FORA de /patients/* de propósito: não é recurso de paciente nenhum. Responde
  // "qual é o grupo da obra social?", que o /patients/:id/chat-candidates NÃO
  // pode responder — lá o ranqueamento é por semelhança com o nome do paciente,
  // e o grupo do pagador não se parece com paciente nenhum.
  router.get('/chat-groups', staffOnly, (req: Request, res: Response) =>
    chatIdsController.getChatGroups(req, res),
  );

  // Static routes first (guard against future /:id capture)
  router.get('/patients/stats', staffOnly, countryScope, (req: Request, res: Response) =>
    controller.getPatientStats(req, res),
  );

  // Funnel de conversão (Fase 4) — static, ANTES de /patients/:id.
  router.get('/patients/funnel', staffOnly, countryScope, (req: Request, res: Response) =>
    controller.getPatientFunnel(req, res),
  );

  // Mapa Postgres <-> ClickUp <-> Periskope, em massa. ESTÁTICA, e por isso
  // registrada aqui em cima: se ficasse depois de /patients/:id, o Express
  // capturaria 'chat-map' como :id e devolveria 400 de UUID inválido.
  router.get('/patients/chat-map', staffOnly, (req: Request, res: Response) =>
    chatIdsController.getChatMap(req, res),
  );

  router.get('/patients', staffOnly, countryScope, (req: Request, res: Response) =>
    controller.listPatients(req, res),
  );

  // Manual creation of a native patient (admission team). No :id in the path,
  // so it is safe here; POST does not collide with the GET /:id capture.
  //
  // O país vem do BODY aqui (não da query): criar paciente para outro país é o
  // mesmo pedido cross-país do `?country=`, e sem o guard viraria um INSERT que
  // a policy recusa com erro cru de RLS em vez de explicar.
  router.post(
    '/patients',
    staffOnly,
    requireCountryScope((req) => req.body?.country),
    (req: Request, res: Response) => controller.createPatient(req, res),
  );

  // Dynamic route last — Express would capture /stats as /:id otherwise.
  router.get('/patients/:id', staffOnly, logResourceAccess('patient'), (req: Request, res: Response) =>
    controller.getPatientById(req, res),
  );

  // Patient addresses
  router.get('/patients/:patientId/addresses', staffOnly, (req: Request, res: Response) =>
    controller.listPatientAddresses(req, res),
  );
  router.post('/patients/:patientId/addresses', staffOnly, (req: Request, res: Response) =>
    controller.createPatientAddress(req, res),
  );

  // Patient vacancies — all job_postings for a patient, newest first
  router.get('/patients/:id/vacancies', staffOnly, (req: Request, res: Response) =>
    controller.listPatientVacancies(req, res),
  );

  // ── Write / lifecycle (Fase 2 Task 3) ──────────────────────────────────────
  // Literal-second-segment routes first (status, activate) so they read clearly;
  // they never collide with the addresses/vacancies routes (distinct methods or
  // distinct literal segments). The fully-dynamic PATCH /:id/:section goes LAST —
  // it is PATCH-only (no other PATCH route exists) and its :section is validated
  // against a hard whitelist (general|clinical|support-network|service).

  // PUT /patients/:id/status — kanban move (change lifecycle status)
  router.put('/patients/:id/status', staffOnly, (req: Request, res: Response) =>
    controller.updatePatientStatus(req, res),
  );

  // POST /patients/:id/activate — approve → generate one draft vacancy per location
  router.post('/patients/:id/activate', staffOnly, (req: Request, res: Response) =>
    controller.activatePatient(req, res),
  );

  // ── Chat IDs do Periskope (tasks 86ajy0859 / 86ajy085a) ────────────────────
  // GET  candidatos: leitura no Periskope, atrás de PATIENT_CHAT_LOOKUP_ENABLED.
  // PUT  chat-ids:   grava o par escolhido pelo humano.
  // PUT (não PATCH) de propósito: o PATCH /:id/:section é fully-dynamic e
  // capturaria 'chat-ids' como :section, devolvendo 400 pelo whitelist.
  router.get('/patients/:id/chat-candidates', staffOnly, (req: Request, res: Response) =>
    chatIdsController.getChatCandidates(req, res),
  );
  router.put('/patients/:id/chat-ids', staffOnly, (req: Request, res: Response) =>
    chatIdsController.updateChatIds(req, res),
  );

  // ── Synthetic monitoring (e2e-prod) ────────────────────────────────────────
  // Literais ANTES do PATCH dinâmico /:id/:section — senão 'test-flag' seria
  // capturado como :section e barrado pelo whitelist.
  router.patch('/patients/:id/test-flag', adminOnly, (req: Request, res: Response) =>
    controller.updatePatientTestFlag(req, res),
  );
  // Purga só de paciente is_test (real → 409). Ver PatientTestFixtureService.
  router.delete('/patients/:id', adminOnly, (req: Request, res: Response) =>
    controller.purgeTestPatient(req, res),
  );

  // PATCH /patients/:id/:section — section-scoped partial edit (last: fully dynamic)
  router.patch('/patients/:id/:section', staffOnly, (req: Request, res: Response) =>
    controller.updatePatientSection(req, res),
  );

  return router;
}
