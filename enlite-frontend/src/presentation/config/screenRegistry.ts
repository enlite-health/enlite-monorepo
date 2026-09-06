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
    containers: [c('analytics', 'dashboard', ['read']), c('patients', 'patient', ['read'])],
  },
  {
    id: 'users',
    route: '/admin',
    cells: ['user_management:read', 'user_management:write', 'user_management:delete', 'permission_management:write'],
  },

  // ── Pacientes ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'patients.list',
    route: '/admin/patients',
    // `patient:read` é o OPERACIONAL (status, funil, caso); nome e documento na lista vêm da
    // identidade, e as colunas clínicas da clínica — a lista é projetada pelo back (`lex` P1).
    cells: ['patient:read', 'patient:write', 'patient:delete', 'patient_identity:read', 'patient_clinical:read'],
  },
  { id: 'patients.kanban', route: '/admin/patients/kanban', cells: ['patient:read', 'patient:write', 'patient_identity:read'] },
  {
    id: 'patients.detail',
    route: '/admin/patients/:id',
    tabs: ['clinicalData', 'supportNetwork', 'contractedService', 'vacancies', 'matching', 'history'],
    containers: [
      c('identity', 'patient_identity', ['read', 'write']),
      c('clinical', 'patient_clinical', ['read', 'write'], 'clinicalData'),
      c('careTeam', 'patient_care_team', ['read'], 'clinicalData'),
      c('family', 'patient_family', ['read', 'write'], 'supportNetwork'),
      c('chat', 'patient_chat', ['read', 'write'], 'supportNetwork'),
      c('coverage', 'patient_coverage', ['read', 'write'], 'contractedService'),
      c('address', 'patient_address', ['read', 'write'], 'contractedService'),
      // Serviços contratados aparece em DUAS abas (Serviço contratado e Matching): uma célula,
      // exigida nas duas — a aba Matching some sem ela (o Enquadre é placeholder).
      c('services', 'patient_services', ['read', 'write'], 'contractedService', 'matching'),
      c('vacancies', 'vacancy', ['read'], 'vacancies'),
      // O operacional da tela numa linha só: cabeçalho (status, ativar, completude) e a aba de
      // histórico — mesmo recurso `patient`, uma célula de leitura e uma de escrita.
      c('operational', 'patient', ['read', 'write'], 'history'),
    ],
  },
  { id: 'patients.chatRoles', route: '/admin/patient-chat-roles', cells: ['patient:read', 'patient:write'] },
  { id: 'map', route: '/admin/mapa', cells: ['patient_address:read', 'worker:read'] },

  // ── Prestadores ────────────────────────────────────────────────────────────────────────────
  {
    id: 'workers.list',
    route: '/admin/workers',
    cells: ['worker:read', 'worker_contact:read', 'worker:export', 'talentum:write'],
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
      c('profile', 'worker', ['read', 'write'], 'availability'),
      c('contact', 'worker_contact', ['read']),
      // Dossiê = dados pessoais (nascimento, sexo, DNI, raça, religião…) E a linha de endereço —
      // a mesma célula da C3/F2; a rota projeta os dois juntos.
      c('dossier', 'worker_pii', ['read']),
      c('documents', 'worker_document', ['read', 'write', 'delete', 'validate'], 'documents'),
      c('encuadres', 'match', ['read'], 'encuadres'),
    ],
  },
  { id: 'tags', route: '/admin/tags', cells: ['worker:read', 'worker:write'] },

  // ── Vagas ──────────────────────────────────────────────────────────────────────────────────
  { id: 'vacancies.list', route: '/admin/vacancies', cells: ['vacancy:read', 'vacancy:write', 'talentum:write'] },
  { id: 'vacancies.create', route: '/admin/vacancies/new', cells: ['vacancy:read', 'vacancy:write'] },
  { id: 'vacancies.addressReview', route: '/admin/vacancies/pending-address-review', cells: ['vacancy:read', 'vacancy:write'] },
  {
    id: 'vacancies.talentum',
    route: '/admin/vacancies/:id/talentum',
    cells: ['vacancy:read', 'vacancy:write', 'talentum:write', 'prescreening:write'],
  },
  {
    id: 'vacancies.detail',
    route: '/admin/vacancies/:id',
    tabs: ['encuadres', 'talentum', 'links'],
    containers: [
      // `vacancy:delete` sem botão (ui-gate-debt.json): arquivar é status CLOSED via write. O caso
      // cobre cabeçalho, perfil requerido, links de reunião e a aba Links (tudo dado da vaga).
      c('case', 'vacancy', ['read', 'write'], 'links'),
      // O card Paciente mostra o NOME do paciente — dado de outro titular, célula de identidade
      // dele (a rota projeta; sem ela vem "Contato restrito").
      c('patient', 'patient_identity', ['read']),
      c('funnel', 'funnel', ['read', 'write'], 'encuadres'),
      c('match', 'match', ['read', 'execute'], 'encuadres'),
      c('invites', 'messaging', ['send'], 'encuadres'),
      c('prescreening', 'prescreening', ['read', 'write'], 'talentum'),
      c('talentum', 'talentum', ['read', 'write'], 'talentum'),
    ],
  },

  // ── Recrutamento e mensageria ──────────────────────────────────────────────────────────────
  { id: 'recruitment', route: '/admin/recruitment', cells: ['recruitment:read', 'match:read', 'talentum:read'] },
  { id: 'recruitment.health', route: '/admin/recruitment/health', cells: ['messaging:read'] },
  { id: 'recruitment.blocked', route: '/admin/recruitment/blocked-attempts', cells: ['recruitment:read'] },
  { id: 'messaging.stageMessages', route: '/admin/mensajes-por-etapa', cells: ['messaging:read', 'messaging:write'] },
  { id: 'messaging.templates', route: '/admin/plantillas', cells: ['messaging:read', 'messaging:write'] },
  { id: 'messaging.presentationInvite', route: '/admin/invitacion-presentacion', cells: ['messaging:read', 'messaging:write', 'messaging:send'] },

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

export function screenById(id: string, registry: readonly ScreenDef[] = SCREEN_REGISTRY): ScreenDef {
  const s = registry.find((x) => x.id === id);
  if (!s) throw new Error(`tela desconhecida no registro: ${id}`);
  return s;
}
