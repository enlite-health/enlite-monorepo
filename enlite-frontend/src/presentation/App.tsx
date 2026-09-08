import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { ProtectedRoute } from './components/features/auth/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RoleBasedHome } from './pages/home/RoleBasedHome';
import { RegisterPage } from './pages/RegisterPage';
import { CompleteWhatsappPage } from './pages/CompleteWhatsappPage';
import { WorkerProfilePage } from './pages/WorkerProfilePage';
import { AdminErrorBoundary } from './components/features/admin/AdminErrorBoundary';
import { FeatureRouteGate } from './components/features/access';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { CrashNow } from './components/RouteErrorBoundary/__CrashNow';
import { lazyWithRetry } from './utils/lazyWithRetry';

// Import direto — páginas e layout carregam junto com o bundle admin
import { AdminLayout } from './components/templates/AdminLayout/AdminLayout';
import { AdminLoginPage } from './pages/admin/AdminLoginPage';
import { AuthActionPage } from './pages/auth/AuthActionPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AccessPage, GroupDetailPage, CountryFeaturesPage, AuditPage } from './pages/admin/access';
import { AdminVacanciesPage } from './pages/admin/AdminVacanciesPage';
import { AdminRecruitmentPage } from './pages/admin/AdminRecruitmentPage';
import { ManagementDashboardPage } from './pages/admin/ManagementDashboardPage';
import { AdminWorkersPage } from './pages/admin/AdminWorkersPage';
import { AdminPatientsPage } from './pages/admin/AdminPatientsPage';
import VacancyDetailPage from './pages/admin/VacancyDetailPage';
import CreateVacancyPage from './pages/admin/CreateVacancyPage';
import TalentumConfigPage from './pages/admin/TalentumConfigPage';
import WorkerDetailPage from './pages/admin/WorkerDetailPage';
import PatientDetailPage from './pages/admin/PatientDetailPage';
import { PatientKanbanPage } from './pages/admin/PatientKanbanPage';
import { AdminMapPage } from './pages/admin/AdminMapPage/AdminMapPage';
import { PendingAddressReviewPage } from './pages/admin/PendingAddressReviewPage';
import { RecruitmentHealthPage } from './pages/admin/RecruitmentHealthPage';
import { BlockedAttemptsPage } from './pages/admin/BlockedAttemptsPage';
import TagCatalogPage from './pages/admin/TagCatalogPage';
import { FunnelStageMessagesPage } from './pages/admin/FunnelStageMessagesPage';
import { TemplateCatalogPage } from './pages/admin/TemplateCatalogPage';
import { TemplateCatalogDetailPage } from './pages/admin/TemplateCatalogDetailPage';
import { TemplateDraftsPage } from './pages/admin/TemplateDraftsPage';
import PatientChatRolesPage from './pages/admin/PatientChatRolesPage';
import TherapeuticCatalogPage from './pages/admin/TherapeuticCatalogPage/TherapeuticCatalogPage';
import PresentationInvitePage from './pages/admin/PresentationInvitePage';
import { DedupCenterPage } from './pages/admin/DedupCenterPage/DedupCenterPage';
import { NewVersionBanner } from './components/molecules/NewVersionBanner/NewVersionBanner';
import { Toaster } from './components/molecules/Toaster';
import { InviteProgressPanel } from './components/features/admin/VacancyMatch/InviteProgressPanel';

// Lazy-loaded pages — com retry automático para falhas de chunk após deploy
const PublicVacancyPage = lazyWithRetry(() => import('./pages/public/PublicVacancyPage'));
// Public B2C patient intake (Task 2) — no auth, outside the admin shell.
// Same page, parametrized by country; wrapped so each lazy module is a
// zero-arg component (the prop is bound here) and keeps chunk-retry.
const AdmisionArPage = lazyWithRetry(() =>
  import('./pages/public/AdmisionPage').then((m) => ({
    default: () => <m.default country="AR" />,
  })),
);
const AdmisionBrPage = lazyWithRetry(() =>
  import('./pages/public/AdmisionPage').then((m) => ({
    default: () => <m.default country="BR" />,
  })),
);
// Swagger UI é pesado (~500kb gzipped) — lazy load isola o chunk e só baixa
// quando staff abre /admin/api-docs.
const AdminApiDocsPage = lazyWithRetry(() => import('./pages/admin/AdminApiDocsPage'));
// Mantém lazy — são a fronteira worker/admin; carregados uma única vez
const AdminProtectedRoute = lazy(() => import('./components/features/admin/AdminProtectedRoute').then(m => ({ default: m.AdminProtectedRoute })));
const AdminLoginGuard = lazy(() => import('./components/features/admin/AdminLoginGuard').then(m => ({ default: m.AdminLoginGuard })));

const AdminFallback = () => (
  <div className="min-h-screen flex items-center justify-center bg-background">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

/**
 * Alias EN → ES para a rota pública de vaga.
 * O link correto é /vacantes/:id (espanhol). Mensagens disparadas antes do fix
 * no backend (VacancyAutoInviteHandler) saíram com /vacancies/:id em inglês e
 * caíam em tela branca. Este redirect resgata esses links já enviados,
 * preservando id e query string.
 */
export function VacancyEnAliasRedirect() {
  const { id } = useParams();
  const { search } = useLocation();
  // Limpa ponto/espaço no fim — links pré-migration 178/210 saíram como
  // /vacancies/<id>. (autolink do WhatsApp colava o ponto na URL).
  const cleanId = (id ?? '').replace(/[.\s]+$/, '');
  return <Navigate to={`/vacantes/${cleanId}${search}`} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <NewVersionBanner />
      <Toaster />
      <InviteProgressPanel />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/complete-whatsapp" element={<CompleteWhatsappPage />} />
        <Route path="/auth/action" element={<AuthActionPage />} />
        <Route
          path="/vacantes/:id"
          element={
            <Suspense fallback={<AdminFallback />}>
              <PublicVacancyPage />
            </Suspense>
          }
        />
        {/* Alias EN → ES: resgata links antigos enviados como /vacancies/:id */}
        <Route path="/vacancies/:id" element={<VacancyEnAliasRedirect />} />
        {/* Public patient intake (Task 2) — country-parametrized native scheduler.
            AR → es, BR → pt-BR (page forces its own language). The WP
            /registrar/admisión iframe points at the country-specific route. */}
        <Route
          path="/admission-ar"
          element={
            <Suspense fallback={<AdminFallback />}>
              <RouteErrorBoundary>
                <AdmisionArPage />
              </RouteErrorBoundary>
            </Suspense>
          }
        />
        <Route
          path="/admission-br"
          element={
            <Suspense fallback={<AdminFallback />}>
              <RouteErrorBoundary>
                <AdmisionBrPage />
              </RouteErrorBoundary>
            </Suspense>
          }
        />
        {/* Compat alias: the original /admision now points at AR. */}
        <Route path="/admision" element={<Navigate to="/admission-ar" replace />} />
        <Route
          path="/worker-registration"
          element={<Navigate to="/worker/profile" replace />}
        />
        <Route
          path="/worker/profile"
          element={
            <ProtectedRoute redirectTo="/login?next=/worker/profile">
              <RouteErrorBoundary>
                <WorkerProfilePage />
              </RouteErrorBoundary>
            </ProtectedRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <RouteErrorBoundary>
                <RoleBasedHome />
              </RouteErrorBoundary>
            </ProtectedRoute>
          }
        />
        {/* Rota de crash — só disponível em DEV para validação visual do ErrorBoundary */}
        {import.meta.env.DEV && (
          <Route
            path="/__error-test"
            element={
              <RouteErrorBoundary>
                <CrashNow />
              </RouteErrorBoundary>
            }
          />
        )}

        {/* Admin module — lazy-loaded, isolated from worker module */}
        <Route path="/admin/login" element={
          <AdminErrorBoundary>
            <Suspense fallback={<AdminFallback />}>
              <AdminLoginGuard>
                <AdminLoginPage />
              </AdminLoginGuard>
            </Suspense>
          </AdminErrorBoundary>
        } />
        {/* Nested routes — AdminLayout is the persistent shell */}
        <Route
          path="/admin"
          element={
            <AdminErrorBoundary>
              <Suspense fallback={<AdminFallback />}>
                <AdminProtectedRoute>
                  <AdminLayout />
                </AdminProtectedRoute>
              </Suspense>
            </AdminErrorBoundary>
          }
        >
          <Route index element={<AdminUsersPage />} />
          {/* B2 (D268) — cada rota de tela `screen:*` envolvida por `FeatureRouteGate`:
              desligada no país do ator → redireciona a `/admin` (mesma postura que
              `AccessGate` já usa para `hidden`). `tags`/`patient-chat-roles`/`dedup`/
              `api-docs` não têm chave `screen:*` no manifest — ficam de fora. */}
          <Route path="vacancies" element={<FeatureRouteGate feature="screen:vacancies"><AdminVacanciesPage /></FeatureRouteGate>} />
          <Route path="vacancies/new" element={<FeatureRouteGate feature="screen:vacancies"><CreateVacancyPage /></FeatureRouteGate>} />
          <Route path="vacancies/pending-address-review" element={<FeatureRouteGate feature="screen:vacancies"><PendingAddressReviewPage /></FeatureRouteGate>} />
          <Route path="vacancies/:id/edit" element={<FeatureRouteGate feature="screen:vacancies"><CreateVacancyPage /></FeatureRouteGate>} />
          <Route path="vacancies/:id/talentum" element={<FeatureRouteGate feature="screen:talentum"><TalentumConfigPage /></FeatureRouteGate>} />
          <Route path="vacancies/:id" element={<FeatureRouteGate feature="screen:vacancies"><VacancyDetailPage /></FeatureRouteGate>} />
          <Route path="dashboard" element={<FeatureRouteGate feature="screen:management-dashboard"><ManagementDashboardPage /></FeatureRouteGate>} />
          <Route path="recruitment" element={<FeatureRouteGate feature="screen:funnel"><AdminRecruitmentPage /></FeatureRouteGate>} />
          <Route path="recruitment/health" element={<FeatureRouteGate feature="screen:funnel"><RecruitmentHealthPage /></FeatureRouteGate>} />
          <Route path="recruitment/blocked-attempts" element={<FeatureRouteGate feature="screen:funnel"><BlockedAttemptsPage /></FeatureRouteGate>} />
          <Route path="workers" element={<FeatureRouteGate feature="screen:workers"><AdminWorkersPage /></FeatureRouteGate>} />
          <Route path="workers/:id" element={<FeatureRouteGate feature="screen:workers"><WorkerDetailPage /></FeatureRouteGate>} />
          <Route path="patients" element={<FeatureRouteGate feature="screen:patients"><AdminPatientsPage /></FeatureRouteGate>} />
          <Route path="patients/kanban" element={<FeatureRouteGate feature="screen:patients"><PatientKanbanPage /></FeatureRouteGate>} />
          <Route path="patients/:id" element={<FeatureRouteGate feature="screen:patients"><PatientDetailPage /></FeatureRouteGate>} />
          {/* `/admin/mapa` (main, 05/09) não tem chave `screen:*` no manifest — fica sem FeatureRouteGate, como tags/dedup. */}
          <Route path="mapa" element={<AdminMapPage />} />
          <Route path="tags" element={<TagCatalogPage />} />
          <Route path="mensajes-por-etapa" element={<FunnelStageMessagesPage />} />
          <Route path="plantillas" element={<TemplateCatalogPage />} />
          <Route path="plantillas/registrar" element={<TemplateDraftsPage />} />
          {/* Depois de "registrar", senão o literal seria capturado pelo :slug. */}
          <Route path="plantillas/:slug" element={<TemplateCatalogDetailPage />} />
          <Route path="patient-chat-roles" element={<PatientChatRolesPage />} />
          {/* Spec 017: uma TELA por catálogo do projeto terapêutico (célula própria cada); sem `screen:*` no manifest, como patient-chat-roles. */}
          <Route path="catalogos/objetivos-especificos" element={<TherapeuticCatalogPage kind="specific-objectives" />} />
          <Route path="catalogos/actividades" element={<TherapeuticCatalogPage kind="activities" />} />
          <Route path="catalogos/tipos-de-patologia" element={<TherapeuticCatalogPage kind="pathology-types" />} />
          <Route path="invitacion-presentacion" element={<PresentationInvitePage />} />
          <Route path="dedup" element={<DedupCenterPage />} />
          {/* Painel de acessos — cada página se fecha sozinha em `permission_management:read` (AccessGate). */}
          <Route path="access" element={<FeatureRouteGate feature="screen:access-permissions"><AccessPage /></FeatureRouteGate>} />
          <Route path="access/groups/:id" element={<FeatureRouteGate feature="screen:access-permissions"><GroupDetailPage /></FeatureRouteGate>} />
          <Route path="access/features" element={<FeatureRouteGate feature="screen:access-permissions"><CountryFeaturesPage /></FeatureRouteGate>} />
          <Route path="access/audit" element={<FeatureRouteGate feature="screen:access-permissions"><AuditPage /></FeatureRouteGate>} />
          <Route
            path="api-docs"
            element={
              <Suspense fallback={<AdminFallback />}>
                <AdminApiDocsPage />
              </Suspense>
            }
          />
        </Route>
        {/* Catch-all: rota desconhecida redireciona para home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
