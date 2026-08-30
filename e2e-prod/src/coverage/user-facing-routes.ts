/**
 * FLOW-MAP — o DENOMINADOR da garantia de cobertura.
 *
 * Cada rota user-facing do app (front + API pública/de usuário) vive aqui como dado
 * commitado. O meta-teste `coverage.spec.ts` cruza esta lista (denominador) contra as
 * tags `@route:` declaradas nos specs (numerador). Rota nova no app → ENTRA aqui, senão
 * fica INVISÍVEL ao gate (nunca cobrada). Rota que sai do app → sai daqui (senão vira
 * "coberta que sumiu" ou nunca-coberta eterna).
 *
 * `excluded` = motivo pelo qual a rota NÃO conta no denominador (redirect, só-DEV,
 * catch-all). Excluídas são listadas pra auditoria, mas não puxam o % pra baixo.
 *
 * Fonte: manifesto de rotas real do enlite-frontend (React Router) + rotas de API
 * pública/de-usuário do worker-functions. Determinístico — não inferido "pela vibe".
 */

export type RouteSurface = 'public' | 'worker' | 'admin' | 'api';
export type RouteTier = 'smoke' | 'regression';

export interface UserFacingRoute {
  /** String EXATA da rota — tem que casar byte-a-byte com a tag `@route:<X>` do spec. */
  route: string;
  surface: RouteSurface;
  tier: RouteTier;
  /** Se presente: rota fora do denominador. Valor = motivo humano da exclusão. */
  excluded?: string;
}

export const USER_FACING_ROUTES: readonly UserFacingRoute[] = [
  // ─────────────────────────── FRONTEND · public ───────────────────────────
  { route: '/login', surface: 'public', tier: 'smoke' },
  { route: '/register', surface: 'public', tier: 'smoke' },
  { route: '/complete-whatsapp', surface: 'public', tier: 'regression' },
  { route: '/auth/action', surface: 'public', tier: 'regression' },
  { route: '/vacantes/:id', surface: 'public', tier: 'smoke' },
  {
    route: '/vacancies/:id',
    surface: 'public',
    tier: 'smoke',
    excluded: 'redirect EN→ES para /vacantes/:id',
  },

  // ─────────────────────────── FRONTEND · worker ───────────────────────────
  // Exigem auth + dados → tier regression.
  { route: '/worker/profile', surface: 'worker', tier: 'regression' },
  { route: '/', surface: 'worker', tier: 'regression' }, // RoleBasedHome
  {
    route: '/worker-registration',
    surface: 'worker',
    tier: 'regression',
    excluded: 'redirect para /worker/profile',
  },

  // ─────────────────────────── FRONTEND · admin ────────────────────────────
  // Todas regression (auth + dados) EXCETO /admin/login que é smoke.
  { route: '/admin/login', surface: 'admin', tier: 'smoke' },
  { route: '/admin', surface: 'admin', tier: 'regression' },
  { route: '/admin/vacancies', surface: 'admin', tier: 'regression' },
  { route: '/admin/vacancies/new', surface: 'admin', tier: 'regression' },
  { route: '/admin/vacancies/pending-address-review', surface: 'admin', tier: 'regression' },
  { route: '/admin/vacancies/:id/edit', surface: 'admin', tier: 'regression' },
  { route: '/admin/vacancies/:id/talentum', surface: 'admin', tier: 'regression' },
  { route: '/admin/vacancies/:id', surface: 'admin', tier: 'regression' },
  { route: '/admin/dashboard', surface: 'admin', tier: 'regression' },
  { route: '/admin/recruitment', surface: 'admin', tier: 'regression' },
  { route: '/admin/recruitment/health', surface: 'admin', tier: 'regression' },
  { route: '/admin/recruitment/blocked-attempts', surface: 'admin', tier: 'regression' },
  { route: '/admin/workers', surface: 'admin', tier: 'regression' },
  { route: '/admin/workers/:id', surface: 'admin', tier: 'regression' },
  { route: '/admin/patients', surface: 'admin', tier: 'regression' },
  { route: '/admin/patients/:id', surface: 'admin', tier: 'regression' },
  // App de Pacientes (PR #166) — rotas que existiam em produção sem entrar aqui.
  // Foi o gate que denunciou, ao rodar a jornada nova. Manifesto é denominador:
  // rota fora dele é cobertura fantasma.
  { route: '/admin/patients/kanban', surface: 'admin', tier: 'regression' },
  { route: '/admin/tags', surface: 'admin', tier: 'regression' },
  // Mapa do painel (REQ-04 · DEC-14, subiu em 30/08). Mesma história da linha acima:
  // a tela estava em produção e fora do denominador — invisível ao gate, portanto
  // nunca cobrada. Entra junto com a Spec 009, que a cobre.
  { route: '/admin/mapa', surface: 'admin', tier: 'regression' },
  // Páginas PÚBLICAS de admissão (form B2C multi-país, sem login).
  { route: '/admission-ar', surface: 'public', tier: 'smoke' },
  { route: '/admission-br', surface: 'public', tier: 'smoke' },
  { route: '/admin/dedup', surface: 'admin', tier: 'regression' },
  { route: '/admin/api-docs', surface: 'admin', tier: 'regression' },

  // ───────────────────────── FRONTEND · excluídas ──────────────────────────
  {
    route: '/__error-test',
    surface: 'public',
    tier: 'regression',
    excluded: 'só DEV (import.meta.env.DEV)',
  },
  {
    route: '*',
    surface: 'public',
    tier: 'regression',
    excluded: 'catch-all: redirect para /',
  },

  // ───────────────────────── API · pública / de-usuário ────────────────────
  { route: 'GET /api/public/v1/jobs', surface: 'api', tier: 'smoke' },
  { route: 'GET /api/vacancies/:id', surface: 'api', tier: 'smoke' },
  { route: 'GET /api/jobs', surface: 'api', tier: 'smoke' },
  { route: 'GET /health', surface: 'api', tier: 'smoke' },
  // Check NEGATIVO: deve 401/403 sem secret (gate interno não vaza pra fora).
  { route: 'GET /api/internal/vertex-health', surface: 'api', tier: 'smoke' },
  { route: 'POST /api/workers/init', surface: 'api', tier: 'regression' },
  { route: 'POST /api/auth/claim/start', surface: 'api', tier: 'regression' },
  { route: 'POST /api/auth/claim/confirm', surface: 'api', tier: 'regression' },
  { route: 'GET /api/workers/lookup', surface: 'api', tier: 'regression' },

  // ─────────── API · perímetro de auth (checks NEGATIVOS, read-only) ────────
  // Endpoints protegidos: SEM Authorization têm que responder 401/403. Provar isso
  // é READ-ONLY e seguro (1 request cada, sem efeito colateral — o gate barra antes
  // de qualquer lógica). tier 'regression' (exigem auth pro caminho positivo); a prova
  // negativa (@depth:auth) roda no smoke porque é barata e sem lixo.
  { route: 'GET /api/admin/workers', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/workers/stats', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/patients', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/patients/funnel', surface: 'api', tier: 'regression' },
  { route: 'POST /api/admin/patients', surface: 'api', tier: 'regression' },
  // Os dois mapas. POST (e não GET) de propósito: o centro do raio é a casa de alguém
  // e a URL crua vai para o log do Cloud Run (lex 29/08, C2).
  { route: 'POST /api/admin/patients/map', surface: 'api', tier: 'regression' },
  { route: 'POST /api/admin/workers/map', surface: 'api', tier: 'regression' },
  { route: 'PUT /api/admin/patients/:id/status', surface: 'api', tier: 'regression' },
  { route: 'POST /api/admin/patients/:id/activate', surface: 'api', tier: 'regression' },
  { route: 'PATCH /api/admin/patients/:id/:section', surface: 'api', tier: 'regression' },
  // Ferramentas do synthetic monitoring (admin-only): marcar e purgar sintético.
  { route: 'PATCH /api/admin/patients/:id/test-flag', surface: 'api', tier: 'regression' },
  { route: 'DELETE /api/admin/patients/:id', surface: 'api', tier: 'regression' },
  // Superfície PÚBLICA do fluxo de admissão (sem auth, rate-limited).
  { route: 'POST /api/public/v1/leads', surface: 'api', tier: 'smoke' },
  { route: 'GET /api/public/v1/admission/slots', surface: 'api', tier: 'smoke' },
  { route: 'POST /api/public/v1/admission/book', surface: 'api', tier: 'smoke' },
  { route: 'GET /api/admin/vacancies', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/dedup/groups', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/recruitment/health', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/users', surface: 'api', tier: 'regression' },
  { route: 'GET /analytics/workers', surface: 'api', tier: 'regression' },
  { route: 'GET /analytics/dashboard/global', surface: 'api', tier: 'regression' },
  { route: 'GET /api/workers/me', surface: 'api', tier: 'regression' },
  { route: 'GET /api/workers/me/documents', surface: 'api', tier: 'regression' },
  { route: 'GET /api/workers/status-dashboard', surface: 'api', tier: 'regression' },
  // POST seguro: internalAuthMiddleware barra com 403 ANTES de processar o outbox.
  { route: 'POST /api/internal/outbox/process', surface: 'api', tier: 'regression' },

  // Perímetro de auth adicional (confirmado no router + probado 401 em prod 2026-07-11).
  // requireStaff/requireAuth/adminOnly — check negativo (sem token → 401) roda no smoke.
  { route: 'GET /api/admin/vacancies/stats', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/workers/filter-options', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/patients/stats', surface: 'api', tier: 'regression' },
  { route: 'GET /analytics/dashboard/management', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/worker-tags', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/messaging/templates', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/dedup/history', surface: 'api', tier: 'regression' },
  { route: 'GET /api/workers/me/availability', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/recruitment/progreso', surface: 'api', tier: 'regression' },

  // ─────── API · admin write/error endpoints (exercitados pela leva admin-error) ──────
  // Rotas de escrita/erro do painel admin cobertas por specs de CAMINHO DE ERRO em
  // admin/*-errors.admin.ts (validação/gate que barra antes de gravar). São /api/admin/*
  // → surface 'api' (convenção deste flow-map). Exigem auth pro caminho positivo → tier
  // 'regression'. Registradas aqui pra não ficarem invisíveis ao gate (nem virar órfãs).
  { route: 'POST /api/admin/vacancies', surface: 'api', tier: 'regression' },
  { route: 'PUT /api/admin/vacancies/:id', surface: 'api', tier: 'regression' },
  // Talentum · publicação de vaga + pré-screening (ticket 86ajfm80t). O recrutador
  // dispara pelo painel (/admin/vacancies/:id/talentum); a jornada de regressão
  // talentum-prescreening-audio prova o fluxo real contra a Talentum de prod.
  { route: 'POST /api/admin/vacancies/:id/prescreening-config', surface: 'api', tier: 'regression' },
  { route: 'POST /api/admin/vacancies/:id/publish-talentum', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/vacancies/:id/talentum-status', surface: 'api', tier: 'regression' },
  { route: 'DELETE /api/admin/vacancies/:id/publish-talentum', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/patients/:id', surface: 'api', tier: 'regression' },
  { route: 'POST /api/admin/worker-tags', surface: 'api', tier: 'regression' },
  { route: 'GET /api/admin/dedup/groups/:phoneNormalized', surface: 'api', tier: 'regression' },
  { route: 'POST /api/admin/dedup/manual-group', surface: 'api', tier: 'regression' },
  { route: 'POST /api/admin/dedup/merge', surface: 'api', tier: 'regression' },
  { route: 'PUT /api/admin/encuadres/:id/move', surface: 'api', tier: 'regression' },
];
