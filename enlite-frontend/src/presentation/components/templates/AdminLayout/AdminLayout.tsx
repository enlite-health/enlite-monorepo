import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdminNavItems } from '@presentation/config/adminNavigation';
import { AppSidebar } from '@presentation/components/templates/DashboardLayout';

export function AdminLayout() {
  const { logout, adminProfile } = useAdminAuth();
  const navigate = useNavigate();
  const navItems = useAdminNavItems();
  const location = useLocation();

  // O contrato de authz é recarregado ao mudar de ÁREA (1º segmento depois de
  // `/admin`): uma revogação feita por outro gestor vale na próxima área que a
  // pessoa abrir, sem esperar logout. Dentro da mesma área não recarrega — a
  // navegação entre páginas irmãs não pode virar uma chamada por clique.
  const fetchAuthz = useAdminAuthStore((s) => s.fetchAuthz);
  const area = location.pathname.split('/')[2] ?? '';
  const areaAnterior = useRef<string | null>(null);
  useEffect(() => {
    if (areaAnterior.current !== null && areaAnterior.current !== area) void fetchAuthz();
    areaAnterior.current = area;
  }, [area, fetchAuthz]);

  const handleLogout = async () => {
    await logout();
    navigate('/admin/login');
  };

  return (
    // `data-testid` estável: é o marcador "o PAINEL renderizou" dos e2e de fronteira (a
    // sidebar é compartilhada com o app do prestador e não serve de prova).
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50" data-testid="admin-layout">
      <AppSidebar
        navItems={navItems}
        userName={adminProfile?.displayName || adminProfile?.email || 'Admin'}
        onMenuClick={handleLogout}
      />

      <main className="flex-1 ml-[200px] overflow-y-auto">
        <div key={location.pathname} className="container mx-auto p-6 page-enter">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
