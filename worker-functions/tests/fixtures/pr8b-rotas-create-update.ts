/**
 * tests/fixtures/pr8b-rotas-create-update.ts
 *
 * Fixture NOMINAL das 99 rotas splitadas (spec 018, PR-8b, 8b.1) — gerada de
 * `specs/018-planning-0909-ficha-admissao/pr8b-mapa-rotas.tsv` (108 rotas menos as 9
 * `permission_management` que ficam `write`, contracts/permissions-split.md linha 11).
 *
 * `permission-route-create-update-fixture.test.ts` varre o inventário real
 * (`/.well-known/permissions/routes`) e falha se alguma rota aqui listada não
 * declarar EXATAMENTE estas ações, ou se qualquer rota fora desta lista (e fora de
 * `permission_management`) ainda declarar `write`.
 *
 * Regenerar: reprocessar o TSV acima com o mesmo mapeamento de prefixo por arquivo
 * (ver `docs/` do PR-8b) sempre que o mapa nominal mudar.
 */

export interface RotaCreateUpdate {
  method: string;
  path: string;
  /** Ação(ões) exigida(s) — 2 entradas = a rota precisa das DUAS (guards encadeados). */
  actions: readonly string[];
  /**
   * TODAS as células da rota (`recurso:ação`), quando os guards encadeados são
   * de RECURSOS DIFERENTES (ex.: `patient_services:update` → `vacancy:update`)
   * — `actions` sozinho não basta aí porque não carrega o recurso de cada
   * entrada. Opcional: ausente = a rota só declara UM recurso (o de `source`),
   * e o teste confere por `actions` como sempre conferiu. Achado pós-#391
   * (spec 018, PR-8b): o oráculo e a fixture só liam a 1ª célula da rota.
   */
  cells?: readonly string[];
  /** arquivo:linha de origem no mapa nominal — só para depuração humana. */
  source: string;
}

export const PR8B_ROTAS_CREATE_UPDATE: readonly RotaCreateUpdate[] = [
  { method: 'PATCH', path: '/api/admin/workers/:id/test-flag', actions: ['update'], source: 'adminWorkerRoutes.ts:111' },
  { method: 'PATCH', path: '/api/admin/patients/:id/test-flag', actions: ['update'], source: 'adminPatientsRoutes.ts:228' },
  { method: 'POST', path: '/api/admin/patient-chat-roles', actions: ['create'], source: 'adminPatientsRoutes.ts:101' },
  { method: 'PATCH', path: '/api/admin/patient-chat-roles/:code', actions: ['update'], source: 'adminPatientsRoutes.ts:104' },
  { method: 'DELETE', path: '/api/admin/patient-chat-roles/:code', actions: ['update'], source: 'adminPatientsRoutes.ts:107' },
  { method: 'POST', path: '/api/admin/catalogs/insurance-providers', actions: ['create'], source: 'adminPatientsRoutes.ts:117' },
  { method: 'POST', path: '/api/admin/patients', actions: ['create'], source: 'adminPatientsRoutes.ts:158' },
  { method: 'POST', path: '/api/admin/patients/:patientId/addresses', actions: ['create'], source: 'adminPatientsRoutes.ts:171' },
  { method: 'PATCH', path: '/api/admin/patients/:patientId/addresses/:addressId', actions: ['update'], source: 'adminPatientsRoutes.ts:175' },
  { method: 'PUT', path: '/api/admin/patients/:id/status', actions: ['update'], source: 'adminPatientsRoutes.ts:192' },
  { method: 'PUT', path: '/api/admin/patients/:id/chat-ids', actions: ['update'], source: 'adminPatientsRoutes.ts:221' },
  { method: 'POST', path: '/api/admin/patients/:id/contracted-services', actions: ['create'], source: 'adminPatientsRoutes.ts:243' },
  { method: 'PATCH', path: '/api/admin/patients/:id/contracted-services/:sid', actions: ['update'], source: 'adminPatientsRoutes.ts:246' },
  // Guards ENCADEADOS de recursos DIFERENTES (não é o molde "mesmo recurso,
  // create+update" dos outros `actions: [2]` acima) — `cells` carrega os dois.
  // Era `vacancy:write` literal até o achado pós-#391 (PermVacancy escapava do
  // grep que migrou as outras 98 rotas, que só buscava `perm\.require(`).
  {
    method: 'POST',
    path: '/api/admin/patients/:id/contracted-services/:sid/activate-recruitment',
    actions: ['update'],
    cells: ['patient_services:update', 'vacancy:update'],
    source: 'adminPatientsRoutes.ts:255-256',
  },
  { method: 'POST', path: '/api/admin/patients/:id/contracted-services/:sid/providers', actions: ['update'], source: 'adminPatientsRoutes.ts:260' },
  { method: 'PATCH', path: '/api/admin/patients/:id/contracted-services/:sid/providers/:pid', actions: ['update'], source: 'adminPatientsRoutes.ts:263' },
  { method: 'POST', path: '/api/admin/patients/:id/diagnoses', actions: ['create'], source: 'adminPatientsRoutes.ts:273' },
  { method: 'PATCH', path: '/api/admin/patients/:id/diagnoses/:did', actions: ['update'], source: 'adminPatientsRoutes.ts:276' },
  { method: 'PATCH', path: '/api/admin/patients/:id/general', actions: ['update'], source: 'adminPatientsRoutes.ts:305' },
  { method: 'PATCH', path: '/api/admin/patients/:id/clinical', actions: ['update'], source: 'adminPatientsRoutes.ts:305' },
  { method: 'PATCH', path: '/api/admin/patients/:id/coverage', actions: ['update'], source: 'adminPatientsRoutes.ts:305' },
  { method: 'PATCH', path: '/api/admin/patients/:id/service', actions: ['update'], source: 'adminPatientsRoutes.ts:305' },
  { method: 'POST', path: '/api/admin/patients/:id/responsibles', actions: ['create'], source: 'adminPatientsRoutes.ts:320' },
  { method: 'PATCH', path: '/api/admin/patients/:id/responsibles/:rid', actions: ['update'], source: 'adminPatientsRoutes.ts:323' },
  { method: 'POST', path: '/api/admin/patients/:id/responsibles/:rid/deactivate', actions: ['update'], source: 'adminPatientsRoutes.ts:326' },
  { method: 'POST', path: '/api/admin/patients/:id/coverage-emergency-contacts', actions: ['create'], source: 'adminPatientsRoutes.ts:331' },
  { method: 'PATCH', path: '/api/admin/patients/:id/coverage-emergency-contacts/:cid', actions: ['update'], source: 'adminPatientsRoutes.ts:334' },
  { method: 'POST', path: '/api/admin/patients/:id/coverage-emergency-contacts/:cid/deactivate', actions: ['update'], source: 'adminPatientsRoutes.ts:337' },
  { method: 'POST', path: '/api/admin/patients/:id/professionals', actions: ['create'], source: 'adminPatientsRoutes.ts:344' },
  { method: 'PATCH', path: '/api/admin/patients/:id/professionals/:pid', actions: ['update'], source: 'adminPatientsRoutes.ts:347' },
  { method: 'POST', path: '/api/admin/patients/:id/professionals/:pid/deactivate', actions: ['update'], source: 'adminPatientsRoutes.ts:350' },
  { method: 'POST', path: '/api/admin/patients/:id/external-contacts', actions: ['create'], source: 'adminPatientsRoutes.ts:355' },
  { method: 'PATCH', path: '/api/admin/patients/:id/external-contacts/:xid', actions: ['update'], source: 'adminPatientsRoutes.ts:358' },
  { method: 'POST', path: '/api/admin/patients/:id/external-contacts/:xid/deactivate', actions: ['update'], source: 'adminPatientsRoutes.ts:361' },
  { method: 'PUT', path: '/api/admin/patients/:id/emergency-contact', actions: ['update'], source: 'adminPatientsRoutes.ts:366' },
  { method: 'DELETE', path: '/api/admin/patients/:id/emergency-contact', actions: ['update'], source: 'adminPatientsRoutes.ts:369' },
  { method: 'POST', path: '/api/admin/patients/:id/therapeutic-projects', actions: ['create'], source: 'adminTherapeuticProjectsRoutes.ts:56' },
  { method: 'POST', path: '/api/admin/patients/:id/therapeutic-projects/:vid/annul', actions: ['update'], source: 'adminTherapeuticProjectsRoutes.ts:78' },
  { method: 'POST', path: '/api/admin/therapeutic-catalogs/specific-objectives', actions: ['create'], source: 'adminTherapeuticProjectsRoutes.ts:89' },
  { method: 'POST', path: '/api/admin/therapeutic-catalogs/activities', actions: ['create'], source: 'adminTherapeuticProjectsRoutes.ts:89' },
  { method: 'POST', path: '/api/admin/therapeutic-catalogs/segments', actions: ['create'], source: 'adminTherapeuticProjectsRoutes.ts:89' },
  { method: 'PATCH', path: '/api/admin/therapeutic-catalogs/specific-objectives/:itemId', actions: ['update'], source: 'adminTherapeuticProjectsRoutes.ts:92' },
  { method: 'PATCH', path: '/api/admin/therapeutic-catalogs/activities/:itemId', actions: ['update'], source: 'adminTherapeuticProjectsRoutes.ts:92' },
  { method: 'PATCH', path: '/api/admin/therapeutic-catalogs/segments/:itemId', actions: ['update'], source: 'adminTherapeuticProjectsRoutes.ts:92' },
  { method: 'POST', path: '/api/admin/users', actions: ['create'], source: 'adminUsersRoutes.ts:43' },
  { method: 'POST', path: '/api/admin/users/:id/reset-password', actions: ['update'], source: 'adminUsersRoutes.ts:64' },
  { method: 'POST', path: '/api/admin/vacancies', actions: ['create'], source: 'adminVacanciesRoutes.ts:108' },
  { method: 'PUT', path: '/api/admin/vacancies/:id', actions: ['update'], source: 'adminVacanciesRoutes.ts:111' },
  { method: 'POST', path: '/api/admin/vacancies/:id/resolve-address-review', actions: ['update'], source: 'adminVacanciesRoutes.ts:118' },
  { method: 'PUT', path: '/api/admin/encuadres/:id/result', actions: ['update'], source: 'adminVacanciesRoutes.ts:130' },
  { method: 'POST', path: '/api/admin/vacancies/:id/publish-talentum', actions: ['update'], source: 'adminVacanciesRoutes.ts:135' },
  { method: 'DELETE', path: '/api/admin/vacancies/:id/publish-talentum', actions: ['update'], source: 'adminVacanciesRoutes.ts:138' },
  { method: 'POST', path: '/api/admin/vacancies/:id/generate-talentum-description', actions: ['update'], source: 'adminVacanciesRoutes.ts:141' },
  { method: 'PUT', path: '/api/admin/vacancies/:id/talentum-description', actions: ['update'], source: 'adminVacanciesRoutes.ts:144' },
  { method: 'POST', path: '/api/admin/vacancies/:id/generate-ai-content', actions: ['update'], source: 'adminVacanciesRoutes.ts:147' },
  { method: 'POST', path: '/api/admin/vacancies/sync-talentum', actions: ['create', 'update'], source: 'adminVacanciesRoutes.ts:150' },
  { method: 'POST', path: '/api/admin/vacancies/:id/prescreening-config', actions: ['update'], source: 'adminVacanciesRoutes.ts:159' },
  { method: 'PUT', path: '/api/admin/vacancies/:id/meet-links', actions: ['update'], source: 'adminVacanciesRoutes.ts:169' },
  { method: 'POST', path: '/api/admin/vacancies/:id/social-links', actions: ['create'], source: 'adminVacanciesRoutes.ts:174' },
  { method: 'PUT', path: '/api/admin/encuadres/:id/move', actions: ['update'], source: 'adminVacanciesRoutes.ts:185' },
  { method: 'POST', path: '/api/admin/vacancies/blocked-applications/:blockedId/reject', actions: ['update'], source: 'adminVacanciesRoutes.ts:190' },
  { method: 'POST', path: '/api/admin/vacancies/blocked-applications/:blockedId/restore', actions: ['update'], source: 'adminVacanciesRoutes.ts:194' },
  { method: 'POST', path: '/api/admin/vacancies/:id/interview-slots', actions: ['create'], source: 'adminVacanciesRoutes.ts:217' },
  { method: 'POST', path: '/api/admin/interview-slots/:slotId/book', actions: ['update'], source: 'adminVacanciesRoutes.ts:223' },
  { method: 'POST', path: '/api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes', actions: ['create'], source: 'adminVacanciesRoutes.ts:244' },
  { method: 'DELETE', path: '/api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes/:noteId', actions: ['update'], source: 'adminVacanciesRoutes.ts:250' },
  { method: 'PUT', path: '/api/admin/funnel-stage-messages/:stage', actions: ['update'], source: 'funnelStageMessagesRoutes.ts:19' },
  { method: 'POST', path: '/api/admin/recruitment/calculate-reemplazos', actions: ['create', 'update'], source: 'recruitmentRoutes.ts:64' },
  { method: 'POST', path: '/api/admin/template-drafts', actions: ['create'], source: 'templateDraftsRoutes.ts:34' },
  { method: 'POST', path: '/api/admin/template-drafts/validar', actions: ['create', 'update'], source: 'templateDraftsRoutes.ts:50' },
  { method: 'PUT', path: '/api/admin/template-drafts/:id', actions: ['update'], source: 'templateDraftsRoutes.ts:51' },
  { method: 'DELETE', path: '/api/admin/template-drafts/:id', actions: ['update'], source: 'templateDraftsRoutes.ts:52' },
  { method: 'POST', path: '/api/admin/template-drafts/:id/submit', actions: ['update'], source: 'templateDraftsRoutes.ts:53' },
  { method: 'POST', path: '/api/admin/template-drafts/:id/duplicate', actions: ['create'], source: 'templateDraftsRoutes.ts:54' },
  { method: 'POST', path: '/api/admin/workers/:id/documents/ingest-from-url', actions: ['create'], source: 'workerContextRoutes.ts:95' },
  { method: 'PUT', path: '/api/workers/:id/status', actions: ['update'], source: 'workerEncuadreRoutes.ts:50' },
  { method: 'PUT', path: '/api/workers/:id/occupation', actions: ['update'], source: 'workerEncuadreRoutes.ts:53' },
  { method: 'PUT', path: '/api/workers/:id/doc-expiry', actions: ['update'], source: 'workerEncuadreRoutes.ts:59' },
  { method: 'POST', path: '/api/admin/messaging/templates', actions: ['create'], source: 'messagingRoutes.ts:56' },
  { method: 'PUT', path: '/api/admin/messaging/templates/:slug', actions: ['update'], source: 'messagingRoutes.ts:59' },
  { method: 'DELETE', path: '/api/admin/messaging/templates/:slug', actions: ['update'], source: 'messagingRoutes.ts:62' },
  { method: 'PUT', path: '/api/admin/presentation-invite/settings', actions: ['update'], source: 'presentationInviteRoutes.ts:19' },
  { method: 'POST', path: '/api/admin/workers/:id/documents/upload-url', actions: ['create'], source: 'adminWorkerDocumentsRoutes.ts:27' },
  { method: 'POST', path: '/api/admin/workers/:id/documents/save', actions: ['create'], source: 'adminWorkerDocumentsRoutes.ts:30' },
  { method: 'POST', path: '/api/admin/workers/sync-talentum', actions: ['create', 'update'], source: 'adminWorkerRoutes.ts:99' },
  { method: 'PATCH', path: '/api/admin/workers/:id/profile', actions: ['update'], source: 'adminWorkerRoutes.ts:113' },
  { method: 'PUT', path: '/api/admin/workers/:id/service-area', actions: ['update'], source: 'adminWorkerRoutes.ts:115' },
  { method: 'POST', path: '/api/admin/worker-tags', actions: ['create'], source: 'adminWorkerRoutes.ts:120' },
  { method: 'PATCH', path: '/api/admin/worker-tags/:id', actions: ['update'], source: 'adminWorkerRoutes.ts:121' },
  { method: 'DELETE', path: '/api/admin/worker-tags/:id', actions: ['update'], source: 'adminWorkerRoutes.ts:122' },
  { method: 'POST', path: '/api/admin/workers/:id/tags/:tagId', actions: ['update'], source: 'adminWorkerRoutes.ts:123' },
  { method: 'DELETE', path: '/api/admin/workers/:id/tags/:tagId', actions: ['update'], source: 'adminWorkerRoutes.ts:124' },
  { method: 'POST', path: '/api/admin/workers/:id/additional-documents/upload-url', actions: ['create'], source: 'workerDocumentsRoutes.ts:59' },
  { method: 'POST', path: '/api/admin/workers/:id/additional-documents', actions: ['create'], source: 'workerDocumentsRoutes.ts:61' },
  { method: 'POST', path: '/api/admin/patients/:id/photo', actions: ['create'], source: 'adminPatientPhotoRoutes.ts:61 (PR-4, branch feat/018-pr4-foto-documentos)' },
  { method: 'DELETE', path: '/api/admin/patients/:id/photo', actions: ['update'], source: 'adminPatientPhotoRoutes.ts:65 (PR-4)' },
  { method: 'POST', path: '/api/admin/patients/:id/documents', actions: ['create'], source: 'adminPatientPhotoRoutes.ts:80 (PR-4)' },
  { method: 'POST', path: '/api/admin/patients/:id/image-consents', actions: ['create'], source: 'adminPatientPhotoRoutes.ts:102 (PR-4)' },
  { method: 'POST', path: '/api/admin/patients/:id/image-consents/:cid/revoke', actions: ['update'], source: 'adminPatientPhotoRoutes.ts:116 (PR-4)' },
];

