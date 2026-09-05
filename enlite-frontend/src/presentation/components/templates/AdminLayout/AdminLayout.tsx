import { Outlet, useLocation } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { useAdminNavItems } from '@presentation/config/adminNavigation';
import { AppSidebar } from '@presentation/components/templates/DashboardLayout';

export function AdminLayout() {
  const { logout, adminProfile } = useAdminAuth();
  const navigate = useNavigate();
  const navItems = useAdminNavItems();
  const location = useLocation();

  const handleLogout = async () => {
    await logout();
    navigate('/admin/login');
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50">
      <AppSidebar
        navItems={navItems}
        userName={adminProfile?.displayName || adminProfile?.email || 'Admin'}
        onMenuClick={handleLogout}
      />

      {/* `relative` (05/09): o <main> é o ÚNICO rolável da tela. Sem ele, um filho `position:absolute`
          sem ancestral posicionado (ex.: <span class="sr-only"> dentro de um <th>, Tailwind `sr-only`
          é absoluto) tem o <body> como containing block, escapa do clip do main e estica o DOCUMENTO
          — medido na ficha do paciente, aba "Servicio Contratado": html.scrollHeight 958 num viewport
          de 700. Resultado: a operadora rola o main até o fim e depois a página inteira rola de novo
          ("scroll duplo"). Com `relative`, o main vira o containing block e clipa o que escapava. */}
      <main className="relative flex-1 ml-[200px] overflow-y-auto">
        <div key={location.pathname} className="container mx-auto p-6 page-enter">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
