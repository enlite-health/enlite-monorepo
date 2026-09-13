import { Router, Request, Response } from 'express';
import { AdminPatientsController } from '../controllers/AdminPatientsController';
import { AdminPatientChatIdsController } from '../controllers/AdminPatientChatIdsController';
import { AdminPatientChatRolesController } from '../controllers/AdminPatientChatRolesController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { requireCountryScope } from '@modules/identity/interfaces/middleware/countryScopeGuard';
import { AdminPatientsMapController } from '../controllers/AdminPatientsMapController';
import { AdminPatientAddressesController } from '../controllers/AdminPatientAddressesController';
import { AdminInsuranceProvidersController } from '../controllers/AdminInsuranceProvidersController';
import { AdminPatientContractedServicesController } from '../controllers/AdminPatientContractedServicesController';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { AdminPatientContactRowsController } from '../controllers/AdminPatientContactRowsController';
import { AdminPatientExternalContactsController } from '../controllers/AdminPatientExternalContactsController';
import { AdminPatientEmergencyContactController } from '../controllers/AdminPatientEmergencyContactController';

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
 * ⚠️ Rotas que o `main` trouxe DEPOIS da declaração da família (endereços por
 * logística, coberturas, serviço contratado, diagnósticos CID-11, terminologia,
 * mapa) entram aqui sob a célula GROSSA (`patient:read`/`patient:write`) para o
 * inventário do deny-when-undeclared fechar no sync main→stage. O fatiamento por
 * CONTAINER (D286: `patient_diagnosis:*`, `patient_services:*`, …) é a change
 * seguinte, não este merge.
 */
import { ADMIN_PATIENTS_FAMILY, ADMIN_VACANCIES_FAMILY } from '@modules/identity/permissions';
import { patientDetailTrailOf } from '../../application/patientContainerAccess';
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
  mapController: AdminPatientsMapController,
  addressesController: AdminPatientAddressesController,
  insuranceProvidersController: AdminInsuranceProvidersController,
  contractedServicesController: AdminPatientContractedServicesController,
  diagnosesController: AdminPatientDiagnosesController,
  terminologySearchController: AdminTerminologySearchController,
  // Escrita por linha (spec 018, PR-1). Default de propósito, mesmo padrão do `repo` default de
  // `AdminPatientContractedServicesController` — evita reescrever os 6 call sites de teste que já
  // existem para este factory. `DatabaseConnection.getInstance()` roda na CONSTRUÇÃO (pega o pool
  // singleton do processo, não abre conexão nova) — em produção o singleton já existe quando o
  // `index.ts` monta as rotas; testes que constroem o factory sem DB configurado precisam de
  // `DATABASE_URL` no ambiente só para o `new` não estourar (nenhuma query roda aqui).
  contactRowsController: AdminPatientContactRowsController = new AdminPatientContactRowsController(),
  // Contatos externos + marca de emergência (spec 018, PR-2). Mesmo padrão de default acima.
  externalContactsController: AdminPatientExternalContactsController = new AdminPatientExternalContactsController(),
  emergencyContactController: AdminPatientEmergencyContactController = new AdminPatientEmergencyContactController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);
  // SUP-19 (contracts/activation.md): ativar recrutamento também exige `vacancy:write` — quem cria
  // uma vaga (mesmo em rascunho) passa pela família de VAGAS, não só pela de pacientes.
  const permVacancy = permissions.family(ADMIN_VACANCIES_FAMILY);
  // Cortesia de UX sobre a RLS: `?country=` de outro país sem grant explica em
  // vez de devolver contadores zerados (task 3.5). Inerte com a flag off.
  const countryScope = requireCountryScope();
  // test-flag e purge: célula decide; até a família virar, papel `admin` (mais estrito que staff) — mesmo critério
  // do equivalente em workers. São ferramentas do synthetic monitoring.

  // ── CATÁLOGO de papéis de chat (migration 262) ─────────────────────────────
  // LEITURA é staff: a ficha de qualquer paciente precisa dos RÓTULOS dos
  // papéis para renderizar, e quem abre ficha é staff, não só admin.
  // ESCRITA é admin: mudar o catálogo muda a política de unicidade de TODOS os
  // pacientes de uma vez (é a trava da auditoria da Candela) — não é edição de
  // um registro, é configuração do sistema.
  //
  // Registradas ANTES de /patients/* só por clareza de leitura; o caminho
  // '/patient-chat-roles' não colide com '/patients/:id' (segmentos distintos).
  router.get('/patient-chat-roles', staffOnly, perm.require('patient', 'read'), (req: Request, res: Response) =>
    chatRolesController.list(req, res),
  );
  router.post('/patient-chat-roles', staffOnly, perm.require('patient', 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    chatRolesController.create(req, res),
  );
  router.patch('/patient-chat-roles/:code', staffOnly, perm.require('patient', 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    chatRolesController.update(req, res),
  );
  router.delete('/patient-chat-roles/:code', staffOnly, perm.require('patient', 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    chatRolesController.delete(req, res),
  );

  // ── CATÁLOGO de coberturas (migration 311; spec 012, US-B3) ────────────────
  // Mesma régua dos papéis de chat: LEITURA é staff (o drawer precisa dos códigos), ESCRITA é
  // admin (muda o vocabulário de todos os pacientes). Sem tela. Caminho fora de /patients/*.
  router.get('/catalogs/insurance-providers', staffOnly, perm.require('patient_coverage', 'read'), (req: Request, res: Response) =>
    insuranceProvidersController.list(req, res),
  );
  router.post('/catalogs/insurance-providers', staffOnly, perm.require('patient', 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    insuranceProvidersController.create(req, res),
  );

  // ── Lista de TODOS os grupos que a org enxerga no Periskope ────────────────
  // FORA de /patients/* de propósito: não é recurso de paciente nenhum. Responde
  // "qual é o grupo da obra social?", que o /patients/:id/chat-candidates NÃO
  // pode responder — lá o ranqueamento é por semelhança com o nome do paciente,
  // e o grupo do pagador não se parece com paciente nenhum.
  router.get('/chat-groups', staffOnly, perm.require('messaging', 'read'), (req: Request, res: Response) =>
    chatIdsController.getChatGroups(req, res),
  );

  // Static routes first (guard against future /:id capture)
  router.get('/patients/stats', staffOnly, perm.require('patient', 'read'), countryScope, (req: Request, res: Response) =>
    controller.getPatientStats(req, res),
  );

  // Funnel de conversão (Fase 4) — static, ANTES de /patients/:id.
  router.get('/patients/funnel', staffOnly, perm.require('patient', 'read'), countryScope, (req: Request, res: Response) =>
    controller.getPatientFunnel(req, res),
  );

  // Mapa Postgres <-> ClickUp <-> Periskope, em massa. ESTÁTICA, e por isso
  // registrada aqui em cima: se ficasse depois de /patients/:id, o Express
  // capturaria 'chat-map' como :id e devolveria 400 de UUID inválido.
  router.get('/patients/chat-map', staffOnly, perm.require('patient', 'read'), (req: Request, res: Response) =>
    chatIdsController.getChatMap(req, res),
  );

  // Pontos do mapa de pacientes (REQ-04, DEC-14). POST com corpo (lex C2: coordenada fora da URL). ESTÁTICA: antes de /patients/:id.
  router.post('/patients/map', staffOnly, perm.require('patient_address', 'read'), countryScope, (req: Request, res: Response) =>
    mapController.getMapPoints(req, res),
  );

  router.get('/patients', staffOnly, perm.require('patient', 'read'), countryScope, (req: Request, res: Response) =>
    controller.listPatients(req, res),
  );

  // Manual creation of a native patient (admission team). No :id in the path,
  // so it is safe here; POST does not collide with the GET /:id capture.
  router.post('/patients', staffOnly, perm.require('patient', 'write'), requireCountryScope((req) => req.body?.country), (req: Request, res: Response) =>
    controller.createPatient(req, res),
  );

  // Dynamic route last — Express would capture /stats as /:id otherwise.
  router.get('/patients/:id', staffOnly, perm.require('patient', 'read'), logResourceAccess('patient', patientDetailTrailOf), (req: Request, res: Response) =>
    controller.getPatientById(req, res),
  );

  // Patient addresses
  router.get('/patients/:patientId/addresses', staffOnly, perm.require('patient_address', 'read'), (req: Request, res: Response) =>
    controller.listPatientAddresses(req, res),
  );
  router.post('/patients/:patientId/addresses', staffOnly, perm.require('patient_address', 'write'), (req: Request, res: Response) =>
    controller.createPatientAddress(req, res),
  );
  // Logística por endereço (spec 012, US-B2). 4 segmentos: não colide com o PATCH /:id/:section.
  router.patch('/patients/:patientId/addresses/:addressId', staffOnly, perm.require('patient_address', 'write'), (req: Request, res: Response) =>
    addressesController.updatePatientAddress(req, res),
  );

  // Patient vacancies — all job_postings for a patient, newest first
  router.get('/patients/:id/vacancies', staffOnly, perm.require('vacancy', 'read'), (req: Request, res: Response) =>
    controller.listPatientVacancies(req, res),
  );

  // ── Write / lifecycle (Fase 2 Task 3) ──────────────────────────────────────
  // Literal-second-segment routes first (status, activate) so they read clearly;
  // they never collide with the addresses/vacancies routes (distinct methods or
  // distinct literal segments). The fully-dynamic PATCH /:id/:section goes LAST —
  // it is PATCH-only (no other PATCH route exists) and its :section is validated
  // against a hard whitelist (general|clinical|coverage|support-network|service).

  // PUT /patients/:id/status — kanban move (change lifecycle status)
  router.put('/patients/:id/status', staffOnly, perm.require('patient', 'write'), (req: Request, res: Response) =>
    controller.updatePatientStatus(req, res),
  );
  // Historial (spec 012, US-B7): quando / de → para / origem — sem ator, sem on_hold_note.
  router.get('/patients/:id/status-history', staffOnly, perm.require('patient', 'read'), (req: Request, res: Response) =>
    controller.getPatientStatusHistory(req, res),
  );

  // POST /patients/:id/activate → 410 (spec 018, PR-6, ADR-5, contracts/activation.md).
  // Ativar deixou de ser um botão único no cabeçalho: agora é por SERVIÇO
  // (`POST /patients/:id/contracted-services/:sid/activate-recruitment`, abaixo). `ActivatePatientUseCase`
  // foi removido no mesmo PR — sem célula, a rota só recusa (mesmo molde do 410 de support-network).
  router.post('/patients/:id/activate', staffOnly, (req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      error: 'ACTIVATION_SPLIT',
      code: 'ACTIVATION_SPLIT',
      detail: 'Use activate-recruitment en el servicio contratado; activar al paciente es un cambio de estado posterior.',
    });
  });

  // ── Chat IDs do Periskope (tasks 86ajy0859 / 86ajy085a) ────────────────────
  // GET  candidatos: leitura no Periskope, atrás de PATIENT_CHAT_LOOKUP_ENABLED.
  // PUT  chat-ids:   grava o par escolhido pelo humano.
  // PUT (não PATCH) de propósito: o PATCH /:id/:section é fully-dynamic e
  // capturaria 'chat-ids' como :section, devolvendo 400 pelo whitelist.
  router.get('/patients/:id/chat-candidates', staffOnly, perm.require('messaging', 'read'), (req: Request, res: Response) =>
    chatIdsController.getChatCandidates(req, res),
  );
  router.put('/patients/:id/chat-ids', staffOnly, perm.require('patient_chat', 'write'), (req: Request, res: Response) =>
    chatIdsController.updateChatIds(req, res),
  );

  // ── Synthetic monitoring (e2e-prod) ────────────────────────────────────────
  // Literais ANTES do PATCH dinâmico /:id/:section — senão 'test-flag' seria
  // capturado como :section e barrado pelo whitelist.
  router.patch('/patients/:id/test-flag', staffOnly, perm.require('patient', 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.updatePatientTestFlag(req, res),
  );
  // Purga só de paciente is_test (real → 409). Ver PatientTestFixtureService.
  router.delete('/patients/:id', staffOnly, perm.require('patient', 'delete', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    controller.purgeTestPatient(req, res),
  );

  // ── Serviço contratado, entidade própria (spec 013, bloco C) ───────────────
  // Literais ANTES do PATCH dinâmico /:id/:section — 'contracted-services' seria capturado
  // como :section e barrado pelo whitelist. Sem DELETE (lex C-a.4/C-e.2): baixa é PATCH
  // {active:false}.
  router.get('/patients/:id/contracted-services', staffOnly, perm.require('patient_services', 'read'), (req: Request, res: Response) =>
    contractedServicesController.list(req, res),
  );
  router.post('/patients/:id/contracted-services', staffOnly, perm.require('patient_services', 'write'), (req: Request, res: Response) =>
    contractedServicesController.create(req, res),
  );
  router.patch('/patients/:id/contracted-services/:sid', staffOnly, perm.require('patient_services', 'write'), (req: Request, res: Response) =>
    contractedServicesController.update(req, res),
  );
  // POST /patients/:id/contracted-services/:sid/activate-recruitment (spec 018, PR-6, ADR-5,
  // contracts/activation.md). Guardas na ORDEM do contrato: staffOnly → patient_services:write →
  // vacancy:write (SUP-19: a vaga nasce daqui, mesmo em rascunho) → logResourceAccess.
  router.post(
    '/patients/:id/contracted-services/:sid/activate-recruitment',
    staffOnly,
    perm.require('patient_services', 'write'),
    permVacancy.require('vacancy', 'write'),
    logResourceAccess('patient', 'activate_recruitment'),
    (req: Request, res: Response) => contractedServicesController.activateRecruitment(req, res),
  );
  router.post('/patients/:id/contracted-services/:sid/providers', staffOnly, perm.require('patient_services', 'write'), (req: Request, res: Response) =>
    contractedServicesController.associateProvider(req, res),
  );
  router.patch('/patients/:id/contracted-services/:sid/providers/:pid', staffOnly, perm.require('patient_services', 'write'), (req: Request, res: Response) =>
    contractedServicesController.updateProvider(req, res),
  );

  // ── Diagnóstico estruturado, CID-11 (spec 016 F2, D263) ────────────────────
  // Literais ANTES do PATCH dinâmico /:id/:section — 'diagnoses' seria capturado como :section
  // e barrado pelo whitelist. Sem DELETE físico: baixa é PATCH { active: false }.
  router.get('/patients/:id/diagnoses', staffOnly, perm.require('patient_clinical', 'read'), (req: Request, res: Response) =>
    diagnosesController.list(req, res),
  );
  router.post('/patients/:id/diagnoses', staffOnly, perm.require('patient_clinical', 'write'), (req: Request, res: Response) =>
    diagnosesController.create(req, res),
  );
  router.patch('/patients/:id/diagnoses/:did', staffOnly, perm.require('patient_clinical', 'write'), (req: Request, res: Response) =>
    diagnosesController.update(req, res),
  );

  // Busca de terminologia (CID-11) — não é recurso de paciente, fica fora de /patients/* de
  // propósito (mesmo raciocínio de /chat-groups e /catalogs/insurance-providers acima).
  router.get('/terminology/search', staffOnly, perm.require('patient_clinical', 'read'), (req: Request, res: Response) =>
    terminologySearchController.search(req, res),
  );

  // ── Edição por seção = por CONTAINER (D286; `lex` C5) ───────────────────────
  // Era `PATCH /patients/:id/:section` dinâmico, sob `patient:write` para tudo. Cada seção é um
  // container com célula de escrita PRÓPRIA, então cada uma vira rota explícita e declara a sua —
  // o engine decide por rota, e a rota é a unidade da declaração (nunca "decide no handler").
  // O controller é o mesmo (`updatePatientSection` lê `req.params.section`), e o whitelist de
  // seções continua sendo o de `patientSectionParamSchema`: rota inexistente = 404 como antes.
  // Mapa seção → célula:
  //   general  → patient_identity:write   (nome, documento, nascimento, telefone, e-mail)
  //   clinical → patient_clinical:write   (quadro clínico e textos restritos)
  //   coverage → patient_coverage:write   (obra social, afiliado, verificação)
  //   service  → patient_services:write   (profissão requerida)
  // `support-network` SAIU do whitelist (spec 018, PR-1, SUP-37) — a rota vira 410 abaixo.
  const PATIENT_SECTION_CELL: ReadonlyArray<readonly [string, string]> = [
    ['general', 'patient_identity'],
    ['clinical', 'patient_clinical'],
    ['coverage', 'patient_coverage'],
    ['service', 'patient_services'],
  ];
  for (const [section, resource] of PATIENT_SECTION_CELL) {
    router.patch(`/patients/:id/${section}`, staffOnly, perm.require(resource, 'write'), (req: Request, res: Response) => {
      req.params.section = section;
      return controller.updatePatientSection(req, res);
    });
  }

  // ── Rede de apoio — escrita por LINHA (spec 018, PR-1, ADR-1; contracts/support-network.md) ──
  // `PATCH /patients/:id/support-network` (a lista inteira) vira 410: o único consumidor era o
  // drawer (SUP-37, `git grep` colado no relatório do PR), que passa a chamar as rotas por linha
  // abaixo. Sem `perm.require` — a rota não faz mais nada além de recusar; a célula de verdade é
  // `patient_family:write`, exigida pelas rotas novas.
  router.patch('/patients/:id/support-network', staffOnly, (req: Request, res: Response) => {
    res.status(410).json({ success: false, error: 'SUPPORT_NETWORK_LIST_WRITE_REMOVED', code: 'SUPPORT_NETWORK_LIST_WRITE_REMOVED' });
  });

  router.post('/patients/:id/responsibles', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    contactRowsController.createResponsible(req, res),
  );
  router.patch('/patients/:id/responsibles/:rid', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    contactRowsController.updateResponsible(req, res),
  );
  router.post('/patients/:id/responsibles/:rid/deactivate', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    contactRowsController.deactivateResponsible(req, res),
  );

  // ── Contatos de emergência da cobertura — escrita por LINHA (PR-1; taxonomia no PR-2) ────────
  router.post('/patients/:id/coverage-emergency-contacts', staffOnly, perm.require('patient_coverage', 'write'), (req: Request, res: Response) =>
    contactRowsController.createCoverageEmergencyContact(req, res),
  );
  router.patch('/patients/:id/coverage-emergency-contacts/:cid', staffOnly, perm.require('patient_coverage', 'write'), (req: Request, res: Response) =>
    contactRowsController.updateCoverageEmergencyContact(req, res),
  );
  router.post('/patients/:id/coverage-emergency-contacts/:cid/deactivate', staffOnly, perm.require('patient_coverage', 'write'), (req: Request, res: Response) =>
    contactRowsController.deactivateCoverageEmergencyContact(req, res),
  );

  // ── Equipe tratante — escrita por LINHA (spec 018, PR-5, US-11; `contracts/care-team.md`) ────
  // Célula NOVA `patient_care_team:write` — catálogo sincroniza pela declaração da rota
  // (`SyncPermissionCatalogUseCase`, molde das demais); nasce com 0 grupos (lex 12/09).
  router.post('/patients/:id/professionals', staffOnly, perm.require('patient_care_team', 'write'), (req: Request, res: Response) =>
    contactRowsController.createProfessional(req, res),
  );
  router.patch('/patients/:id/professionals/:pid', staffOnly, perm.require('patient_care_team', 'write'), (req: Request, res: Response) =>
    contactRowsController.updateProfessional(req, res),
  );
  router.post('/patients/:id/professionals/:pid/deactivate', staffOnly, perm.require('patient_care_team', 'write'), (req: Request, res: Response) =>
    contactRowsController.deactivateProfessional(req, res),
  );

  // ── Contatos externos sem vínculo familiar (spec 018, PR-2, `lex` #4) ────────────────────────
  router.post('/patients/:id/external-contacts', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    externalContactsController.create(req, res),
  );
  router.patch('/patients/:id/external-contacts/:xid', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    externalContactsController.update(req, res),
  );
  router.post('/patients/:id/external-contacts/:xid/deactivate', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    externalContactsController.deactivate(req, res),
  );

  // ── Marca de emergência (spec 018, PR-2, D-A) ───────────────────────────────────────────────
  router.put('/patients/:id/emergency-contact', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    emergencyContactController.mark(req, res),
  );
  router.delete('/patients/:id/emergency-contact', staffOnly, perm.require('patient_family', 'write'), (req: Request, res: Response) =>
    emergencyContactController.unmark(req, res),
  );

  return router;
}
