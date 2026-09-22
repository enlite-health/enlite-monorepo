import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdminNavItems } from '@presentation/config/adminNavigation';
import { usePresenceHeartbeat } from '@hooks/admin/usePresenceHeartbeat';
import { AppSidebar } from '@presentation/components/templates/DashboardLayout';

export function AdminLayout() {
  const { logout, adminProfile } = useAdminAuth();
  const navigate = useNavigate();
  const navItems = useAdminNavItems();
  const location = useLocation();
  // Presença simples (spec 022, Rodada 2/R2-F): heartbeat a cada ~60s enquanto o painel admin
  // está montado — UMA vez aqui, nunca por página (o `AdminLayout` é o único ancestral comum de
  // toda rota `/admin/*`).
  usePresenceHeartbeat();

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
