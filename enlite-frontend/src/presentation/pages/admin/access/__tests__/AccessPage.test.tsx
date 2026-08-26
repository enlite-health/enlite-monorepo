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
