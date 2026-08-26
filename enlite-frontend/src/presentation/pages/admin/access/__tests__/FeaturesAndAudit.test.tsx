import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CountryFeaturesPage } from '../CountryFeaturesPage';
import { AuditPage } from '../AuditPage';
import { postura, renderRota } from './helpers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/components/ui/skeletons', () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = { listCountryFeatures: vi.fn(), setCountryFeature: vi.fn(), queryAudit: vi.fn() };
vi.mock('@infrastructure/http/AdminPermissionsApiService', () => ({
  AdminPermissionsApiService: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, ReturnType<typeof vi.fn>>)[k](...a) }),
}));

const FEATURE = { country: 'AR', featureKey: 'screen:agenda', enabled: true, config: null, source: 'override', reason: 'x', updatedBy: 'u', updatedAt: '2026-08-01T00:00:00Z' };
const LINHA = { id: 'a1', userId: 'uid-x', resource: 'worker', action: 'read', resourceId: '<oculto>', decision: 'DENY', createdAt: '2026-08-01T00:00:00Z', country: 'BR' };

describe('CountryFeaturesPage', () => {
  beforeEach(() => {
    api.listCountryFeatures.mockReset().mockResolvedValue([FEATURE]);
    api.setCountryFeature.mockReset().mockResolvedValue(undefined);
  });

  it('hidden → redireciona', async () => {
    postura('hidden');
    renderRota(<CountryFeaturesPage />, '/admin/access/features');
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
  });

  it('read: mostra a matriz e NÃO oferece ligar/desligar nem o campo de motivo', async () => {
    postura('read');
    renderRota(<CountryFeaturesPage />, '/admin/access/features');
    expect(await screen.findByText('screen:agenda')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'admin.access.features.disable' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('admin.access.features.reason')).not.toBeInTheDocument();
  });

  it('write: desligar chama a API com enabled invertido e o motivo', async () => {
    postura('write');
    renderRota(<CountryFeaturesPage />, '/admin/access/features');
    await screen.findByText('screen:agenda');
    await userEvent.type(screen.getByLabelText('admin.access.features.reason'), 'piloto');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.features.disable' }));
    await waitFor(() => expect(api.setCountryFeature).toHaveBeenCalledWith('AR', 'screen:agenda', { enabled: false, config: null, reason: 'piloto' }));
  });
});

describe('AuditPage', () => {
  beforeEach(() => api.queryAudit.mockReset().mockResolvedValue([LINHA]));

  it('read: mostra a trilha com o resourceId mascarado como veio', async () => {
    postura('read');
    renderRota(<AuditPage />, '/admin/access/audit');
    expect(await screen.findByText('<oculto>')).toBeInTheDocument();
    expect(screen.getByText('DENY')).toBeInTheDocument();
  });

  it('buscar repassa os filtros tipados', async () => {
    postura('read');
    renderRota(<AuditPage />, '/admin/access/audit');
    await screen.findByText('DENY');
    await userEvent.type(screen.getByLabelText('admin.access.audit.resource'), 'worker');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.audit.search' }));
    await waitFor(() => expect(api.queryAudit).toHaveBeenLastCalledWith({ userId: undefined, resource: 'worker', limit: 100 }));
  });
});

describe('lex C1 — máscara do Clarity nas tabelas com dado de pessoa', () => {
  it('a trilha de auditoria carrega `data-clarity-mask`', async () => {
    api.queryAudit.mockReset().mockResolvedValue([LINHA]);
    postura('read');
    renderRota(<AuditPage />, '/admin/access/audit');
    await screen.findByText('DENY');
    expect(document.querySelector('table[data-clarity-mask="True"]')).not.toBeNull();
  });
});
