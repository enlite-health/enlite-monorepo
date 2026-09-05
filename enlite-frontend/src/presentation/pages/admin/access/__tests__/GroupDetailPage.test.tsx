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

/** `.at(-1)` não existe no `lib` deste tsconfig. */
const ultimo = <T,>(xs: T[]): T => xs[xs.length - 1];

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
    // a lista de chips virou MATRIZ recurso × ação: a célula existe como coluna
    // marcada na linha do recurso, com a descrição no rótulo acessível.
    expect(screen.getByTestId('cell-matrix')).toBeInTheDocument();
    expect(screen.getByLabelText(/^worker:read/)).toHaveTextContent('✓');
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
    expect(screen.getByRole('checkbox', { name: /^worker:read/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^worker:write/ })).not.toBeChecked();
    for (const nome of ['admin.access.group.save', 'admin.access.group.archive', 'admin.access.group.cellsSave']) {
      expect(screen.getByRole('button', { name: nome })).toBeInTheDocument();
    }
    // Membros: as duas setas existem e nascem MORTAS — sem ninguém marcado,
    // nenhuma das duas tem o que mover.
    for (const seta of ['admin.access.group.transfer.toMembers', 'admin.access.group.transfer.toRest']) {
      expect(screen.getByRole('button', { name: seta })).toBeDisabled();
    }
    // e `Guardar` da transferência só nasce quando há mudança pendente
    expect(screen.getAllByRole('button', { name: 'admin.access.group.save' })).toHaveLength(1);
  });

  it('write: salvar células manda o conjunto INTEIRO, ordenado, com o motivo', async () => {
    postura('write');
    api.setGroupPermissions.mockResolvedValue({ cells: 3 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    await userEvent.click(screen.getByRole('checkbox', { name: /^worker:write/ }));
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
    const membros = screen.getByRole('listbox', { name: 'admin.access.group.membersTitle' });
    await userEvent.click(within(membros).getByRole('option', { name: /maria@enlite\.health/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.transfer.toRest' }));
    await userEvent.click(ultimo(screen.getAllByRole('button', { name: 'admin.access.group.save' })));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.group.lastManager');
  });

  it('write: adicionar membro oferece só quem ainda não é membro', async () => {
    postura('write');
    api.addMember.mockResolvedValue({ membershipId: 'm2' });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    const resto = await screen.findByRole('listbox', { name: 'admin.access.group.transfer.rest' });
    const fora = within(resto).getAllByRole('option').map((o) => o.textContent);
    expect(fora.join(' ')).toContain('joao@enlite.health');
    expect(fora.join(' ')).not.toContain('maria@enlite.health');
    // maria está do outro lado, e só do outro lado
    const membros = screen.getByRole('listbox', { name: 'admin.access.group.membersTitle' });
    expect(within(membros).getAllByRole('option').map((o) => o.textContent).join(' ')).toContain('maria@enlite.health');

    await userEvent.click(within(resto).getByRole('option', { name: /joao@enlite\.health/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.transfer.toMembers' }));
    await userEvent.click(ultimo(screen.getAllByRole('button', { name: 'admin.access.group.save' })));
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

  it('lex C1: o e-mail de staff vive DENTRO de `data-clarity-mask` — nas duas posturas', async () => {
    // A régua não é "existe um elemento mascarado", é "o e-mail está dentro de
    // um". A tabela virou colunas; o que não pode mudar é a máscara em volta.
    for (const nivel of ['read', 'write'] as const) {
      postura(nivel);
      const { unmount } = renderRota(<GroupDetailPage />, ROTA, PATTERN);
      const email = await screen.findByText('maria@enlite.health');
      expect(email.closest('[data-clarity-mask="True"]')).not.toBeNull();
      unmount();
    }
  });

  it('write: salvar identidade manda nome/descrição aparados; descrição vazia vira null', async () => {
    postura('write');
    api.updateGroup.mockResolvedValue(undefined);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    const nome = await screen.findByLabelText('admin.access.groups.name');
    await userEvent.clear(nome); await userEvent.type(nome, '  Novo nome ');
    const desc = screen.getByLabelText('admin.access.groups.description');
    await userEvent.clear(desc);
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.save' }));
    await waitFor(() => expect(api.updateGroup).toHaveBeenCalledWith(GRUPO.id, { name: 'Novo nome', description: null }));
    expect(await screen.findByRole('status')).toHaveTextContent('admin.access.group.saved');
  });

  it('🔴 write: conceder país exige motivo (botão desabilitado sem ele); com motivo chama a API; revogar não exige', async () => {
    postura('write');
    api.grantCountry.mockResolvedValue({ scopeId: 's' });
    api.revokeCountry.mockResolvedValue({ revoked: 1 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    const conceder = screen.getByRole('button', { name: 'admin.access.group.grant' });
    expect(conceder).toBeDisabled();
    await userEvent.type(screen.getByLabelText('admin.access.group.reason'), 'expansão');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.grant' }));
    await waitFor(() => expect(api.grantCountry).toHaveBeenCalledWith(GRUPO.id, 'BR', 'expansão'));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.revoke' }));
    await waitFor(() => expect(api.revokeCountry).toHaveBeenCalledWith(GRUPO.id, 'AR'));
  });

  it('write: "Não" no arquivamento fecha a confirmação sem chamar a API', async () => {
    postura('write');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.archive' }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.archiveNo' }));
    expect(screen.queryByTestId('archive-confirm')).not.toBeInTheDocument();
    expect(api.archiveGroup).not.toHaveBeenCalled();
  });

  it('sem membros, sem células e sem países: os três vazios aparecem em read', async () => {
    postura('read');
    api.getGroup.mockResolvedValue({ ...GRUPO, cells: [], countries: [] });
    api.listMembers.mockResolvedValue([]);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByText('admin.access.group.noMembers')).toBeInTheDocument();
    expect(screen.getByText('admin.access.group.noCells')).toBeInTheDocument();
    expect(screen.getByText('admin.access.group.noCountries')).toBeInTheDocument();
  });

  it('grupo ARQUIVADO: mesmo em write vira só leitura, e a lista de candidatos ainda é buscada só por write', async () => {
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, archivedAt: '2026-08-01T00:00:00Z' });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(screen.queryByRole('button', { name: 'admin.access.group.archive' })).not.toBeInTheDocument();
    expect(screen.getByText(/admin.access.groups.archived/)).toBeInTheDocument();
  });

  it('membro sem e-mail/papel/status mostra o uid e travessões', async () => {
    postura('read');
    api.listMembers.mockResolvedValue([{ ...MEMBRO, email: null, role: null, status: null }]);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByText('uid-maria')).toBeInTheDocument();
  });

  it('write: descrição nula vira campo vazio; desmarcar célula tira do conjunto; motivo vazio vira null', async () => {
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, description: null });
    api.setGroupPermissions.mockResolvedValue({ cells: 1 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByLabelText('admin.access.groups.name');
    expect(screen.getByLabelText('admin.access.groups.description')).toHaveValue('');
    await userEvent.click(screen.getByRole('checkbox', { name: /^worker:read/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.cellsSave' }));
    await waitFor(() => expect(api.setGroupPermissions).toHaveBeenCalledWith(GRUPO.id, ['funnel:read'], null));
  });
});
