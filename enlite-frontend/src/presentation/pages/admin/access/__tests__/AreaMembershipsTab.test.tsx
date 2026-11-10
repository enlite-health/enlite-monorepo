import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AreaMembershipsTab } from '../AreaMembershipsTab';
import { ApiError } from '@infrastructure/http/ApiError';
import { cells, pagina, ANA, BETO, CUENTA, MID_ANA, PID_ANA } from './areaMembershipsFixtures';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = { list: vi.fn(), byEmail: vi.fn(), grant: vi.fn(), revoke: vi.fn() };
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listAreaPeople: (...a: unknown[]) => api.list(...a),
    findAreaPersonByEmail: (...a: unknown[]) => api.byEmail(...a),
    grantAreaMembership: (...a: unknown[]) => api.grant(...a),
    revokeAreaMembership: (...a: unknown[]) => api.revoke(...a),
  },
}));

const K = 'admin.access.areaMemberships';
const WRITE = ['area_membership:read', 'area_membership:write'];

const mount = () => render(<MemoryRouter><AreaMembershipsTab /></MemoryRouter>);

/** Combobox da casa: abre o gatilho (achado pelo rótulo) e clica na opção pelo nome. */
async function pick(label: string, option: string): Promise<void> {
  await userEvent.click(screen.getByLabelText(label));
  await userEvent.click(within(screen.getByRole('option', { name: option })).getByRole('button'));
}

async function openDrawer(): Promise<HTMLElement> {
  await userEvent.click((await screen.findAllByRole('button', { name: `${K}.manageAria` }))[0]);
  return screen.findByTestId('area-person-drawer');
}

describe('AreaMembershipsTab — lista, paginação e filtros', () => {
  beforeEach(() => {
    cells(WRITE);
    api.list.mockReset().mockResolvedValue(pagina([ANA, BETO], 45));
    api.byEmail.mockReset();
    api.grant.mockReset().mockResolvedValue({});
    api.revoke.mockReset().mockResolvedValue({});
  });

  it('lista as pessoas com tipo e chips; quem não tem vínculo mostra travessão; 1ª chamada é página 1 de 20', async () => {
    mount();
    expect(await screen.findByText('Ana Ejemplo')).toBeInTheDocument();
    const rows = screen.getAllByTestId('area-person-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId('area-person-kind')).toHaveAttribute('data-kind', 'worker');
    expect(within(rows[0]).getByTestId('area-membership-chip')).toHaveTextContent('areas.names.care · admin.access.areaMemberships.roles.family');
    expect(within(rows[1]).queryByTestId('area-membership-chip')).not.toBeInTheDocument();
    expect(within(rows[1]).getByText('—')).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ type: 'all', limit: 20, offset: 0, search: undefined, withMembership: undefined }));
  });

  it('paginação: próxima vai ao offset 20, anterior volta; na 1ª página "anterior" está desabilitado', async () => {
    mount();
    await screen.findByText('Ana Ejemplo');
    expect(screen.getByRole('button', { name: 'common.previousPage' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'common.nextPage' }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 20 })));
    await userEvent.click(await screen.findByRole('button', { name: 'common.previousPage' }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
  });

  it('trocar o tamanho da página volta para a página 1 com o novo limite', async () => {
    mount();
    await screen.findByText('Ana Ejemplo');
    await userEvent.click(screen.getByRole('button', { name: 'common.nextPage' }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })));
    await userEvent.selectOptions(within(screen.getByTestId('pagination')).getByRole('combobox'), '50');
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50, offset: 0 })));
  });

  it('filtro de tipo e "Solo con vínculo" vão ao servidor e voltam à página 1', async () => {
    mount();
    await screen.findByText('Ana Ejemplo');
    await userEvent.click(screen.getByRole('button', { name: 'common.nextPage' }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })));
    await pick(`${K}.toolbar.type`, `${K}.kinds.worker`);
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'worker', offset: 0 })));
    const only = screen.getByTestId('area-people-only-with');
    expect(only).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(only);
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'worker', withMembership: true })));
    expect(screen.getByTestId('area-people-only-with')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(`${K}.auditLabel`)).toBeInTheDocument();
  });

  it('busca: com 1-2 caracteres NÃO chama o servidor e mostra a dica; com 3+ chama, depois da espera', async () => {
    mount();
    await screen.findByText('Ana Ejemplo');
    api.list.mockClear();
    await userEvent.type(screen.getByLabelText(`${K}.toolbar.search`), 'an');
    expect(screen.getByTestId('area-people-min-chars')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 450));
    expect(api.list.mock.calls.every(([q]) => !q.search)).toBe(true);
    await userEvent.type(screen.getByLabelText(`${K}.toolbar.search`), 'a');
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'ana', offset: 0 })));
    expect(screen.queryByTestId('area-people-min-chars')).not.toBeInTheDocument();
  });

  it('vazio com busca nomeia o termo e oferece o e-mail exato; vazio sem busca diz "sem pessoas com estes filtros"', async () => {
    api.list.mockResolvedValue(pagina([], 0));
    mount();
    expect(await screen.findByText(`${K}.emptyFilters`)).toBeInTheDocument();
    expect(screen.getByTestId('area-lookup-open')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(`${K}.toolbar.search`), 'zzqx');
    expect(await screen.findByText(`${K}.emptySearch`)).toBeInTheDocument();
  });

  it('erro ao carregar: alerta + "Reintentar" (a barra de filtros fica desabilitada) e a recarga mostra a lista', async () => {
    api.list.mockRejectedValueOnce(new Error('rede'));
    mount();
    expect(await screen.findByTestId('area-people-error')).toHaveTextContent(`${K}.errors.load`);
    expect(screen.getByLabelText(`${K}.toolbar.search`)).toBeDisabled();
    await userEvent.click(screen.getByTestId('area-people-retry'));
    expect(await screen.findByText('Ana Ejemplo')).toBeInTheDocument();
    expect(screen.getByLabelText(`${K}.toolbar.search`)).toBeEnabled();
  });

  it('carregando: esqueleto com role=status e barra desabilitada, sem tabela', async () => {
    api.list.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByTestId('area-people-skeleton')).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText(`${K}.toolbar.search`)).toBeDisabled();
    expect(screen.queryByTestId('area-people-table')).not.toBeInTheDocument();
  });
});

describe('AreaMembershipsTab — painel "Gestionar" (conceder e revogar)', () => {
  beforeEach(() => {
    cells(WRITE);
    api.list.mockReset().mockImplementation(async (q: { search?: string }) => (q.search ? pagina([ANA]) : pagina([ANA, BETO])));
    api.byEmail.mockReset();
    api.grant.mockReset().mockResolvedValue({});
    api.revoke.mockReset().mockResolvedValue({});
  });

  it('abre o painel com a pessoa e os vínculos vivos; Esc e o botão fecham', async () => {
    mount();
    const drawer = await openDrawer();
    expect(within(drawer).getByText('Ana Ejemplo')).toBeInTheDocument();
    expect(within(drawer).getAllByTestId('area-drawer-membership')).toHaveLength(1);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('area-person-drawer')).not.toBeInTheDocument();
    await openDrawer();
    await userEvent.click(screen.getByTestId('area-drawer-close'));
    expect(screen.queryByTestId('area-person-drawer')).not.toBeInTheDocument();
  });

  it('🔴 revogar: o motivo é obrigatório (confirmar desabilitado até digitar); envia o motivo sem espaços e some da lista', async () => {
    mount();
    const drawer = await openDrawer();
    await userEvent.click(within(drawer).getByTestId('area-drawer-revoke'));
    const confirm = within(drawer).getByTestId('area-revoke-confirm');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(drawer).getByTestId('area-revoke-reason'), '   ');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(drawer).getByTestId('area-revoke-reason'), ' pedido do gestor ');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith(MID_ANA, 'pedido do gestor'));
    expect(await screen.findByTestId('area-toast')).toHaveTextContent(`${K}.toast.revoked`);
    expect(within(screen.getByTestId('area-person-drawer')).getByTestId('area-drawer-none')).toBeInTheDocument();
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(1)); // a lista recarregou por trás
  });

  it('revogar vínculo que já estava revogado (404) mostra a mensagem própria e mantém o formulário', async () => {
    api.revoke.mockRejectedValue(new ApiError({ success: false, error: 'gone' }, 404));
    mount();
    const drawer = await openDrawer();
    await userEvent.click(within(drawer).getByTestId('area-drawer-revoke'));
    await userEvent.type(within(drawer).getByTestId('area-revoke-reason'), 'x');
    await userEvent.click(within(drawer).getByTestId('area-revoke-confirm'));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent(`${K}.errors.revokeGone`);
  });

  it('conceder: envia personId + área + papel escolhidos, mostra o aviso e relê a pessoa (o vínculo novo aparece)', async () => {
    const updated = { ...ANA, memberships: [...ANA.memberships, { id: 'm-new', area: 'learn', role: 'teacher' }] };
    api.list.mockImplementation(async (q: { search?: string }) => (q.search ? pagina([updated]) : pagina([ANA, BETO])));
    mount();
    const drawer = await openDrawer();
    await pick(`${K}.grant.role`, `${K}.roles.teacher`);
    await userEvent.click(within(drawer).getByTestId('area-grant-submit'));
    await waitFor(() => expect(api.grant).toHaveBeenCalledWith({ personId: PID_ANA, area: 'learn', role: 'teacher' }));
    expect(await screen.findByTestId('area-toast')).toHaveTextContent(`${K}.toast.granted`);
    await waitFor(() => expect(within(screen.getByTestId('area-person-drawer')).getAllByTestId('area-drawer-membership')).toHaveLength(2));
  });

  it('🔴 duplicado: a pessoa já tem o par → mensagem no painel e NENHUMA chamada de conceder', async () => {
    mount();
    const drawer = await openDrawer();
    // a Ana já tem care · family: escolhe exatamente esse par (o padrão do formulário é learn · alumno/a)
    await pick(`${K}.grant.area`, 'areas.names.care');
    await userEvent.click(within(drawer).getByTestId('area-grant-submit'));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent(`${K}.errors.grantDuplicate`);
    expect(api.grant).not.toHaveBeenCalled();
  });

  it('422 do servidor (par inválido / duplicado que a tela não via) mostra "revisá el área y el rol"', async () => {
    api.grant.mockRejectedValue(new ApiError({ success: false, error: 'invalid' }, 422));
    mount();
    const drawer = await openDrawer();
    await pick(`${K}.grant.area`, 'areas.names.learn');
    await userEvent.click(within(drawer).getByTestId('area-grant-submit'));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent(`${K}.errors.grantRejected`);
  });

  it('falha genérica ao conceder mostra a mensagem genérica', async () => {
    api.grant.mockRejectedValue(new Error('boom'));
    mount();
    const drawer = await openDrawer();
    await pick(`${K}.grant.area`, 'areas.names.learn');
    await userEvent.click(within(drawer).getByTestId('area-grant-submit'));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent(`${K}.errors.grant`);
  });
});

describe('AreaMembershipsTab — busca por e-mail exato', () => {
  beforeEach(() => {
    cells(WRITE);
    api.list.mockReset().mockImplementation(async (q: { search?: string }) => (q.search ? pagina([]) : pagina([ANA])));
    api.byEmail.mockReset();
    api.grant.mockReset().mockResolvedValue({});
  });

  async function openLookup(): Promise<void> {
    await screen.findByText('Ana Ejemplo');
    await userEvent.click(screen.getByTestId('area-lookup-open-link'));
  }

  it('achou: mostra o cartão com tipo e "Gestionar"; conceder a quem só tem login vai por uid', async () => {
    api.byEmail.mockResolvedValue(CUENTA);
    mount();
    await openLookup();
    expect(screen.getByTestId('area-lookup-submit')).toBeDisabled();
    await userEvent.type(screen.getByLabelText(`${K}.lookup.email`), ' Algo@Ejemplo.com ');
    await userEvent.click(screen.getByTestId('area-lookup-submit'));
    const card = await screen.findByTestId('lookup-card');
    expect(api.byEmail).toHaveBeenCalledWith('algo@ejemplo.com');
    expect(within(card).getByTestId('area-person-kind')).toHaveAttribute('data-kind', 'account');
    expect(within(card).getByText(`${K}.lookup.newAccount`)).toBeInTheDocument();
    await userEvent.click(within(card).getByTestId('area-lookup-manage'));
    const drawer = await screen.findByTestId('area-person-drawer');
    await pick(`${K}.grant.area`, 'areas.names.learn');
    await userEvent.click(within(drawer).getByTestId('area-grant-submit'));
    await waitFor(() => expect(api.grant).toHaveBeenCalledWith({ uid: 'uid-cuenta', area: 'learn', role: 'learner' }));
  });

  it('não achou (404): diz que não existe conta com esse e-mail, sem cartão', async () => {
    api.byEmail.mockRejectedValue(new ApiError({ success: false, error: 'nf' }, 404));
    mount();
    await openLookup();
    await userEvent.type(screen.getByLabelText(`${K}.lookup.email`), 'nadie@ejemplo.com');
    await userEvent.click(screen.getByTestId('area-lookup-submit'));
    expect(await screen.findByTestId('lookup-none')).toHaveTextContent(`${K}.lookup.none`);
    expect(screen.queryByTestId('lookup-card')).not.toBeInTheDocument();
  });

  it('falha que não é 404 mostra erro (não finge "não existe"); digitar de novo limpa o resultado; Cancelar fecha', async () => {
    api.byEmail.mockRejectedValue(new ApiError({ success: false, error: 'x' }, 502));
    mount();
    await openLookup();
    await userEvent.type(screen.getByLabelText(`${K}.lookup.email`), 'a@ejemplo.com');
    await userEvent.click(screen.getByTestId('area-lookup-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(`${K}.lookup.error`);
    expect(screen.queryByTestId('lookup-none')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('area-lookup-close'));
    expect(screen.queryByTestId('lookup')).not.toBeInTheDocument();
  });
});

describe('AreaMembershipsTab — só leitura (`area_membership:read` sem `write`)', () => {
  beforeEach(() => {
    cells(['area_membership:read']);
    api.list.mockReset().mockResolvedValue(pagina([ANA, BETO]));
  });

  it('🔴 lista e chips aparecem, mas NÃO há "Gestionar", coluna de ação nem painel', async () => {
    mount();
    expect(await screen.findByText('Ana Ejemplo')).toBeInTheDocument();
    expect(screen.getAllByTestId('area-membership-chip')).toHaveLength(1);
    expect(screen.queryByTestId('area-person-manage')).not.toBeInTheDocument();
    expect(screen.queryByText(`${K}.columns.actions`)).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
    expect(screen.queryByTestId('area-person-drawer')).not.toBeInTheDocument();
  });
});
