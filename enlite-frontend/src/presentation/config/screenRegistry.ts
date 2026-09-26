/**
 * screenRegistry — a árvore Tela → Container → Células, como o time pensa e como o painel de
 * grupos passa a mostrar (D286, 05/09/2026).
 *
 * ── O que É e o que NÃO é ────────────────────────────────────────────────────────────────────
 *  · É um AGRUPAMENTO DE EXIBIÇÃO: diz em qual tela e em qual container cada célula é consumida.
 *    A célula continua sendo por DADO (`patient_family:read`), nunca "da tela" — a mesma célula
 *    aparece em toda tela que a consome e é UMA só (marcar num lugar marca no outro).
 *  · NÃO é fonte de verdade de existência: quem diz que uma célula existe é o catálogo do back
 *    (derivado do código). O teste `screenRegistry.test.ts` mede este arquivo contra a fixture
 *    do catálogo nos dois sentidos — célula daqui que o back não conhece reprova; célula do back
 *    que nenhuma tela lista cai no bloco "Outras células" do painel, nunca some.
 *  · NÃO é enforcement: quem esconde card/aba é `ContainerGate`/`useContainerAccess`, e quem nega
 *    dado é a rota (a resposta já vem projetada). Aqui só se declara o mapa.
 *
 * ── Regras (D286 + adendos) ──────────────────────────────────────────────────────────────────
 *  · Tela sem container (uma lista) recebe as ações direto (`cells` no nível da tela).
 *  · Tela com containers pode TAMBÉM ter ação própria (exportar a lista) — o trio Ver/Editar/
 *    Remover é a base, não o teto: a ação existe se o código a expõe.
 *  · Card placeholder (projeto terapêutico, supervisão, relatórios, enquadre) NÃO entra: célula
 *    sem consumidor é dívida (`lex` P2).
 *  · País é eixo do GRUPO (escopo), não ação — não aparece aqui.
 */

export interface ScreenContainer {
  /** id estável, usado nas chaves de i18n `admin.access.screens.<screen>.containers.<id>`. */
  id: string;
  /** Recurso das células do container (`patient_family` → `patient_family:read|write`). */
  resource: string;
  /** Abas da tela onde o container vive (quando a tela tem abas) — pode ser mais de uma. */
  tabs?: readonly string[];
  /** Células que o container consome — sempre `resource:action`. */
  cells: readonly string[];
}

export interface ScreenDef {
  /** id estável (`patients.detail`), chave de i18n `admin.access.screens.<id>.label`. */
  id: string;
  /** Rota do painel — o teste confere que ela existe em `App.tsx`. */
  route: string;
  /** Ações da própria tela (lista, exportar, sincronizar…). */
  cells?: readonly string[];
  containers?: readonly ScreenContainer[];
  /** Abas da tela, na ordem — uma aba só existe se algum container dela for legível. */
  tabs?: readonly string[];
}

const c = (id: string, resource: string, actions: readonly string[], ...tabs: readonly string[]): ScreenContainer => ({
  id,
  resource,
  tabs: tabs.length > 0 ? tabs : undefined,
  cells: actions.map((a) => `${resource}:${a}`),
});

export const SCREEN_REGISTRY: readonly ScreenDef[] = [
  {
    id: 'dashboard',
    route: '/admin/dashboard',
    // Abrir a tela é `dashboard:read` (célula da rota de `management`); cada BLOCO da tela tem a sua,
    // e a rota projeta o payload por bloco (`dashboardContainerAccess` no back). Zonas é rota própria.
    cells: ['dashboard:read'],
    containers: [
      c('numbers', 'dashboard_numbers', ['read']),
      c('team', 'dashboard_team', ['read']),
      c('priorities', 'dashboard_priorities', ['read']),
      c('registrations', 'dashboard_registrations', ['read']),
      c('funnel', 'dashboard_funnel', ['read']),
      c('zones', 'dashboard_zones', ['read']),
      c('patients', 'patient', ['read']),
    ],
  },
  {
    id: 'users',
    route: '/admin',
    cells: ['user_management:read', 'user_management:create', 'user_management:update', 'user_management:delete', 'permission_management:write'],
  },

  // ── Pacientes ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'patients.list',
    route: '/admin/patients',
    // `patient:read` é o OPERACIONAL (status, funil, caso); nome e documento na lista vêm da
    // identidade, e as colunas clínicas da clínica — a lista é projetada pelo back (`lex` P1).
    cells: ['patient:read', 'patient:create', 'patient:update', 'patient:delete', 'patient_identity:read', 'patient_clinical:read'],
  },
  { id: 'patients.kanban', route: '/admin/patients/kanban', cells: ['patient:read', 'patient:create', 'patient:update', 'patient_identity:read'] },
  {
    id: 'patients.detail',
    route: '/admin/patients/:id',
    tabs: ['clinicalData', 'supportNetwork', 'contractedService', 'vacancies', 'history'],
    containers: [
      c('identity', 'patient_identity', ['read', 'create', 'update']),
      c('clinical', 'patient_clinical', ['read', 'create', 'update'], 'clinicalData'),
      c('careTeam', 'patient_care_team', ['read', 'create', 'update'], 'clinicalData'),
      // Spec 017: o projeto terapêutico deixa de ser placeholder — container próprio, na aba clínica.
      // `export` entra: o botão de exportar (`TherapeuticProjectDrawer.tsx:188`,
      // `<ActionButton resource="patient_therapeutic_project" action="export">`) passa por
      // `useActionGate` (`ActionButton.tsx:58`) — célula com consumidor e gate reais, só faltava
      // ser declarada.
      c('therapeuticProject', 'patient_therapeutic_project', ['read', 'create', 'update', 'export'], 'clinicalData'),
      c('family', 'patient_family', ['read', 'create', 'update'], 'supportNetwork'),
      c('chat', 'patient_chat', ['read', 'create', 'update'], 'supportNetwork'),
      c('coverage', 'patient_coverage', ['read', 'create', 'update'], 'contractedService'),
      c('address', 'patient_address', ['read', 'create', 'update'], 'contractedService'),
      // A aba Matching saiu (decisão do Gabriel 05/09, na main): o encuadre É o serviço contratado
      // completo, que vive só na aba Serviço contratado — uma célula, uma aba.
      c('services', 'patient_services', ['read', 'create', 'update'], 'contractedService'),
      // O VALOR-HORA do serviço contratado é dado próprio (era "só admin" por papel; D293): quem
      // tem `patient_services:read` vê o serviço, mas o preço só sai com esta célula.
      c('contractValue', 'patient_contract_value', ['read'], 'contractedService'),
      c('vacancies', 'vacancy', ['read'], 'vacancies'),
      // O operacional da tela numa linha só: cabeçalho (status, ativar, completude) e a aba de
      // histórico — mesmo recurso `patient`, uma célula de leitura e uma de escrita.
      c('operational', 'patient', ['read', 'create', 'update'], 'history'),
    ],
  },
  { id: 'patients.chatRoles', route: '/admin/patient-chat-roles', cells: ['patient:read', 'patient:create', 'patient:update'] },
  // Spec 017 (D299.3): os 2 catálogos do projeto terapêutico — uma tela e uma célula por lista (tipo de patologia deriva do CID-11, sem tela).
  { id: 'patients.catalogObjectives', route: '/admin/catalogos/objetivos-especificos', cells: ['catalog_therapeutic_objectives:read', 'catalog_therapeutic_objectives:create', 'catalog_therapeutic_objectives:update'] },
  { id: 'patients.catalogActivities', route: '/admin/catalogos/actividades', cells: ['catalog_therapeutic_activities:read', 'catalog_therapeutic_activities:create', 'catalog_therapeutic_activities:update'] },
  {
    id: 'map',
    route: '/admin/mapa',
    // Cada aba é um container com a célula de ENDEREÇO do titular — a mesma da ficha dele. O nome
    // do pino segue contato (prestador) / identidade (paciente), projetado pela rota.
    // A âncora da aba Prestadores é um paciente (e vice-versa): usar uma aba pede as duas células.
    tabs: ['workers', 'patients'],
    containers: [c('workers', 'worker_address', ['read'], 'workers'), c('patients', 'patient_address', ['read'], 'patients')],
  },

  // ── Prestadores ────────────────────────────────────────────────────────────────────────────
  {
    id: 'workers.list',
    route: '/admin/workers',
    cells: ['worker:read', 'worker_contact:read', 'worker:export', 'talentum:create', 'talentum:update'],
  },
  {
    id: 'workers.detail',
    route: '/admin/workers/:id',
    // `financial` e `history` são placeholders ("Próximamente"): sem container, existem sempre.
    tabs: ['encuadres', 'documents', 'availability', 'financial', 'history'],
    containers: [
      // O operacional numa linha só: perfil profissional, etiquetas, conta de teste, edição e a
      // aba de disponibilidade. `worker:disable` fica fora: a baixa é decidida no back pela
      // transição de status e não tem botão próprio no front (cai em "Outras células").
      // `create` REMOVIDO em 21/09 (spec 024, D401): não existia botão nenhum que criasse
      // "worker" por aqui — era só a tag (agora `tag:create`, tela própria `/admin/tags`).
      c('profile', 'worker', ['read', 'update'], 'availability'),
      c('contact', 'worker_contact', ['read']),
      // Dossiê = nascimento, sexo, DNI, raça, religião… (célula da C3/F2). Endereço é célula própria
      // (linha, coordenada, raio) — a MESMA que vale na aba Prestadores do mapa.
      // `write` (spec 025, Fase 6, D402 item 4, 21/09): hoje só edição de `birthDate` pelo admin,
      // gate cumulativo a `worker:update` — checado em código (WorkerEditModal + backend), não é
      // rota própria. Fica na linha do dossiê (visível), diferente de `patient_clinical:write` que
      // cai em "Outras células" por escolha do PR-7 original.
      c('dossier', 'worker_pii', ['read', 'write']),
      c('address', 'worker_address', ['read']),
      c('documents', 'worker_document', ['read', 'create', 'update', 'delete', 'validate'], 'documents'),
      c('encuadres', 'match', ['read'], 'encuadres'),
    ],
  },
  // ── Vagas ──────────────────────────────────────────────────────────────────────────────────
  { id: 'vacancies.list', route: '/admin/vacancies', cells: ['vacancy:read', 'vacancy:create', 'vacancy:update', 'talentum:create', 'talentum:update'] },
  { id: 'vacancies.create', route: '/admin/vacancies/new', cells: ['vacancy:read', 'vacancy:create', 'vacancy:update'] },
  { id: 'vacancies.addressReview', route: '/admin/vacancies/pending-address-review', cells: ['vacancy:read', 'vacancy:create', 'vacancy:update'] },
  {
    id: 'vacancies.talentum',
    route: '/admin/vacancies/:id/talentum',
    cells: ['vacancy:read', 'vacancy:create', 'vacancy:update', 'talentum:create', 'talentum:update', 'prescreening:create', 'prescreening:update'],
  },
  {
    id: 'vacancies.detail',
    route: '/admin/vacancies/:id',
    tabs: ['encuadres', 'talentum', 'links', 'notes'],
    containers: [
      // `vacancy:delete` sem botão (ui-gate-debt.json): arquivar é status CLOSED via write. O caso
      // cobre cabeçalho, perfil requerido, links de reunião, a aba Links e a aba Anotações (tudo
      // dado da vaga).
      c('case', 'vacancy', ['read', 'create', 'update'], 'links', 'notes'),
      // O card Paciente mostra o NOME do paciente — dado de outro titular, célula de identidade
      // dele (a rota projeta; sem ela vem "Contato restrito").
      c('patient', 'patient_identity', ['read']),
      c('funnel', 'funnel', ['read', 'create', 'update'], 'encuadres'),
      c('match', 'match', ['read', 'execute'], 'encuadres'),
      c('invites', 'messaging', ['send'], 'encuadres'),
      c('prescreening', 'prescreening', ['read', 'create', 'update'], 'talentum'),
      c('talentum', 'talentum', ['read', 'create', 'update'], 'talentum'),
    ],
  },

  // ── Recrutamento e mensageria ──────────────────────────────────────────────────────────────
  { id: 'recruitment', route: '/admin/recruitment', cells: ['recruitment:read', 'match:read', 'talentum:read'] },
  { id: 'recruitment.health', route: '/admin/recruitment/health', cells: ['messaging:read'] },
  { id: 'messaging.stageMessages', route: '/admin/mensajes-por-etapa', cells: ['messaging:read', 'messaging:create', 'messaging:update'] },
  { id: 'messaging.templates', route: '/admin/plantillas', cells: ['messaging:read', 'messaging:create', 'messaging:update'] },
  { id: 'messaging.presentationInvite', route: '/admin/invitacion-presentacion', cells: ['messaging:read', 'messaging:create', 'messaging:update', 'messaging:send'] },

  // ── Postulações bloqueadas (spec 024 D2/D401) ─────────────────────────────────────────────
  // LOG administrativo, dado diferente do funil de recrutamento — título e célula PRÓPRIOS,
  // fora das seções de Pacientes/Vagas/Prestadores/Recrutamento. Rota e item de menu não mudam.
  { id: 'recruitment.blocked', route: '/admin/recruitment/blocked-attempts', cells: ['recruitment_blocked:read'] },

  // ── Configuração (spec 024 D1/D401) ───────────────────────────────────────────────────────
  // Catálogo de Etiquetas de prestador: DADO diferente do perfil do prestador — tópico próprio,
  // com as quatro células Ver/Criar/Editar/Deletar.
  { id: 'tags', route: '/admin/tags', cells: ['tag:read', 'tag:create', 'tag:update', 'tag:delete'] },

  // ── Ana Care ───────────────────────────────────────────────────────────────────────────────
  // Fase 1 da conferência de horas (D344, 15/09/2026) — duas células PRÓPRIAS, fora de qualquer
  // grupo padrão: `anacare_hours:read` (turnos, horas, origem, status — sem nome e sem nota) e
  // `anacare_hours:validate` (validar, validar em lote, contestar). Nome de paciente/prestador
  // continua cumulativo às células já existentes (`patient_identity:read`/`worker_contact:read`),
  // não repetido aqui — são dados de OUTRO titular, não desta tela.
  { id: 'anacareHours.list', route: '/admin/anacare/horas', cells: ['anacare_hours:read'] },
  {
    id: 'anacareHours.detail',
    route: '/admin/anacare/horas/:patientId',
    cells: ['anacare_hours:read', 'anacare_hours:validate'],
    containers: [
      // Lançar comprobante no Axonico (`AxonicoComprobanteHttpService.enviarComprobante` →
      // POST /api/admin/integrations/axonico/comprobante, `adminIntegrationsRoutes.ts:84`) e
      // registrar o documento do paciente no Ana Care (`AnaCarePatientDocumentHttpService.
      // registerDocument` → POST /api/admin/integrations/anacare/patient-document, célula
      // `patient_identity:create`, já coberta noutro container) — os dois instanciados em
      // `AnaCareHoursPatientPage.tsx:21,23`. Só `execute` entra: é a única ação de `integration`
      // que o front consome (backfill e o lote do Axonico, mesma célula, não têm consumidor —
      // `interview:*` ao lado segue o mesmo motivo e por isso não ganhou container).
      c('integration', 'integration', ['execute']),
    ],
  },

  // ── Administração ──────────────────────────────────────────────────────────────────────────
  { id: 'dedup', route: '/admin/dedup', cells: ['dedup:read', 'dedup:execute'] },
  { id: 'access', route: '/admin/access', cells: ['permission_management:read', 'permission_management:write'] },
];

/** Todas as células que alguma tela lista, com as telas que as consomem. */
export function screensByCell(registry: readonly ScreenDef[] = SCREEN_REGISTRY): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (cell: string, screen: string) => out.set(cell, [...(out.get(cell) ?? []), screen]);
  for (const s of registry) {
    for (const cell of s.cells ?? []) add(cell, s.id);
    for (const ct of s.containers ?? []) for (const cell of ct.cells) add(cell, s.id);
  }
  return out;
}

/** Recursos dos containers de uma aba — a aba existe se QUALQUER um deles for legível. */
export function containersOfTab(screen: ScreenDef, tab: string): readonly ScreenContainer[] {
  return (screen.containers ?? []).filter((ct) => ct.tabs?.includes(tab));
}

/** Todas as células de uma tela — as próprias (lista, exportar…) e as de todos os containers. */
export function cellsOfScreen(screen: ScreenDef): string[] {
  return [...(screen.cells ?? []), ...(screen.containers ?? []).flatMap((ct) => [...ct.cells])];
}

/**
 * A tela cuja rota é EXATAMENTE `route` (o `href` de um item de menu) — `undefined` se nenhuma tela
 * a declara. Aceita `undefined` (item sem href, ex. cabeçalho de seção): não tem tela.
 */
export function screenByRoute(route: string | undefined, registry: readonly ScreenDef[] = SCREEN_REGISTRY): ScreenDef | undefined {
  return registry.find((x) => x.route === route);
}

export function screenById(id: string, registry: readonly ScreenDef[] = SCREEN_REGISTRY): ScreenDef {
  const s = registry.find((x) => x.id === id);
  if (!s) throw new Error(`tela desconhecida no registro: ${id}`);
  return s;
}
