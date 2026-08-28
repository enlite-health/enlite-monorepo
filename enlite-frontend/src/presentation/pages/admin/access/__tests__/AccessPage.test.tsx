import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccessPage } from '../AccessPage';
import { postura, renderRota, GRUPO } from './helpers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/components/ui/skeletons', () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = { listGroups: vi.fn(), createGroup: vi.fn() };
vi.mock('@infrastructure/http/AdminPermissionsApiService', () => ({
  AdminPermissionsApiService: {
    listGroups: (...a: unknown[]) => api.listGroups(...a),
    createGroup: (...a: unknown[]) => api.createGroup(...a),
  },
}));

describe('AccessPage — as três posturas', () => {
  beforeEach(() => {
    api.listGroups.mockReset().mockResolvedValue([GRUPO]);
    api.createGroup.mockReset();
  });

  it('🔴 hidden: o painel NÃO existe — redireciona para a home admin e não chama a API', async () => {
    postura('hidden');
    renderRota(<AccessPage />, '/admin/access');
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    expect(screen.queryByText('admin.access.title')).not.toBeInTheDocument();
    expect(api.listGroups).not.toHaveBeenCalled();
  });

  it('contrato carregando: diz que carrega, sem painel e sem API', () => {
    postura('loading');
    renderRota(<AccessPage />, '/admin/access');
    expect(screen.getByText('admin.access.loading')).toBeInTheDocument();
    expect(api.listGroups).not.toHaveBeenCalled();
  });

  it('🔴 contrato em erro: diz que falhou — não mostra o painel como se fosse "sem grupo"', () => {
    postura('error');
    renderRota(<AccessPage />, '/admin/access');
    expect(screen.getByRole('alert')).toHaveTextContent('admin.access.authzError');
    expect(screen.queryByText('admin.access.groups.title')).not.toBeInTheDocument();
  });

  it('read: lista os grupos, avisa "só leitura", e o botão "Novo grupo" NÃO existe', async () => {
    postura('read');
    renderRota(<AccessPage />, '/admin/access');
    expect(await screen.findByText('Recrutadores AR')).toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'admin.access.groups.new' })).not.toBeInTheDocument();
  });

  it('write: "Novo grupo" existe, abre o formulário, cria e navega para o grupo', async () => {
    postura('write');
    api.createGroup.mockResolvedValue({ groupId: GRUPO.id });
    renderRota(<AccessPage />, '/admin/access');
    await screen.findByText('Recrutadores AR');
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.new' }));
    await userEvent.type(screen.getByLabelText('admin.access.groups.name'), 'Novo');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.create' }));
    await waitFor(() => expect(api.createGroup).toHaveBeenCalledWith({ name: 'Novo', description: null }));
  });

  it('"incluir arquivados" re-consulta a API com o flag', async () => {
    postura('read');
    renderRota(<AccessPage />, '/admin/access');
    await screen.findByText('Recrutadores AR');
    await userEvent.click(screen.getByLabelText('admin.access.groups.includeArchived'));
    await waitFor(() => expect(api.listGroups).toHaveBeenLastCalledWith(true));
  });
});

describe('AccessPage — ramos de erro e vazio', () => {
  beforeEach(() => { api.listGroups.mockReset(); api.createGroup.mockReset(); });

  it('falha ao listar → alerta com a chave de loadError', async () => {
    postura('read');
    api.listGroups.mockRejectedValue(new Error('rede'));
    renderRota(<AccessPage />, '/admin/access');
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.groups.loadError');
  });

  it('lista vazia mostra o estado vazio', async () => {
    postura('read');
    api.listGroups.mockResolvedValue([]);
    renderRota(<AccessPage />, '/admin/access');
    expect(await screen.findByText('admin.access.groups.empty')).toBeInTheDocument();
  });

  it('write: cancelar fecha o formulário; criar com erro mostra a chave; nome vazio não chama a API', async () => {
    postura('write');
    api.listGroups.mockResolvedValue([GRUPO]);
    const { ApiError } = await import('@infrastructure/http/ApiError');
    api.createGroup.mockRejectedValue(new ApiError({ success: false, error: 'x', code: 'duplicate_name' }, 409));
    renderRota(<AccessPage />, '/admin/access');
    await screen.findByText('Recrutadores AR');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.new' }));
    expect(screen.getByTestId('create-group-form')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.create' }));
    expect(api.createGroup).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('admin.access.groups.name'), 'Dup');
    await userEvent.type(screen.getByLabelText('admin.access.groups.description'), 'desc');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.group.duplicateName');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.cancel' }));
    expect(screen.queryByTestId('create-group-form')).not.toBeInTheDocument();
  });

  it('"Abrir" navega para o detalhe do grupo', async () => {
    postura('read');
    api.listGroups.mockResolvedValue([GRUPO]);
    renderRota(<AccessPage />, '/admin/access');
    await screen.findByText('Recrutadores AR');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.open' }));
    expect(await screen.findByTestId('group-detail-route')).toBeInTheDocument();
  });
});

describe('AccessPage — rótulos de sistema/arquivado e nome só com espaços', () => {
  it('grupo de sistema e arquivado sem países mostra os rótulos e o travessão', async () => {
    postura('read');
    api.listGroups.mockReset().mockResolvedValue([{ ...GRUPO, isSystem: true, archivedAt: '2026-08-01T00:00:00Z', countries: [] }]);
    renderRota(<AccessPage />, '/admin/access');
    expect(await screen.findByText(/admin\.access\.groups\.system/)).toBeInTheDocument();
    expect(screen.getByText(/admin\.access\.groups\.archived/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('write: nome só com espaços não cria', async () => {
    postura('write');
    api.listGroups.mockReset().mockResolvedValue([GRUPO]);
    api.createGroup.mockReset();
    renderRota(<AccessPage />, '/admin/access');
    await screen.findByText('Recrutadores AR');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.new' }));
    await userEvent.type(screen.getByLabelText('admin.access.groups.name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.create' }));
    expect(api.createGroup).not.toHaveBeenCalled();
  });
});
