import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupDetailPage } from '../GroupDetailPage';
import { ApiError } from '@infrastructure/http/ApiError';
import { postura, renderRota, GRUPO, MEMBRO, CATALOGO } from './helpers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = {
  getGroup: vi.fn(), listMembers: vi.fn(), getCatalog: vi.fn(), updateGroup: vi.fn(), archiveGroup: vi.fn(),
  setGroupPermissions: vi.fn(), grantCountry: vi.fn(), revokeCountry: vi.fn(), addMember: vi.fn(), removeMember: vi.fn(),
};
vi.mock('@infrastructure/http/AdminPermissionsApiService', () => ({
  AdminPermissionsApiService: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, ReturnType<typeof vi.fn>>)[k](...a) }),
}));
const listAdmins = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({ AdminApiService: { listAdmins: (...a: unknown[]) => listAdmins(...a) } }));

const ROTA = `/admin/access/groups/${GRUPO.id}`;
const PATTERN = '/admin/access/groups/:id';

describe('GroupDetailPage — a regra por componente', () => {
  beforeEach(() => {
    for (const f of Object.values(api)) f.mockReset();
    api.getGroup.mockResolvedValue(GRUPO);
    api.listMembers.mockResolvedValue([MEMBRO]);
    api.getCatalog.mockResolvedValue(CATALOGO);
    listAdmins.mockReset().mockResolvedValue({ admins: [
      { firebaseUid: 'uid-maria', email: 'maria@enlite.health' },
      { firebaseUid: 'uid-joao', email: 'joao@enlite.health' },
    ], total: 2 });
  });

  it('🔴 hidden: nem carrega o grupo — redireciona', async () => {
    postura('hidden');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    expect(api.getGroup).not.toHaveBeenCalled();
  });

  it('read: campos são TEXTO (sem input), células são lista, e NENHUM botão de conclusão existe', async () => {
    postura('read');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('cells-readonly')).toHaveTextContent('worker:read');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    for (const nome of ['admin.access.group.save', 'admin.access.group.archive', 'admin.access.group.cellsSave',
      'admin.access.group.addMember', 'admin.access.group.remove', 'admin.access.group.grant', 'admin.access.group.revoke']) {
      expect(screen.queryByRole('button', { name: nome })).not.toBeInTheDocument();
    }
    // e a lista de candidatos a membro nem foi buscada
    expect(listAdmins).not.toHaveBeenCalled();
    // o membro aparece (leitura), com e-mail
    expect(screen.getByText('maria@enlite.health')).toBeInTheDocument();
  });

  it('write: inputs montados, checkboxes por célula, e cada ação de conclusão existe', async () => {
    postura('write');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByLabelText('admin.access.groups.name')).toHaveValue('Recrutadores AR');
    expect(screen.getByRole('checkbox', { name: 'worker:read' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'worker:write' })).not.toBeChecked();
    for (const nome of ['admin.access.group.save', 'admin.access.group.archive', 'admin.access.group.cellsSave', 'admin.access.group.addMember']) {
      expect(screen.getByRole('button', { name: nome })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'admin.access.group.remove' })).toBeInTheDocument();
  });

  it('write: salvar células manda o conjunto INTEIRO, ordenado, com o motivo', async () => {
    postura('write');
    api.setGroupPermissions.mockResolvedValue({ cells: 3 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    await userEvent.click(screen.getByRole('checkbox', { name: 'worker:write' }));
    await userEvent.type(screen.getByLabelText('admin.access.group.reason'), 'onboarding');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.cellsSave' }));
    await waitFor(() => expect(api.setGroupPermissions).toHaveBeenCalledWith(GRUPO.id, ['funnel:read', 'worker:read', 'worker:write'], 'onboarding'));
  });

  it('write: arquivar pede confirmação, e só então chama a API e volta à lista', async () => {
    postura('write');
    api.archiveGroup.mockResolvedValue({ affectedMembers: 1 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.archive' }));
    expect(api.archiveGroup).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByTestId('archive-confirm')).getByRole('button', { name: 'admin.access.group.archiveYes' }));
    await waitFor(() => expect(api.archiveGroup).toHaveBeenCalledWith(GRUPO.id));
    expect(await screen.findByTestId('access-home')).toBeInTheDocument();
  });

  it('🔴 409 last_manager vira a mensagem específica — não um erro genérico', async () => {
    postura('write');
    api.removeMember.mockRejectedValue(new ApiError({ success: false, error: 'x', code: 'last_manager' }, 409));
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.group.lastManager');
  });

  it('write: adicionar membro oferece só quem ainda não é membro', async () => {
    postura('write');
    api.addMember.mockResolvedValue({ membershipId: 'm2' });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    const select = await screen.findByLabelText('admin.access.group.pickUser');
    const opcoes = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(opcoes).toContain('joao@enlite.health');
    expect(opcoes).not.toContain('maria@enlite.health');
    await userEvent.selectOptions(select, 'uid-joao');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.addMember' }));
    await waitFor(() => expect(api.addMember).toHaveBeenCalledWith(GRUPO.id, 'uid-joao'));
  });

  it('grupo de SISTEMA: mesmo em write, nome/descrição são texto e não há arquivar', async () => {
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, isSystem: true });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(screen.queryByRole('button', { name: 'admin.access.group.archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'admin.access.group.save' })).not.toBeInTheDocument();
  });

  it('404: diz que não achou e oferece voltar', async () => {
    postura('read');
    api.getGroup.mockRejectedValue(new ApiError({ success: false, error: 'Not found' }, 404));
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.group.notFound');
  });

  it('lex C1: a tabela de membros carrega `data-clarity-mask` — e-mail de staff não vai ao Clarity', async () => {
    postura('read');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByText('maria@enlite.health');
    expect(document.querySelector('table[data-clarity-mask="True"]')).not.toBeNull();
  });
});
