/**
 * D286 fase 2 — a seção de pacientes da Gestión a la Vista lê /patients/stats (patient:read):
 * sem a célula o container some e os indicadores de recrutamento ficam.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ManagementDashboardPage } from '../ManagementDashboardPage';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { ManagementDashboardApiService } from '@infrastructure/http/ManagementDashboardApiService';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@infrastructure/http/ManagementDashboardApiService', () => ({
  ManagementDashboardApiService: { getManagementDashboard: vi.fn(async () => { throw new Error('agregação fora do ar'); }) },
}));
vi.mock('@presentation/components/features/admin/ManagementDashboard/ZoneAnalyticsSection', () => ({
  ZoneAnalyticsSection: () => <div data-testid="mgmt-zone-analytics" />,
}));
vi.mock('@presentation/components/features/admin/ManagementDashboard/PacientesSection', () => ({
  PacientesSection: () => <section data-testid="mgmt-pacientes" />,
}));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

describe('ManagementDashboardPage — cada bloco por célula (D286)', () => {
  const PAYLOAD = {
    bigNumbers: null, pacientes: null, horas: { horasActivas: 0 }, equipoArmada: { pctRespostaRapidaArmado: 0 }, encuadres: null,
    prioridades: { items: [] }, cadastros: null, funnelPorPrestador: null, funnel: null, redacted: { numbers: true, registrations: true, funnel: true },
  };
  it('só dashboard_team + dashboard_priorities: os outros blocos NÃO desenham (nem leem o payload nulo)', async () => {
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockResolvedValueOnce(PAYLOAD as never);
    comEnforcement(['dashboard:read', 'dashboard_team:read', 'dashboard_priorities:read'], 'on');
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-content')).toBeInTheDocument());
    expect(screen.getByTestId('mgmt-equipo-armada')).toBeInTheDocument();
    expect(screen.getByTestId('mgmt-prioridades')).toBeInTheDocument();
    expect(screen.queryByTestId('mgmt-big-numbers')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mgmt-cadastros')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mgmt-funnel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mgmt-zone-analytics')).not.toBeInTheDocument();
  });
});

describe('ManagementDashboardPage — seção de pacientes por célula (D286 fase 2)', () => {
  it('dashboard:read sem patient:read: a seção de pacientes SOME (o resto da tela continua)', async () => {
    comEnforcement(['dashboard:read'], 'on');
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-error')).toBeInTheDocument());
    expect(screen.queryByTestId('mgmt-pacientes')).not.toBeInTheDocument();
  });

  it('com patient:read a seção aparece — mesmo com a agregação de recrutamento fora do ar', async () => {
    comEnforcement(['dashboard:read', 'patient:read'], 'on');
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-error')).toBeInTheDocument());
    expect(screen.getByTestId('mgmt-pacientes')).toBeInTheDocument();
  });

  it('enforcement=off: aparece, como antes', async () => {
    comEnforcement([], 'off');
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-pacientes')).toBeInTheDocument());
  });
});
