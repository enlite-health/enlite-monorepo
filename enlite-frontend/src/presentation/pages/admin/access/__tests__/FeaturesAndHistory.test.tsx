import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CountryFeaturesPage } from '../CountryFeaturesPage';
import { PermissionHistoryPage } from '../PermissionHistoryPage';
import { postura, renderRota, GRUPO } from './helpers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/components/ui/skeletons', () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = {
  listCountryFeatures: vi.fn(),
  setCountryFeature: vi.fn(),
  queryHistory: vi.fn(),
  listGroups: vi.fn(),
};
vi.mock('@infrastructure/http/AdminPermissionsApiService', () => ({
  AdminPermissionsApiService: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, ReturnType<typeof vi.fn>>)[k](...a) }),
}));

const FEATURE = { country: 'AR', featureKey: 'screen:agenda', enabled: true, config: null, source: 'override', reason: 'x', updatedBy: 'u', updatedAt: '2026-08-01T00:00:00Z' };

const EVENTO_PERMISSAO = {
  eventType: 'permission', occurredAt: '2026-09-20T00:00:00Z', groupId: GRUPO.id, groupName: GRUPO.name,
  actorUid: 'uid-0', actorDisplayName: 'Ana Gestora', actorEmail: 'ana@enlite.health',
  op: 'add', resource: 'worker', action: 'read',
  subjectUserId: null, subjectDisplayName: null, subjectEmail: null,
};
const EVENTO_MEMBRO = {
  eventType: 'member', occurredAt: '2026-09-21T00:00:00Z', groupId: GRUPO.id, groupName: GRUPO.name,
  actorUid: 'uid-0', actorDisplayName: 'Ana Gestora', actorEmail: 'ana@enlite.health',
  op: 'remove', resource: null, action: null,
  subjectUserId: 'uid-maria', subjectDisplayName: null, subjectEmail: 'maria@enlite.health',
};

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

describe('PermissionHistoryPage', () => {
  beforeEach(() => {
    api.queryHistory.mockReset().mockResolvedValue([EVENTO_PERMISSAO, EVENTO_MEMBRO]);
    api.listGroups.mockReset().mockResolvedValue([GRUPO]);
  });

  it('read: mostra as DUAS linhas, com chip visualmente distinto por tipo', async () => {
    postura('read');
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    await screen.findAllByText('Ana Gestora');
    expect(screen.getByTestId('chip-permission')).toBeInTheDocument();
    expect(screen.getByTestId('chip-member')).toBeInTheDocument();
  });

  it('linha de PERMISSÃO mostra o rótulo da célula (recurso · ação), não a chave crua', async () => {
    postura('read');
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    await screen.findAllByText('Ana Gestora');
    // `t` é identidade neste mock — o rótulo vem das chaves i18n de recurso/ação.
    expect(screen.getByText('admin.access.group.cells.resource.worker · admin.access.group.cells.action.read')).toBeInTheDocument();
  });

  it('linha de PESSOA mostra o e-mail de quem saiu do grupo (sem display_name)', async () => {
    postura('read');
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    expect(await screen.findByText('maria@enlite.health')).toBeInTheDocument();
  });

  it('buscar repassa os filtros de grupo, tipo e limite', async () => {
    postura('read');
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    await screen.findAllByText('Ana Gestora');
    await userEvent.selectOptions(screen.getByLabelText('admin.access.history.group'), GRUPO.id);
    await userEvent.selectOptions(screen.getByLabelText('admin.access.history.typeLabel'), 'member');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.history.search' }));
    await waitFor(() => expect(api.queryHistory).toHaveBeenLastCalledWith({ groupId: GRUPO.id, type: 'member', limit: 100 }));
  });

  it('falha ao consultar → loadError; vazio → empty', async () => {
    postura('read');
    api.queryHistory.mockReset().mockRejectedValue(new Error('x'));
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.history.loadError');
    api.queryHistory.mockReset().mockResolvedValue([]);
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    expect(await screen.findByText('admin.access.history.empty')).toBeInTheDocument();
  });

  it('lex C1 — a tabela carrega `data-clarity-mask` (nome/e-mail de pessoa)', async () => {
    postura('read');
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    await screen.findAllByText('Ana Gestora');
    expect(document.querySelector('table[data-clarity-mask="True"]')).not.toBeNull();
  });

  it('🔴 nenhuma coluna de uid, país ou id de recurso — só as seis colunas da spec', async () => {
    postura('read');
    renderRota(<PermissionHistoryPage />, '/admin/access/audit');
    await screen.findAllByText('Ana Gestora');
    const cabecalhos = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(cabecalhos).toEqual([
      'admin.access.history.type',
      'admin.access.history.when',
      'admin.access.history.who',
      'admin.access.history.groupCol',
      'admin.access.history.actionCol',
      'admin.access.history.detail',
    ]);
  });
});
