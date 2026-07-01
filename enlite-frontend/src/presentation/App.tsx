import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { ProtectedRoute } from './components/features/auth/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RoleBasedHome } from './pages/home/RoleBasedHome';
import { RegisterPage } from './pages/RegisterPage';
import { CompleteWhatsappPage } from './pages/CompleteWhatsappPage';
import { WorkerProfilePage } from './pages/WorkerProfilePage';
import { AdminErrorBoundary } from './components/features/admin/AdminErrorBoundary';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { CrashNow } from './components/RouteErrorBoundary/__CrashNow';
import { lazyWithRetry } from './utils/lazyWithRetry';

// Import direto — páginas e layout carregam junto com o bundle admin
import { AdminLayout } from './components/templates/AdminLayout/AdminLayout';
import { AdminLoginPage } from './pages/admin/AdminLoginPage';
import { AuthActionPage } from './pages/auth/AuthActionPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AdminVacanciesPage } from './pages/admin/AdminVacanciesPage';
import { AdminRecruitmentPage } from './pages/admin/AdminRecruitmentPage';
import { AdminWorkersPage } from './pages/admin/AdminWorkersPage';
import { AdminPatientsPage } from './pages/admin/AdminPatientsPage';
import VacancyDetailPage from './pages/admin/VacancyDetailPage';
import CreateVacancyPage from './pages/admin/CreateVacancyPage';
import TalentumConfigPage from './pages/admin/TalentumConfigPage';
import WorkerDetailPage from './pages/admin/WorkerDetailPage';
import PatientDetailPage from './pages/admin/PatientDetailPage';
import { PendingAddressReviewPage } from './pages/admin/PendingAddressReviewPage';
import { RecruitmentHealthPage } from './pages/admin/RecruitmentHealthPage';
import { BlockedAttemptsPage } from './pages/admin/BlockedAttemptsPage';
import TagCatalogPage from './pages/admin/TagCatalogPage';
import { DedupCenterPage } from './pages/admin/DedupCenterPage/DedupCenterPage';
import { NewVersionBanner } from './components/molecules/NewVersionBanner/NewVersionBanner';
import { Toaster } from './components/molecules/Toaster';

// Lazy-loaded pages — com retry automático para falhas de chunk após deploy
const PublicVacancyPage = lazyWithRetry(() => import('./pages/public/PublicVacancyPage'));
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
          <Route path="vacancies" element={<AdminVacanciesPage />} />
          <Route path="vacancies/new" element={<CreateVacancyPage />} />
          <Route path="vacancies/pending-address-review" element={<PendingAddressReviewPage />} />
          <Route path="vacancies/:id/edit" element={<CreateVacancyPage />} />
          <Route path="vacancies/:id/talentum" element={<TalentumConfigPage />} />
          <Route path="vacancies/:id" element={<VacancyDetailPage />} />
          <Route path="recruitment" element={<AdminRecruitmentPage />} />
          <Route path="recruitment/health" element={<RecruitmentHealthPage />} />
          <Route path="recruitment/blocked-attempts" element={<BlockedAttemptsPage />} />
          <Route path="workers" element={<AdminWorkersPage />} />
          <Route path="workers/:id" element={<WorkerDetailPage />} />
          <Route path="patients" element={<AdminPatientsPage />} />
          <Route path="patients/:id" element={<PatientDetailPage />} />
          <Route path="tags" element={<TagCatalogPage />} />
          <Route path="dedup" element={<DedupCenterPage />} />
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
