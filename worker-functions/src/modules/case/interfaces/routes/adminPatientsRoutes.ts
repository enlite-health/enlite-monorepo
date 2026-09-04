import { Router, Request, Response } from 'express';
import { AdminPatientsController } from '../controllers/AdminPatientsController';
import { AdminPatientChatIdsController } from '../controllers/AdminPatientChatIdsController';
import { AdminPatientChatRolesController } from '../controllers/AdminPatientChatRolesController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { requireCountryScope } from '@modules/identity/interfaces/middleware/countryScopeGuard';

/**
 * Admin patients routes — mounted at /api/admin.
 * All endpoints require staff authentication (same pattern as /api/admin/workers).
 *
 * NOTE: /patients/stats must be registered BEFORE any future /patients/:id
 * route to avoid Express param capture.
 *
 * ── Família `admin.patients` (task 3.5, a 2ª a declarar célula) ──────────────
 * Mapa rota→célula: `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 *
 * Três decisões de ORDEM dos guards, que são contrato e não estilo:
 *  1. `perm.require(...)` vem DEPOIS do guard de papel (staff/admin) e ANTES de
 *     `countryScope`. Quem não tem a célula não pode aprender, pela mensagem de
 *     erro, quais países têm grant — a negativa mais fundamental responde primeiro.
 *  2. `perm.require(...)` vem ANTES de `logResourceAccess`: acesso NEGADO não é
 *     acesso, e registrá-lo na trilha de leitura de ficha poluiria a auditoria da
 *     Candela com gente que nunca viu o dado (a negativa tem trilha própria, D-P4).
 *  3. Os guards de papel de hoje FICAM, além da célula: enquanto `admin.patients`
 *     não está em `PERMISSION_ENFORCED_ROUTES`, o papel é a única proteção. Tirar
 *     agora abriria a rota no intervalo entre o merge e a virada.
 *
 * ⚠️ `DELETE /patients/:id` exige `patient:delete` — célula NOVA (D116) que ainda
 * não existe em `iam.permissions` (o seed da 206 só tem read/write). Ela nasce
 * quando `PERMISSION_CATALOG_SYNC_ENABLED` ligar, no fim da task 3.5. Se o flip
 * do engine acontecesse ANTES desse sync, esta rota ficaria negada para todo
 * mundo, porque nenhum grupo poderia receber uma célula inexistente.
 */
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
export { ADMIN_PATIENTS_FAMILY };

export function createAdminPatientsRoutes(
  controller: AdminPatientsController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  // Sem valor default de propósito (mesmo padrão de `adminUsersRoutes`): com
  // `= new AdminPatientChatIdsController()` o caminho REAL de produção ficava
  // dentro da fábrica, onde teste unitário nenhum alcança — construir esses
  // controllers abre configuração de banco. Explícito no `src/index.ts`, o
  // wiring de produção é o mesmo e passa a ser visível.
  chatIdsController: AdminPatientChatIdsController,
  chatRolesController: AdminPatientChatRolesController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);
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
  //
  // Célula: o catálogo é PROPRIEDADE do paciente (rótulo da rede de apoio), não
  // um recurso próprio — por isso `patient:*` e não uma célula de configuração.
  router.get('/patient-chat-roles', staffOnly, perm.require('patient', 'read'), (req: Request, res: Response) =>
    chatRolesController.list(req, res),
  );
  router.post('/patient-chat-roles', adminOnly, perm.require('patient', 'write'), (req: Request, res: Response) =>
    chatRolesController.create(req, res),
  );
  router.patch(
    '/patient-chat-roles/:code',
    adminOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => chatRolesController.update(req, res),
  );
  router.delete(
    '/patient-chat-roles/:code',
    adminOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => chatRolesController.delete(req, res),
  );

  // ── Lista de TODOS os grupos que a org enxerga no Periskope ────────────────
  // FORA de /patients/* de propósito: não é recurso de paciente nenhum. Responde
  // "qual é o grupo da obra social?", que o /patients/:id/chat-candidates NÃO
  // pode responder — lá o ranqueamento é por semelhança com o nome do paciente,
  // e o grupo do pagador não se parece com paciente nenhum.
  //
  // Célula `messaging:read` (não `patient:read`) pelo mesmo motivo: o que sai
  // daqui é a lista de conversas da org, não dado de paciente.
  router.get('/chat-groups', staffOnly, perm.require('messaging', 'read'), (req: Request, res: Response) =>
    chatIdsController.getChatGroups(req, res),
  );

  // Static routes first (guard against future /:id capture)
  router.get(
    '/patients/stats',
    staffOnly,
    perm.require('patient', 'read'),
    countryScope,
    (req: Request, res: Response) => controller.getPatientStats(req, res),
  );

  // Funnel de conversão (Fase 4) — static, ANTES de /patients/:id.
  router.get(
    '/patients/funnel',
    staffOnly,
    perm.require('patient', 'read'),
    countryScope,
    (req: Request, res: Response) => controller.getPatientFunnel(req, res),
  );

  // Mapa Postgres <-> ClickUp <-> Periskope, em massa. ESTÁTICA, e por isso
  // registrada aqui em cima: se ficasse depois de /patients/:id, o Express
  // capturaria 'chat-map' como :id e devolveria 400 de UUID inválido.
  router.get('/patients/chat-map', staffOnly, perm.require('patient', 'read'), (req: Request, res: Response) =>
    chatIdsController.getChatMap(req, res),
  );

  router.get(
    '/patients',
    staffOnly,
    perm.require('patient', 'read'),
    countryScope,
    (req: Request, res: Response) => controller.listPatients(req, res),
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
    perm.require('patient', 'write'),
    requireCountryScope((req) => req.body?.country),
    (req: Request, res: Response) => controller.createPatient(req, res),
  );

  // Dynamic route last — Express would capture /stats as /:id otherwise.
  router.get(
    '/patients/:id',
    staffOnly,
    perm.require('patient', 'read'),
    logResourceAccess('patient'),
    (req: Request, res: Response) => controller.getPatientById(req, res),
  );

  // Patient addresses
  router.get(
    '/patients/:patientId/addresses',
    staffOnly,
    perm.require('patient', 'read'),
    (req: Request, res: Response) => controller.listPatientAddresses(req, res),
  );
  router.post(
    '/patients/:patientId/addresses',
    staffOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => controller.createPatientAddress(req, res),
  );

  // Patient vacancies — all job_postings for a patient, newest first
  //
  // Célula `vacancy:read`: o que a rota DEVOLVE é vaga. Quem enxerga a ficha do
  // paciente mas não o funil de vagas não deve receber a lista por esta porta —
  // seria um caminho lateral para a mesma informação (o :id aqui é só o filtro).
  router.get(
    '/patients/:id/vacancies',
    staffOnly,
    perm.require('vacancy', 'read'),
    (req: Request, res: Response) => controller.listPatientVacancies(req, res),
  );

  // ── Write / lifecycle (Fase 2 Task 3) ──────────────────────────────────────
  // Literal-second-segment routes first (status, activate) so they read clearly;
  // they never collide with the addresses/vacancies routes (distinct methods or
  // distinct literal segments). The fully-dynamic PATCH /:id/:section goes LAST —
  // it is PATCH-only (no other PATCH route exists) and its :section is validated
  // against a hard whitelist (general|clinical|support-network|service).

  // PUT /patients/:id/status — kanban move (change lifecycle status)
  router.put(
    '/patients/:id/status',
    staffOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => controller.updatePatientStatus(req, res),
  );

  // POST /patients/:id/activate — approve → generate one draft vacancy per location
  router.post(
    '/patients/:id/activate',
    staffOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => controller.activatePatient(req, res),
  );

  // ── Chat IDs do Periskope (tasks 86ajy0859 / 86ajy085a) ────────────────────
  // GET  candidatos: leitura no Periskope, atrás de PATIENT_CHAT_LOOKUP_ENABLED.
  // PUT  chat-ids:   grava o par escolhido pelo humano.
  // PUT (não PATCH) de propósito: o PATCH /:id/:section é fully-dynamic e
  // capturaria 'chat-ids' como :section, devolvendo 400 pelo whitelist.
  //
  // Células assimétricas de propósito: LER candidatos é varrer conversas do
  // Periskope (`messaging:read`); GRAVAR o par escolhido muda o CADASTRO do
  // paciente (`patient:write`).
  router.get(
    '/patients/:id/chat-candidates',
    staffOnly,
    perm.require('messaging', 'read'),
    (req: Request, res: Response) => chatIdsController.getChatCandidates(req, res),
  );
  router.put(
    '/patients/:id/chat-ids',
    staffOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => chatIdsController.updateChatIds(req, res),
  );

  // ── Synthetic monitoring (e2e-prod) ────────────────────────────────────────
  // Literais ANTES do PATCH dinâmico /:id/:section — senão 'test-flag' seria
  // capturado como :section e barrado pelo whitelist.
  router.patch(
    '/patients/:id/test-flag',
    adminOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => controller.updatePatientTestFlag(req, res),
  );
  // Purga só de paciente is_test (real → 409). Ver PatientTestFixtureService.
  //
  // ⚠️ `patient:delete` é a célula NOVA da D116 (ver cabeçalho): não existe em
  // `iam.permissions` até o sync do catálogo ligar.
  router.delete(
    '/patients/:id',
    adminOnly,
    perm.require('patient', 'delete'),
    (req: Request, res: Response) => controller.purgeTestPatient(req, res),
  );

  // PATCH /patients/:id/:section — section-scoped partial edit (last: fully dynamic)
  router.patch(
    '/patients/:id/:section',
    staffOnly,
    perm.require('patient', 'write'),
    (req: Request, res: Response) => controller.updatePatientSection(req, res),
  );

  return router;
}
